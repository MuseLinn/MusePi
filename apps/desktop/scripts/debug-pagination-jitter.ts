#!/usr/bin/env bun
/**
 * Temporary diagnostic for the pagination jitter. Driver-side polling (CDP
 * Runtime.evaluate is not throttled in a hidden Electron window, unlike
 * setInterval): every POLL_MS it reads virtualization metrics and re-asserts
 * the shadow scrollTop writer on the current scroller; every WHEEL_EVERY
 * ticks it sends one trustworthy CDP mouseWheel notch. Dumps everything to
 * pagination-jitter-log.json next to this script.
 *
 * Usage: bun scripts/debug-pagination-jitter.ts <session-search-text> [ticks]
 * Env: MUSEPI_CDP_PORT (default 9225)
 */
const PORT = process.env.MUSEPI_CDP_PORT ?? "9225";
const SEARCH = process.argv[2] ?? "启动system-prompt";
const TICKS = Number(process.argv[3] ?? 300);
const POLL_MS = 250;
const WHEEL_EVERY = Number(process.env.MUSEPI_WHEEL_EVERY ?? 6);
const DIR = import.meta.dir;
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

const openJs = await Bun.file(`${DIR}/debug-pagination-jitter.open.js`).text();
const instrumentJs = await Bun.file(`${DIR}/debug-pagination-jitter.instrument.js`).text();
const tickJs = await Bun.file(`${DIR}/debug-pagination-jitter.tick.js`).text();

