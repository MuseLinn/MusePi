#!/usr/bin/env bun
/**
 * `bun scripts/cdp-probe.mjs` — attach to a running dev GUI over CDP and
 * answer the one question that splits "renderer main thread is blocked" from
 * "renderer is fine but input/compositing is stuck".
 *
 * Usage:
 *   1. Start the GUI with the debugging port forwarded to Electron:
 *        bun run desktop:dev -- --remote-debugging-port=9222
 *   2. In another shell (or from an agent session):
 *        bun scripts/cdp-probe.mjs                 # probe + stack if blocked
 *        bun scripts/cdp-probe.mjs --list          # just list targets
 *        bun scripts/cdp-probe.mjs --port 9222
 *
 * What it does:
 *   - Runtime.evaluate("1") with a short budget. If the answer arrives, the
 *     main thread is alive → the freeze is input routing / compositing, not JS.
 *   - If it times out, the thread is blocked: Debugger.pause interrupts the
 *     loop and we print the paused call frames (file:line), which names the
 *     stuck code instead of guessing.
 */
import net from "node:net";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(flag("--port", "9222"));
const LIST_ONLY = args.includes("--list");
const DEEP_LIST = args.includes("--deep");
const TARGET = flag("--target", "");
const INDEX = Number(flag("--index", "0"));
const EVAL = flag("--eval", "");
const PROBE_BUDGET_MS = Number(flag("--budget", "2500"));

async function targets() {
	const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(4000) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return await res.json();
}

let seq = 0;
function session(url, onEvent) {
	const ws = new WebSocket(url);
	const pending = new Map();
	ws.addEventListener("message", evt => {
		let msg;
		try {
			msg = JSON.parse(String(evt.data));
		} catch {
			return;
		}
		if (msg.id && pending.has(msg.id)) {
			pending.get(msg.id)(msg);
			pending.delete(msg.id);
			return;
		}
		if (msg.method) onEvent?.(msg);
	});
	const ready = new Promise((res, rej) => {
		ws.addEventListener("open", () => res());
		ws.addEventListener("error", e => rej(new Error(`ws error: ${e?.message ?? "unknown"}`)));
	});
	const send = (method, params = {}, timeoutMs = 5000) =>
		new Promise((resolve, reject) => {
			const id = ++seq;
			const timer = setTimeout(() => {
				pending.delete(id);
				resolve({ __timeout: true, method });
			}, timeoutMs);
			pending.set(id, msg => {
				clearTimeout(timer);
				resolve(msg);
			});
			try {
				ws.send(JSON.stringify({ id, method, params }));
			} catch (err) {
				clearTimeout(timer);
				reject(err);
			}
		});
	return { ws, ready, send };
}

let all;
try {
	all = await targets();
} catch (err) {
	if (!args.includes("--reload-pause")) {
		console.error(
			`cannot reach the CDP endpoint on 127.0.0.1:${PORT} (${err?.message ?? err})\n` +
				"start the GUI with the port forwarded first:  bun run desktop:dev -- --remote-debugging-port=9222",
		);
		process.exit(1);
	}
	// --reload-pause polls for the target itself (the GUI may still be booting).
	all = [];
}
const pages = all.filter(t => t.type === "page");
if (LIST_ONLY || DEEP_LIST || (pages.length === 0 && !args.includes("--reload-pause"))) {
	for (const t of all) {
		let nodes = "-";
		if (DEEP_LIST && t.type === "page" && t.webSocketDebuggerUrl) {
			try {
				const s = session(t.webSocketDebuggerUrl, undefined);
				await s.ready;
				const r = await s.send(
					"Runtime.evaluate",
					{ expression: "document.getElementsByTagName('*').length", returnByValue: true },
					1500,
				);
				nodes = r.__timeout ? "BLOCKED" : String(r.result?.result?.value ?? "?");
				s.ws.close();
			} catch {
				nodes = "err";
			}
		}
		console.log(`${t.type}\t${t.title || "-"}\t${t.url}\tnodes=${nodes}`);
	}
	if (pages.length === 0 && !LIST_ONLY && !DEEP_LIST) {
		console.log("no page target — is the GUI running with --remote-debugging-port?");
	}
	process.exit(0);
}

