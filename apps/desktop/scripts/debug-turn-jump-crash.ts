// Repro capture: open the long session, jump to turn 0 via the rail, and
// record every exception / console.error leading to the error boundary.

const PORT = 9225;
const TS = "2026-09-03T17:34:19.642Z";

async function targets() {
	const res = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(4000) });
	return await res.json();
}

let seq = 0;
function session(url: string, onEvent?: (msg: { method?: string; params?: any }) => void) {
	const ws = new WebSocket(url);
	const pending = new Map();
	ws.addEventListener("message", evt => {
		let msg: { id?: number; method?: string; params?: unknown };
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
	const ready = new Promise<void>((res, rej) => {
		ws.addEventListener("open", () => res());
		ws.addEventListener("error", () => rej(new Error("ws error")));
	});
	const send = (method: string, params: Record<string, unknown> = {}, timeoutMs = 15000) =>
		new Promise(resolve => {
			const id = ++seq;
			const timer = setTimeout(() => {
				pending.delete(id);
				resolve({ __timeout: true, method });
			}, timeoutMs);
			pending.set(id, (msg: unknown) => {
				clearTimeout(timer);
				resolve(msg);
			});
			ws.send(JSON.stringify({ id, method, params }));
		});
	return { ws, ready, send };
}

const events: string[] = [];
interface CdpTarget {
	type?: string;
	url?: string;
	webSocketDebuggerUrl?: string;
}
const all: CdpTarget[] = await targets();
const page = all.filter(t => t.type === "page").find((p: { url?: string }) => p.url?.includes("index.html"));
if (!page) {
	console.log("no page");
	process.exit(1);
}

const { ws, ready, send } = session(page.webSocketDebuggerUrl!, (msg: { method?: string; params?: any }) => {
	if (msg.method === "Runtime.exceptionThrown") {
		const d = msg.params?.exceptionDetails ?? {};
		const frame = d.stackTrace?.callFrames?.[0];
		events.push(
			`EXCEPTION ${d.exception?.description?.split("\n").slice(0, 6).join(" | ") ?? d.text} @ ${frame ? `${frame.url}:${frame.lineNumber + 1}` : "?"}`,
		);
	} else if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
		const text = (msg.params.args ?? [])
			.map((a: { value?: unknown; description?: unknown }) => a.value ?? a.description ?? "")
			.join(" ")
			.slice(0, 500);
		events.push(`CONSOLE.ERROR ${text}`);
	}
});
await ready;
await send("Runtime.enable");
await send("Page.enable");
// Recover from the error boundary first.
await send("Page.reload", { ignoreCache: false });
await new Promise(r => setTimeout(r, 10000));
// Open the long session.
const openRes = (await send(
	"Runtime.evaluate",
	{
		expression: `(async()=>{ const row=[...document.querySelectorAll(".gui-session-row")].find(r=>r.textContent?.includes("启动system-prompt")); if(!row) return "no-row"; row.click(); await new Promise(r=>setTimeout(r,9000)); return document.querySelector(".gui-transcript")?"open":"not-open"; })()`,
		returnByValue: true,
		awaitPromise: true,
	},
	30000,
)) as { __timeout?: boolean; result?: { result?: { value?: unknown } } };
console.log("open:", openRes.result?.result?.value ?? JSON.stringify(openRes.result ?? openRes));
// Drive the rail: hover → Home → Enter (jump to turn 0, far above the window).
const jumpRes = (await send(
	"Runtime.evaluate",
	{
		expression: `(async()=>{ const track=document.querySelector(".gui-turn-track"); if(!track) return "no-rail"; const r=track.getBoundingClientRect(); track.dispatchEvent(new PointerEvent("pointermove",{bubbles:true,cancelable:true,clientX:r.x+r.width/2,clientY:r.y+r.height/2})); await new Promise(res=>setTimeout(res,300)); track.dispatchEvent(new KeyboardEvent("keydown",{key:"Home",bubbles:true,cancelable:true})); await new Promise(res=>setTimeout(res,200)); track.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true})); return "dispatched"; })()`,
		returnByValue: true,
		awaitPromise: true,
	},
	15000,
)) as { __timeout?: boolean; result?: { result?: { value?: unknown } } };
console.log("jump dispatch:", jumpRes.result?.result?.value ?? "(timeout — page busy)");
// Watch the paging play out.
for (let i = 0; i < 24; i++) {
	await new Promise(r => setTimeout(r, 5000));
	const st = (await send(
		"Runtime.evaluate",
		{
			expression: `JSON.stringify({boundary: document.body.textContent?.includes("界面渲染出错") ?? false, row: !!document.querySelector('[title="${TS}"]'), scroller: !!document.querySelector(".gui-transcript"), loaded: document.querySelectorAll(".tr-row").length})`,
			returnByValue: true,
		},
		8000,
	)) as { __timeout?: boolean; result?: { result?: { value?: unknown } } };
	if (st.__timeout) {
		console.log(`t+${(i + 1) * 5}s: eval blocked`);
		continue;
	}
	const v = st.result?.result?.value as string | undefined;
	console.log(`t+${(i + 1) * 5}s: ${v}`);
	if (v && (v.includes('"row":true') || v.includes('"boundary":true'))) break;
}
console.log(`\nevents (${events.length}):`);
for (const e of [...new Set(events)].slice(0, 25)) console.log(`  ${e}`);
ws.close();
process.exit(0);
