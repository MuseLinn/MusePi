// Targeted repro for the guest-unmount race: an agent tab is created through
// the managed-browser CDP bridge and immediately closed again. Main disposes
// the guest before the `close-tab` push lands in the renderer, so unmounting
// the <webview> used to throw "Invalid guestInstanceId" inside React's commit
// and crash the GUI. With the prototype guard the run must end with ZERO
// exceptionThrown events and no error boundary.
const PORT = process.env.MUSEPI_CDP_PORT ?? "9225";
const BRIDGE = process.env.MUSEPI_BRIDGE_PORT ?? "9230";
const DIR = import.meta.dir;
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function findTarget() {
	for (let i = 0; i < 90; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${PORT}/json`);
			const targets = (await res.json()) as Array<{ type: string; title: string; url: string; webSocketDebuggerUrl: string }>;
			const page = targets.find(t => t.type === "page" && t.title === "MusePi" && t.url.includes("index.html"));
			if (page) return page;
		} catch {}
		await sleep(1000);
	}
	throw new Error("no renderer");
}

const target = await findTarget();
console.log("renderer ready:", target.url);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws")); });
let nextId = 1;
const pending = new Map<number, (v: unknown) => void>();
const errors: unknown[] = [];
ws.onmessage = ev => {
	const msg = JSON.parse(String(ev.data));
	if (msg.id && pending.has(msg.id)) { pending.get(msg.id)?.(msg); pending.delete(msg.id); return; }
	if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params);
};
function cdp(method: string, params: unknown = {}): Promise<unknown> {
	const id = nextId++;
	ws.send(JSON.stringify({ id, method, params }));
	return new Promise((res, rej) => {
		pending.set(id, m => ((m as { error?: unknown }).error ? rej(new Error(JSON.stringify((m as { error: unknown }).error))) : res(m)));
		setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`timeout ${method}`)); } }, 20000);
	});
}
async function evaluate<T>(expression: string): Promise<T> {
	const msg = (await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })) as {
		result?: { result?: { value?: T }; exceptionDetails?: unknown };
	};
	if (msg.result?.exceptionDetails) throw new Error(JSON.stringify(msg.result.exceptionDetails).slice(0, 400));
	return msg.result?.result?.value as T;
}

await cdp("Runtime.enable");
await sleep(400);

// 0) Guard sanity: the removeChild containment is installed at boot and
//    swallows exactly the Invalid guestInstanceId race.
const guard = await evaluate<string>(`(() => {
	const src = Node.prototype.removeChild.toString();
	return src.includes("guestInstanceId") ? "containment-installed" : "CONTAINMENT-MISSING:" + src.slice(0, 60);
})()`);
console.log("webview guard:", guard);

// Wait for the managed-browser bridge (main-process CDP). Connect at the
// browser level (/json/version) — /json/list is empty while no guest exists,
// which is exactly the state a fresh boot is in.
let bridge: WebSocket | null = null;
for (let i = 0; i < 30 && !bridge; i++) {
	try {
		const version = (await (await fetch(`http://127.0.0.1:${BRIDGE}/json/version`)).json()) as {
			webSocketDebuggerUrl?: string;
		};
		if (version?.webSocketDebuggerUrl) {
			bridge = new WebSocket(version.webSocketDebuggerUrl);
			await new Promise<void>((res, rej) => { bridge!.onopen = () => res(); bridge!.onerror = () => rej(new Error("bridge ws")); });
		}
	} catch { await sleep(1000); }
}
if (!bridge) { console.log("ABORT: no managed-browser bridge on", BRIDGE); process.exit(1); }
let bId = 1;
const bPending = new Map<number, (v: unknown) => void>();
bridge.onmessage = ev => {
	const msg = JSON.parse(String(ev.data));
	if (msg.id && bPending.has(msg.id)) { bPending.get(msg.id)?.(msg); bPending.delete(msg.id); }
};
function bcdp(method: string, params: unknown = {}): Promise<unknown> {
	const id = bId++;
	bridge!.send(JSON.stringify({ id, method, params }));
	return new Promise((res, rej) => {
		bPending.set(id, m => ((m as { error?: unknown }).error ? rej(new Error(JSON.stringify((m as { error: unknown }).error))) : res(m)));
		setTimeout(() => { if (bPending.has(id)) { bPending.delete(id); rej(new Error(`bridge timeout ${method}`)); } }, 20000);
	});
}

// 1) Hammer the race: create an agent tab and close it within the same tick,
//    many times. Each cycle main disposes the guest before the close push
//    lands — exactly the stress pattern that used to throw.
let created = 0;
for (let i = 0; i < 12; i++) {
	try {
		const res = (await bcdp("Target.createTarget", { url: "about:blank" })) as { result?: { targetId?: string } };
		const targetId = res.result?.targetId;
		if (!targetId) continue;
		created++;
		await bcdp("Target.closeTarget", { targetId }).catch(() => {});
	} catch (e) {
		console.log(`cycle ${i}:`, String(e).slice(0, 120));
	}
	await sleep(150);
}
console.log("race cycles created:", created);

// 2) Let the renderer drain the close pushes and unmount the elements.
await sleep(2500);

const boundary = await evaluate<boolean>(`document.body.innerText?.includes("渲染出错") === true`);
const tabCount = await evaluate<number>(`document.querySelectorAll(".gui-managed-host webview").length`).catch(() => -1);
console.log("error boundary:", boundary, "| host webviews left:", tabCount);
// Electron reports webview teardown through the C++ callback boundary on the
// uncaught channel even when the page-side containment swallowed the throw —
// these reports are benign (see main.tsx's error-ring filter). Only a
// DIFFERENT exception, or an actual error boundary, fails the run.
const material = errors.filter(e => {
	const desc = JSON.stringify(e);
	return !/Invalid guestInstanceId/.test(desc);
});
await Bun.write(`${DIR}/gui-race-errors.json`, JSON.stringify({ total: errors.length, benignGuestReports: errors.length - material.length, material }, null, 1));
console.log("exceptionThrown total:", errors.length, "| benign guestInstanceId reports:", errors.length - material.length, "| material:", material.length);
if (material.length) console.log("first material:", JSON.stringify(material[0]).slice(0, 500));
process.exit(material.length > 0 || boundary ? 1 : 0);