const target = TARGET ? pages.find(p => `${p.url} ${p.title}`.toLowerCase().includes(TARGET.toLowerCase())) : pages[INDEX];
if (!target && !args.includes("--reload-pause")) {
	console.error(`no page target matched (--target "${TARGET}" --index ${INDEX}); use --list --deep to see them`);
	process.exit(1);
}
if (target) console.log(`target: ${target.title || "-"}  ${target.url}`);
const paused = [];
// --reload-pause polls for its own target (the GUI may still be booting), so the
// main session stays optional here.
const main = target
	? session(target.webSocketDebuggerUrl, msg => {
			if (msg.method === "Debugger.paused") paused.push(msg.params);
		})
	: null;
const ready = main?.ready ?? Promise.resolve();
const send = main?.send ?? (async (_m, _p, _t) => ({ __timeout: true, method: "no-session" }));
const ws = main?.ws ?? null;
await ready;

// --eval: run one expression and print it (awaitPromise so async probes work).
if (EVAL) {
	const r = await send(
		"Runtime.evaluate",
		{ expression: EVAL, returnByValue: true, awaitPromise: true },
		PROBE_BUDGET_MS * 4,
	);
	if (r.__timeout) console.log("eval: TIMED OUT (main thread blocked)");
	else if (r.result?.exceptionDetails) {
		console.log(`eval error: ${r.result.exceptionDetails.exception?.description ?? "unknown"}`);
	} else {
		const v = r.result?.result?.value;
		console.log(typeof v === "string" ? v : JSON.stringify(v));
	}
	ws.close();
	process.exit(0);
}

// --reload-trace: reload the page and capture boot exceptions/console errors,
// then report whether the app actually mounted. This is the mode that answers
// "the window never finishes loading" (readyState stuck at interactive with an
// empty #root) — the errors a black-box screenshot can't show.
if (args.includes("--reload-trace")) {
	const events = [];
	const { ready: r2, send: s2, ws: w2 } = session(target.webSocketDebuggerUrl, msg => {
		if (msg.method === "Runtime.exceptionThrown") {
			const d = msg.params?.exceptionDetails ?? {};
			const frame = d.stackTrace?.callFrames?.[0];
			events.push(
				`EXCEPTION ${d.exception?.description?.split("\n")[0] ?? d.text} @ ${frame ? `${frame.url}:${frame.lineNumber + 1}` : "?"}`,
			);
		} else if (msg.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(msg.params?.type)) {
			const text = (msg.params.args ?? [])
				.map(a => a.value ?? a.description ?? a.preview?.description ?? "")
				.join(" ")
				.slice(0, 300);
			events.push(`CONSOLE.${msg.params.type.toUpperCase()} ${text}`);
		} else if (msg.method === "Log.entryAdded" && ["error", "warning"].includes(msg.params?.entry?.level)) {
			events.push(`LOG.${msg.params.entry.level.toUpperCase()} ${msg.params.entry.text} ${msg.params.entry.url ?? ""}`);
		}
	});
	await r2;
	await s2("Runtime.enable", {}, 3000);
	await s2("Log.enable", {}, 3000);
	await s2("Page.enable", {}, 3000);
	await s2("Page.reload", { ignoreCache: false }, 3000);
	const WAIT_MS = Number(flag("--wait", "9000"));
	console.log(`reloading ${target.url} and watching for ${WAIT_MS}ms…`);
	await new Promise(r => setTimeout(r, WAIT_MS));
	const fin = await s2(
		"Runtime.evaluate",
		{
			expression:
				'JSON.stringify({readyState:document.readyState, rootChildren:document.getElementById("root")?.childElementCount ?? null, nodes:document.getElementsByTagName("*").length, stepTitle:document.querySelector(".gui-onboarding-title")?.textContent ?? null, overlays:document.querySelectorAll(".gui-onboarding-backdrop,.gui-dialog-backdrop").length})',
			returnByValue: true,
		},
		4000,
	);
	console.log(`\nafter reload: ${fin.__timeout ? "BLOCKED" : (fin.result?.result?.value ?? "?")}`);
	console.log(`\nevents (${events.length}):`);
	for (const e of [...new Set(events)].slice(0, 40)) console.log(`  ${e}`);
	w2.close();
	process.exit(0);
}

