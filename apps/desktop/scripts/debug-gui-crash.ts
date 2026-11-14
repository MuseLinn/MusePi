// Captures the renderer exception that crashes the MusePi GUI when opening
// the long session: enables Runtime/Log domains BEFORE the click, reloads the
// window, waits for the session list, clicks the row, and dumps every
// exceptionThrown / console error with stacks.
const PORT = process.env.MUSEPI_CDP_PORT ?? "9225";
const SEARCH = process.argv[2] ?? "启动system-prompt";
const DIR = import.meta.dir;
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
const openJs = await Bun.file(`${DIR}/debug-pagination-jitter.open.js`).text();

async function findTarget() {
	for (let i = 0; i < 40; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${PORT}/json`);
			const targets = (await res.json()) as Array<{
				type: string;
				title: string;
				url: string;
				webSocketDebuggerUrl: string;
			}>;
			const page = targets.find(t => t.type === "page" && t.title === "MusePi" && t.url.includes("index.html"));
			if (page) return page;
		} catch {}
		await sleep(500);
	}
	throw new Error("no renderer");
}

const target = await findTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise<void>((res, rej) => {
	ws.onopen = () => res();
	ws.onerror = () => rej(new Error("ws"));
});
let nextId = 1;
const pending = new Map<number, (v: unknown) => void>();
const events: unknown[] = [];
ws.onmessage = ev => {
	const msg = JSON.parse(String(ev.data));
	if (msg.id && pending.has(msg.id)) {
		pending.get(msg.id)?.(msg);
		pending.delete(msg.id);
		return;
	}
	if (
		msg.method === "Runtime.exceptionThrown" ||
		msg.method === "Runtime.consoleAPICalled" ||
		msg.method === "Log.entryAdded"
	) {
		events.push(msg.params);
	}
};
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
	if (msg.result?.exceptionDetails) throw new Error(JSON.stringify(msg.result.exceptionDetails).slice(0, 600));
	return msg.result?.result?.value as T;
}

await cdp("Runtime.enable");
await cdp("Log.enable");
await cdp("Page.enable");
await sleep(500);

// Reload for a clean capture surface, then wait for the session list.
await cdp("Page.reload", { ignoreCache: false }).catch(() => {});
let rows = 0;
for (let i = 0; i < 40; i++) {
	await sleep(1000);
	rows = await evaluate<number>(`document.querySelectorAll(".gui-session-row").length`).catch(() => 0);
	if (rows > 0) break;
}
console.log("rows after reload:", rows);
if (rows === 0) {
	console.log("ABORT: no session list");
	process.exit(1);
}

console.log("click:", await evaluate<string>(`(async (search) => { ${openJs} })(${JSON.stringify(SEARCH)})`));
// Watch the error boundary appear.
for (let i = 0; i < 20; i++) {
	await sleep(1000);
	const state = await evaluate<string>(`(() => {
		if (document.body.innerText?.includes("渲染出错")) return "error-boundary";
		if (document.querySelector(".gui-transcript")) return "transcript";
		return "loading";
	})()`).catch(() => "eval-fail");
	if (state === "error-boundary" || state === "transcript") {
		console.log(`t+${i + 1}s state:`, state);
		break;
	}
	if (i === 19) console.log("t+20s state:", state);
}

await Bun.write(`${DIR}/gui-crash-events.json`, JSON.stringify(events, null, 1));
console.log("captured events:", events.length, "→", `${DIR}/gui-crash-events.json`);
for (const e of events.slice(0, 12)) {
	const s = JSON.stringify(e);
	console.log("---", s.slice(0, 900));
}
process.exit(0);
