/**
 * Renderer memory/CPU benchmark collector.
 *
 * Orchestrates: mem-bench-host stub + collab-web dev server + headless Chrome,
 * then samples CDP Performance metrics for DURATION_MS at SAMPLE_MS cadence.
 * Emits a JSON summary with static-load / streaming-storm / idle windows.
 *
 * Usage: bun scripts/mem-bench.ts [--out /tmp/mem-bench.json]
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COLLAB_WEB = new URL("..", import.meta.url).pathname;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const USE_DIST = Bun.env.BENCH_DIST === "1";
const DEV_PORT = 3000;
// bun's html dev server binds IPv6 loopback only; python http.server (dist)
// binds IPv4. Pick the reachable base per mode.
const BASE_URL = USE_DIST ? "http://127.0.0.1" : "http://[::1]";
const CDP_PORT = 9339;
const SAMPLE_MS = 500;
const DURATION_MS = 32_000;

interface Sample {
	t: number;
	jsHeapUsed: number;
	jsHeapTotal: number;
	nodes: number;
	documents: number;
	listeners: number;
	layoutCount: number;
	recalcStyleCount: number;
	layoutDur: number;
	recalcDur: number;
	scriptDur: number;
	taskDur: number;
}

let outArg = "/tmp/mem-bench.json";
const argv = Bun.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--out") outArg = argv[i + 1] ?? outArg;
}

// ── process helpers ──────────────────────────────────────────────────────────

function spawnOut(
	command: string,
	args: string[],
	opts: { cwd?: string; env?: Record<string, string> } = {},
): ChildProcess {
	return spawn(command, args, {
		cwd: opts.cwd,
		env: { ...process.env, ...opts.env },
		stdio: ["ignore", "pipe", "pipe"],
	});
}

async function waitForLine(child: ChildProcess, marker: string, timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		let buf = "";
		const timer = setTimeout(() => {
			child.stdout?.off("data", onData);
			reject(new Error(`timed out waiting for "${marker}"`));
		}, timeoutMs);
		const onData = (chunk: Buffer) => {
			buf += chunk.toString();
			const idx = buf.indexOf(marker);
			if (idx < 0) return;
			clearTimeout(timer);
			child.stdout?.off("data", onData);
			resolve(
				buf
					.slice(idx + marker.length)
					.split("\n")[0]
					?.trim() ?? "",
			);
		};
		child.stdout?.on("data", onData);
	});
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${BASE_URL}:${port}/`);
			if (res.ok) return;
		} catch {
			// not up yet
		}
		await Bun.sleep(200);
	}
	throw new Error(`port ${port} not ready within ${timeoutMs}ms`);
}

async function findPageTarget(port: number, timeoutMs: number): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`http://127.0.0.1:${port}/json/list`);
			const list = (await res.json()) as Array<{ type: string; webSocketDebuggerUrl?: string; url?: string }>;
			const page = list.find(t => t.type === "page" && t.webSocketDebuggerUrl && !t.url?.startsWith("devtools://"));
			if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
		} catch {
			// devtools not up yet
		}
		await Bun.sleep(200);
	}
	throw new Error(`no page target on ${port} within ${timeoutMs}ms`);
}

class Cdp {
	#ws: WebSocket;
	#seq = 0;
	#pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	ready: Promise<void>;

	constructor(url: string) {
		this.#ws = new WebSocket(url);
		this.ready = new Promise((resolve, reject) => {
			this.#ws.onopen = () => resolve();
			this.#ws.onerror = () => reject(new Error("cdp websocket error"));
		});
		this.#ws.onmessage = event => {
			const msg = JSON.parse(String(event.data)) as { id?: number; error?: { message: string }; result?: unknown };
			if (msg.id === undefined) return;
			const pending = this.#pending.get(msg.id);
			if (!pending) return;
			this.#pending.delete(msg.id);
			if (msg.error) pending.reject(new Error(msg.error.message));
			else pending.resolve(msg.result);
		};
	}

	async call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
		await this.ready;
		const id = ++this.#seq;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		this.#pending.set(id, { resolve, reject });
		this.#ws.send(JSON.stringify({ id, method, params }));
		return promise;
	}

	close(): void {
		this.#ws.close();
	}
}

// ── measurement ──────────────────────────────────────────────────────────────

interface MetricRow {
	Timestamp: number;
	Documents: number;
	Frames: number;
	JSEventListeners: number;
	Nodes: number;
	LayoutCount: number;
	RecalcStyleCount: number;
	LayoutDuration: number;
	RecalcStyleDuration: number;
	ScriptDuration: number;
	TaskDuration: number;
	JSHeapUsedSize: number;
	JSHeapTotalSize: number;
}

function rowToSample(t: number, m: MetricRow): Sample {
	return {
		t,
		jsHeapUsed: m.JSHeapUsedSize,
		jsHeapTotal: m.JSHeapTotalSize,
		nodes: m.Nodes,
		documents: m.Documents,
		listeners: m.JSEventListeners,
		layoutCount: m.LayoutCount,
		recalcStyleCount: m.RecalcStyleCount,
		layoutDur: m.LayoutDuration,
		recalcDur: m.RecalcStyleDuration,
		scriptDur: m.ScriptDuration,
		taskDur: m.TaskDuration,
	};
}

function max(samples: Sample[], field: keyof Sample): number {
	return samples.reduce((acc, s) => Math.max(acc, s[field] as number), 0);
}

function windowStats(
	samples: Sample[],
	start: number,
	end: number,
	field: keyof Sample,
): { samples: number; first: number; last: number; delta: number; peakDelta: number } {
	const inWindow = samples.filter(s => s.t >= start && s.t < end);
	if (inWindow.length === 0) return { samples: 0, first: 0, last: 0, delta: 0, peakDelta: 0 };
	const first = inWindow[0]![field] as number;
	const last = inWindow[inWindow.length - 1]![field] as number;
	let peakDelta = 0;
	let prev = first;
	for (const s of inWindow) {
		const v = s[field] as number;
		peakDelta = Math.max(peakDelta, v - prev);
		prev = v;
	}
	return { samples: inWindow.length, first, last, delta: last - first, peakDelta };
}

// ── main ─────────────────────────────────────────────────────────────────────

const tmpDir = mkdtempSync(join(tmpdir(), "mem-bench-"));
const procs: ChildProcess[] = [];
const cdpSock: Cdp[] = [];

function cleanup(): void {
	for (const c of cdpSock) c.close();
	for (const p of procs) {
		try {
			p.kill("SIGKILL");
		} catch {
			// already gone
		}
	}
	rmSync(tmpDir, { recursive: true, force: true });
}

process.on("SIGINT", () => {
	cleanup();
	process.exit(130);
});

try {
	// 1. dev server (if not already up); dist mode serves ./dist via python.
	try {
		await waitForPort(DEV_PORT, 1500);
		console.log("server already up on", DEV_PORT);
	} catch {
		const dev = USE_DIST
			? spawnOut("python3", ["-m", "http.server", String(DEV_PORT), "--directory", "dist"], { cwd: COLLAB_WEB })
			: spawnOut("bun", ["./index.html"], { cwd: COLLAB_WEB });
		procs.push(dev);
		await waitForPort(DEV_PORT, 20_000);
		console.log("server up on", DEV_PORT, USE_DIST ? "(dist)" : "(dev)");
	}

	// 2. benchmark host.
	const host = spawnOut("bun", ["scripts/mem-bench-host.ts"], {
		cwd: COLLAB_WEB,
		env: { BENCH_PORT: "7488" },
	});
	procs.push(host);
	const link = await waitForLine(host, "join link:", 15_000);
	console.log("host link:", link);

	// 3. headless Chrome on the deep link.
	const chrome = spawnOut(
		CHROME,
		[
			"--headless",
			`--remote-debugging-port=${CDP_PORT}`,
			`--user-data-dir=${tmpDir}/chrome`,
			"--no-first-run",
			"--disable-default-apps",
			"--disable-extensions",
			"--disable-background-networking",
			"--disable-gpu",
			"--window-size=1440,900",
			`${BASE_URL}:${DEV_PORT}/#${link}`,
		],
		{},
	);
	procs.push(chrome);

	const wsUrl = await findPageTarget(CDP_PORT, 20_000);
	const cdp = new Cdp(wsUrl);
	cdpSock.push(cdp);
	await cdp.call("Performance.enable");

	// 4. sample.
	const samples: Sample[] = [];
	const t0 = Date.now();
	while (Date.now() - t0 < DURATION_MS) {
		const before = Date.now();
		const [perf, heap] = (await Promise.all([
			cdp.call("Performance.getMetrics"),
			cdp.call("Runtime.getHeapUsage"),
		])) as [unknown, { usedSize?: number; totalSize?: number }];
		const metrics = (perf as { metrics: Array<{ name: string; value: number }> }).metrics;
		const row = {} as Record<string, number>;
		for (const m of metrics) row[m.name] = m.value;
		const s = rowToSample(Date.now() - t0, row as unknown as MetricRow);
		s.jsHeapUsed = heap.usedSize ?? 0;
		s.jsHeapTotal = heap.totalSize ?? 0;
		samples.push(s);
		await Bun.sleep(Math.max(0, SAMPLE_MS - (Date.now() - before)));
	}

	// 5. summarize. Total-delta figures over the whole run: the storm start
	// drifts with Chrome cold-start cost, so fixed windows are unreliable.
	const mb = (bytes: number) => bytes / (1024 * 1024);
	const at = (tMs: number) => samples.find(s => s.t >= tMs) ?? samples[samples.length - 1];
	const beforeStorm = at(2000);
	const base = samples[0] ?? ({} as Sample);
	const last = samples[samples.length - 1] ?? base;
	const summary = {
		entries: Number(Bun.env.BENCH_ENTRIES ?? 400),
		storm: { startMs: 2500, endMs: 2500 + Number(Bun.env.BENCH_STREAM_MS ?? 2500) },
		baseline: rowToSample(0, base as unknown as MetricRow),
		staticLoad: {
			heapUsedMB: mb(beforeStorm?.jsHeapUsed ?? 0),
			nodes: beforeStorm?.nodes ?? 0,
			documents: beforeStorm?.documents ?? 0,
			listeners: beforeStorm?.listeners ?? 0,
		},
		stream: {
			layoutTotal: max(samples, "layoutCount"),
			recalcTotal: max(samples, "recalcStyleCount"),
			scriptTotalDeltaMs: (last.scriptDur - base.scriptDur) * 1000,
			heapUsedPeakMB: mb(max(samples, "jsHeapUsed")),
			scriptDurMs: windowStats(samples, 2500, last.t + 1, "scriptDur"),
		},
		idle: {
			taskDurMs: windowStats(samples, 8000, samples[samples.length - 1]?.t ?? 8000, "taskDur"),
			scriptDurMs: windowStats(samples, 8000, samples[samples.length - 1]?.t ?? 8000, "scriptDur"),
			heapUsedDeltaMB: mb(windowStats(samples, 8000, samples[samples.length - 1]?.t ?? 8000, "jsHeapUsed").delta),
			nodesDelta: windowStats(samples, 8000, samples[samples.length - 1]?.t ?? 8000, "nodes").delta,
		},
		windowedRowsAfterStorm: -1,
		samples,
	};
	// 6. windowed-row probe: after the storm settles, the transcript must
	// have folded back to the tail window (~WINDOW_INITIAL rows), not the
	// full history.
	let rowCount = -1;
	try {
		const rowsRes = (await cdp.call("Runtime.evaluate", {
			expression: "document.querySelectorAll('.tr-row').length",
			returnByValue: true,
		})) as { result?: { value?: number } };
		rowCount = rowsRes.result?.value ?? -1;
	} catch {
		// probe is best-effort
	}
	summary.windowedRowsAfterStorm = rowCount;

	Bun.write(outArg, JSON.stringify(summary, null, 2));
	console.log(`wrote ${outArg} (${samples.length} samples)`);
	console.log(JSON.stringify({ ...summary, samples: undefined }, null, 2));
} finally {
	cleanup();
}