// --reload-pause: enable the debugger FIRST, then reload. Once the renderer's
// main thread blocks, Debugger.enable can no longer be acked (it queues on the
// same thread), so the only way to get the stuck stack is to be attached before
// the block; V8's interrupt then delivers Debugger.paused with the live frames.
if (args.includes("--reload-pause")) {
	// The GUI may still be booting: poll for its page target so the debugger can
	// be attached as early as possible (the block lands seconds later, when the
	// spawned daemon connects).
	const WAIT_TARGET_MS = Number(flag("--wait-target", "25000"));
	let tgt = target;
	const until = Date.now() + WAIT_TARGET_MS;
	while (!tgt && Date.now() < until) {
		await new Promise(r => setTimeout(r, 400));
		try {
			const list = await targets();
			tgt = list
				.filter(t => t.type === "page")
				.find(p => `${p.url} ${p.title}`.toLowerCase().includes((TARGET || "5173").toLowerCase()));
		} catch {
			// endpoint not up yet
		}
	}
	if (!tgt) {
		console.log(`no page target appeared in ${WAIT_TARGET_MS}ms`);
		process.exit(1);
	}
	console.log(`target: ${tgt.title || "-"}  ${tgt.url}`);
	const pausedFrames = [];
	const { ready: r3, send: s3, ws: w3 } = session(tgt.webSocketDebuggerUrl, msg => {
		if (msg.method === "Debugger.paused") pausedFrames.push(msg.params);
	});
	await r3;
	const en = await s3("Debugger.enable", {}, 6000);
	console.log(`Debugger.enable: ${en.__timeout ? "TIMED OUT (already blocked)" : "ok"}`);
	if (en.__timeout) {
		console.log("already blocked before attach — restart the GUI and retry");
		process.exit(1);
	}
	// Optional: wait for the daemon port to be listening (the block follows the
	// daemon connect on this setup).
	const REQ_PORT = Number(flag("--require-port", "0"));
	if (REQ_PORT) {
		const portUp = async () =>
			await new Promise(res => {
				const s = new net.Socket();
				s.setTimeout(500);
				s.once("connect", () => {
					s.destroy();
					res(true);
				});
				s.once("timeout", () => {
					s.destroy();
					res(false);
				});
				s.once("error", () => res(false));
				s.connect(REQ_PORT, "127.0.0.1");
			});
		const pUntil = Date.now() + Number(flag("--wait-port", "30000"));
		while (!(await portUp()) && Date.now() < pUntil) await new Promise(r => setTimeout(r, 500));
		console.log(`port ${REQ_PORT}: ${(await portUp()) ? "listening" : "never came up"}`);
	}
	if (!args.includes("--no-reload")) {
		await s3("Page.enable", {}, 3000);
		await s3("Page.reload", { ignoreCache: false }, 3000);
	}
	const WAIT = Number(flag("--wait", "15000"));
	console.log(`watching for ${WAIT}ms…`);
	await new Promise(r => setTimeout(r, WAIT));
	console.log(`\npaused events: ${pausedFrames.length}`);
	for (const [n, p] of pausedFrames.slice(-4).entries()) {
		const frames = p.callFrames ?? [];
		console.log(`\n--- pause #${n + 1} reason=${p.reason} frames=${frames.length} ---`);
		for (const [i, f] of frames.slice(0, 30).entries()) {
			const loc = f.url ? `${f.url.replace(/^https?:\/\/127\.0\.0\.1:5173/, "")}:${f.lineNumber + 1}:${f.columnNumber + 1}` : "(native)";
			console.log(`  ${String(i).padStart(2)} ${f.functionName || "<anonymous>"}  ${loc}`);
		}
		if (frames.length === 0) console.log("  (no JS frame — block is outside script execution)");
	}
	// Leave the renderer running: a paused loop would otherwise stay frozen.
	if (pausedFrames.length) await s3("Debugger.resume", {}, 3000);
	w3.close();
	process.exit(0);
}