async function findTarget() {
	for (let i = 0; i < 40; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${PORT}/json`);
			const targets = (await res.json()) as Array<{
				type: string;
				title: string;
				url: string;
				webSocketDebuggerUrl: string;
				id: string;
			}>;
			const page = targets.find(t => t.type === "page" && t.title === "MusePi" && t.url.includes("index.html"));
			if (page) return page;
		} catch {}
		await sleep(500);
	}
	throw new Error("no renderer");
}

let target = await findTarget();
let ws: WebSocket;
/** Errors collected across reconnects (the handler is re-registered per ws). */
const pageErrors: string[] = [];
function handleEvent(msg: { method?: string; params?: unknown }): void {
	if (msg.method === "Runtime.exceptionThrown") {
		const p = msg.params as { exceptionDetails?: { exception?: { description?: string }; text?: string } };
		pageErrors.push(
			p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? JSON.stringify(p).slice(0, 400),
		);
	} else if (msg.method === "Runtime.consoleAPICalled") {
		const p = msg.params as { type?: string; args?: { value?: unknown }[] };
		if (p.type === "error") pageErrors.push(String(p.args?.map(a => a.value).join(" ")).slice(0, 400));
	}
}

async function connect(t: { webSocketDebuggerUrl: string }): Promise<void> {
	ws = new WebSocket(t.webSocketDebuggerUrl);
	await new Promise<void>((res, rej) => {
		ws.onopen = () => res();
		ws.onerror = () => rej(new Error("ws"));
	});
	ws.onmessage = ev => {
		const msg = JSON.parse(String(ev.data));
		if (msg.id && pending.has(msg.id)) {
			pending.get(msg.id)?.(msg);
			pending.delete(msg.id);
			return;
		}
		if (msg.method) handleEvent(msg);
	};
	await cdp("Runtime.enable").catch(() => {});
}
let nextId = 1;
const pending = new Map<number, (v: unknown) => void>();
function cdp(method: string, params: unknown = {}): Promise<unknown> {
	const id = nextId++;
	ws.send(JSON.stringify({ id, method, params }));
	return new Promise((res, rej) => {
		pending.set(id, m =>
			(m as { error?: unknown }).error ? rej(new Error(JSON.stringify((m as { error: unknown }).error))) : res(m),
		);
		setTimeout(() => {
			if (pending.has(id)) {
				pending.delete(id);
				rej(new Error(`timeout ${method}`));
			}
		}, 15000);
	});
}
async function evaluate<T>(expression: string): Promise<T> {
	const msg = (await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as {
		result?: { result?: { value?: T }; exceptionDetails?: unknown };
	};
	if (msg.result?.exceptionDetails) throw new Error(JSON.stringify(msg.result.exceptionDetails).slice(0, 500));
	return msg.result?.result?.value as T;
}

// Session click may navigate the main window (execution context destroyed) —
// reconnect when an evaluate starts failing.
async function evaluateResilient<T>(expression: string): Promise<T | "ctx-dead"> {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			return await evaluate<T>(expression);
		} catch {
			await sleep(800);
			try {
				target = await findTarget();
				await connect(target);
				nextId = 1;
			} catch {
				/* keep trying */
			}
		}
	}
	return "ctx-dead";
}

// ── 1. open the long session ────────────────────────────────────────────────
await connect(target);
const openResult = await evaluate<string>(`(async (search) => { ${openJs} })(${JSON.stringify(SEARCH)})`);
console.log("session-open:", openResult);
if (openResult !== "clicked" && openResult !== "already-open") {
	console.log("ABORT: session not opened");
	process.exit(1);
}
await sleep(8000); // grace: snapshot + first paint

// ── 2. poll + wheel ─────────────────────────────────────────────────────────
const samples: unknown[] = [];
const size = await evaluateResilient<{ width: number; height: number }>(`({ width: innerWidth, height: innerHeight })`);
const width = typeof size === "object" ? size.width : 800;
const height = typeof size === "object" ? size.height : 600;
let deadTicks = 0;
for (let i = 0; i < TICKS; i++) {
	const inst = await evaluateResilient<string>(`(() => { ${instrumentJs} })()`);
	const s = await evaluateResilient<unknown>(`(() => { ${tickJs} })()`);
	if (s === "ctx-dead" || inst === "ctx-dead") deadTicks++;
	else if (s) samples.push(s);
	if (i % WHEEL_EVERY === WHEEL_EVERY - 1) {
		await cdp("Input.dispatchMouseEvent", {
			type: "mouseWheel",
			x: Math.round(width / 2),
			y: Math.round(height / 2),
			deltaX: 0,
			deltaY: -700,
		}).catch(() => {});
	}
	await sleep(POLL_MS);
}
if (deadTicks > 0) console.log("ctx-dead ticks:", deadTicks);

// ── 3. dump ─────────────────────────────────────────────────────────────────
const writesR = await evaluateResilient<unknown[]>(`window.__jit ? window.__jit.writes : []`);
const writes = Array.isArray(writesR) ? writesR : [];
const dump = { samples, writes };
await Bun.write(`${DIR}/pagination-jitter-log.json`, JSON.stringify(dump, null, 1));
console.log("samples:", samples.length, "writes:", writes.length, "→", `${DIR}/pagination-jitter-log.json`);
if (pageErrors.length > 0) {
	console.log("\n=== PAGE ERRORS ===");
	for (const e of pageErrors.slice(0, 10)) console.log("---", e.slice(0, 400));
}

// ── 4. analyze ──────────────────────────────────────────────────────────────
type S = { t: number; st: number; sh: number; top: number; bot: number; rows: number };
type W = { t: number; v: number; prev: number; sh: number; stack: string };
const ss = samples as S[];
const ww = writes as W[];
let collapses = 0;
for (let i = 1; i < ss.length; i++) {
	const d = ss[i]!.sh - ss[i - 1]!.sh;
	if (d < -1500) {
		collapses++;
		const near = ww.filter(w => w.t >= ss[i - 1]!.t - 400 && w.t <= ss[i]!.t + 400);
		console.log(
			`\n=== SH COLLAPSE #${collapses} at t=${ss[i]!.t} (${d}px) sh=${ss[i - 1]!.sh}→${ss[i]!.sh} st=${ss[i - 1]!.st}→${ss[i]!.st} top=${ss[i - 1]!.top}→${ss[i]!.top} rows=${ss[i - 1]!.rows}→${ss[i]!.rows}`,
		);
		for (const w of near)
			console.log(`   write t=${w.t} ${w.prev}→${w.v} (sh@write=${w.sh})\n      ${w.stack.slice(0, 280)}`);
		console.log(`   ctx: ${JSON.stringify(ss.slice(Math.max(0, i - 2), i + 3))}`);
	}
}
if (collapses === 0) console.log("\nno SH collapse >1500px detected");
for (let i = 1; i < ss.length; i++) {
	const d = ss[i]!.st - ss[i - 1]!.st;
	if (Math.abs(d) > 2500) {
		const near = ww.filter(w => w.t >= ss[i - 1]!.t - 300 && w.t <= ss[i]!.t + 300);
		console.log(`\nST JUMP ${d > 0 ? "+" : ""}${d}px at t=${ss[i]!.t} sh=${ss[i]!.sh} nearWrites=${near.length}`);
		for (const w of near)
			console.log(`   write t=${w.t} ${w.prev}→${w.v} (sh@write=${w.sh})\n      ${w.stack.slice(0, 280)}`);
	}
}
const last = ss.at(-1);
console.log("\nfinal:", JSON.stringify(last));
process.exit(0);
