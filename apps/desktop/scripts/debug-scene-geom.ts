const PORT = "9225";
const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()) as Array<{
	type: string;
	url: string;
	webSocketDebuggerUrl: string;
}>;
const page = targets.find(t => t.type === "page" && t.url.includes("index.html"));
if (!page) throw new Error("no page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise<void>((res, rej) => {
	ws.onopen = () => res();
	ws.onerror = () => rej(new Error("ws"));
});
let id = 1;
const pending = new Map<number, (m: unknown) => void>();
ws.onmessage = ev => {
	const m = JSON.parse(String(ev.data)) as { id?: number };
	if (m.id && pending.has(m.id)) {
		pending.get(m.id)?.(m);
		pending.delete(m.id);
	}
};
const cdp = (method: string, params: unknown = {}): Promise<unknown> => {
	const i = id++;
	ws.send(JSON.stringify({ id: i, method, params }));
	return new Promise((res, rej) => {
		pending.set(i, m => {
			const err = (m as { error?: unknown }).error;
			if (err) rej(new Error(JSON.stringify(err)));
			else res(m);
		});
		setTimeout(() => rej(new Error("timeout")), 8000);
	});
};
const expr = `(() => {
	const rect = el => { if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right), Math.round(r.width)]; };
	const scene = document.querySelector(".gui-scene-chat");
	const row = scene?.querySelector(":scope > .flex.min-h-0.flex-1") ?? scene?.firstElementChild;
	const aside = document.querySelector(".gui-pane-right--inner");
	const rail = document.querySelector(".gui-right-rail");
	const chat = document.querySelector(".gui-chat-column");
	return {
		innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio,
		bodyScroll: [document.body.scrollLeft, document.documentElement.scrollLeft],
		sceneRect: rect(scene), asideRect: rect(aside), railRect: rect(rail), chatRect: rect(chat),
		rowChildren: row ? [...row.children].map(c => ({ cls: String(c.className).slice(0, 44), rect: rect(c) })) : null,
		maximized: aside?.className.includes("maximized") ?? null,
	};
})()`;
const r = (await cdp("Runtime.evaluate", { expression: expr, returnByValue: true })) as {
	result?: { result?: { value?: unknown } };
};
console.log(JSON.stringify(r.result?.result?.value, null, 2));
process.exit(0);
