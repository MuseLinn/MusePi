// @ts-nocheck — one-off CDP debug scripts; typed loosely on purpose.
// Clean double-fire test: count DOM click events for ONE real CDP click.
const PORT = process.argv[2] ?? "9226";
const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
const target = list.find(t => t.url.includes("index.html"));
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
	ws.onopen = res;
	ws.onerror = rej;
});
let seq = 0;
const pending = new Map();
ws.onmessage = ev => {
	const msg = JSON.parse(ev.data);
	if (msg.id && pending.has(msg.id)) {
		pending.get(msg.id)(msg);
		pending.delete(msg.id);
	}
};
const send = (method, params = {}) =>
	new Promise(res => {
		const id = ++seq;
		pending.set(id, res);
		ws.send(JSON.stringify({ id, method, params }));
	});
const evalJs = async expr => {
	const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
	if (r.result?.exceptionDetails) return "EXC: " + JSON.stringify(r.result.exceptionDetails).slice(0, 400);
	return r.result?.result?.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

await send("Page.enable");
await send("Page.reload");
await sleep(9000);

const armed = await evalJs(`(() => {
	const b = [...document.querySelectorAll('.gui-composer-ico')].find(b => b.getAttribute('aria-label') === '附件与模式');
	if (!b) return null;
	window.__clicks = 0;
	b.addEventListener('click', () => window.__clicks++);
	const r = b.getBoundingClientRect();
	return { x: r.left + r.width/2, y: r.top + r.height/2 };
})()`);
console.log("armed:", armed);
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: armed.x, y: armed.y, buttons: 0 });
await send("Input.dispatchMouseEvent", {
	type: "mousePressed",
	x: armed.x,
	y: armed.y,
	button: "left",
	buttons: 1,
	clickCount: 1,
});
await send("Input.dispatchMouseEvent", {
	type: "mouseReleased",
	x: armed.x,
	y: armed.y,
	button: "left",
	buttons: 0,
	clickCount: 1,
});
await sleep(400);
console.log("dom click count for ONE real click:", await evalJs(`window.__clicks`));
console.log("attach menu open:", await evalJs(`!!document.querySelector(".gui-attach-menu")`));
ws.close();
process.exit(0);