// NOTE — CPU attribution is not available over CDP here: Electron's
// /json/version carries no browser webSocketDebuggerUrl (so SystemInfo.* is
// unreachable). Sample per-process CPU from the OS instead, 5s apart:
//   PowerShell:  Get-Process electron | Select Id, CPU
// A renderer whose CPU climbs → CPU-bound stall (native loop / layout / raster);
// every process flat while the window is dead → the renderer is WAITING.

// 1) Is the main thread serving tasks at all?
const probe = await send("Runtime.evaluate", { expression: "1+1", returnByValue: true }, PROBE_BUDGET_MS);
if (probe.__timeout) {
	console.log(`\nVERDICT: main thread BLOCKED (no reply to Runtime.evaluate in ${PROBE_BUDGET_MS}ms)`);
	console.log("interrupting with Debugger.pause to capture the stuck stack…");
	await send("Debugger.enable", {}, 3000);
	await send("Debugger.pause", {}, 3000);
	const deadline = Date.now() + 6000;
	while (paused.length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 120));
	const p = paused[0];
	if (!p) {
		console.log("no Debugger.paused event — the block may be outside JS (compositor/layout), not a script loop");
	} else {
		console.log(`\nreason: ${p.reason}`);
		const frames = p.callFrames ?? [];
		console.log(`frames (top ${Math.min(25, frames.length)} of ${frames.length}):`);
		for (const [i, f] of frames.slice(0, 25).entries()) {
			const loc = f.url ? `${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1}` : "(native)";
			console.log(`  ${String(i).padStart(2)} ${f.functionName || "<anonymous>"}  ${loc}`);
		}
	}
} else {
	console.log("\nVERDICT: main thread ALIVE (Runtime.evaluate replied)");
	console.log("→ the freeze is NOT a JS block. Check input routing (pointer events / setIgnoreMouseEvents),");
	console.log("  window focus ownership, or compositor cost of the visible glass layers.");
	if (probe.result?.result?.value !== undefined) console.log(`   evaluate("1+1") = ${probe.result.result.value}`);
}

// 2) Cheap state fingerprint — only meaningful while the thread answers.
const state = await send(
	"Runtime.evaluate",
	{
		expression:
			'JSON.stringify({visibility:document.visibilityState, focus:document.hasFocus(), active:document.activeElement?.className||document.activeElement?.tagName, windows:document.querySelectorAll(".gui-onboarding-backdrop, .gui-dialog-backdrop").length, nodes:document.getElementsByTagName("*").length})',
		returnByValue: true,
	},
	PROBE_BUDGET_MS,
);
if (state.__timeout) console.log("\nstate fingerprint: timed out (thread blocked)");
else console.log(`\nstate: ${state.result?.result?.value ?? "(none)"}`);

// 3) Layout/task counters — LayoutCount climbing between two reads means layout thrash.
await send("Performance.enable", {}, 3000);
const readMetrics = async () => {
	const m = await send("Performance.getMetrics", {}, 3000);
	const out = {};
	for (const { name, value } of m.result?.metrics ?? []) out[name] = value;
	return out;
};
const m1 = await readMetrics();
await new Promise(r => setTimeout(r, 1500));
const m2 = await readMetrics();
if (Object.keys(m1).length) {
	const d = k => (m2[k] ?? 0) - (m1[k] ?? 0);
	console.log(
		`metrics over 1.5s: TaskDuration +${d("TaskDuration").toFixed(3)}s  LayoutCount +${d("LayoutCount")}  RecalcStyleCount +${d("RecalcStyleCount")}  Nodes ${m2.Nodes ?? "?"}  JSHeapUsedSize ${Math.round((m2.JSHeapUsedSize ?? 0) / 1048576)}MB`,
	);
}

ws.close();
process.exit(0);
