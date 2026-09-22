// @ts-nocheck — one-off CDP debug scripts; typed loosely on purpose.
// Trace real-mouse events around the shape toggle + flyout.
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
	if (r.result?.exceptionDetails) return "EXC: " + JSON.stringify(r.result.exceptionDetails).slice(0, 300);
	return r.result?.result?.value;
};
const mouse = (type, x, y) =>
	send("Input.dispatchMouseEvent", {
		type,
		x,
		y,
		button: "left",
		buttons: type === "mouseMoved" ? 0 : 1,
		clickCount: 1,
	});
const clickAt = async (x, y) => {
	await mouse("mouseMoved", x, y);
	await mouse("mousePressed", x, y);
	await mouse("mouseReleased", x, y);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

await evalJs(`(() => {
	window.__trace = [];
	const shapes = document.querySelector('.gui-sketch-shapes');
	const btn = shapes?.querySelector(':scope > button');
	for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) {
		btn?.addEventListener(type, e => window.__trace.push({ phase: 'btn-' + type, defaultPrevented: e.defaultPrevented }));
		shapes?.addEventListener(type, e => window.__trace.push({ phase: 'shapes-' + type, target: e.target.tagName }), true);
	}
	window.addEventListener('pointerdown', e => window.__trace.push({ phase: 'win-pointerdown', cls: String(e.target.className).slice(0,50) }), true);
	return 'armed';
})()`);

const t = await evalJs(
	`(() => { const b = document.querySelector('.gui-sketch-shapes > button'); const r = b.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`,
);
// ensure open
console.log("open?", await evalJs(`!!document.querySelector('.gui-sketch-flyout')`));
if (!(await evalJs(`!!document.querySelector('.gui-sketch-flyout')`))) {
	await clickAt(t.x, t.y);
	await sleep(400);
}
console.log("flyout ensured open:", await evalJs(`!!document.querySelector('.gui-sketch-flyout')`));
await evalJs(`window.__trace = []; 'reset'`);
await clickAt(t.x, t.y); // real click to CLOSE
await sleep(400);
console.log("flyout after close-click:", await evalJs(`!!document.querySelector('.gui-sketch-flyout')`));
console.log("trace:", JSON.stringify(await evalJs(`window.__trace`), null, 1));
ws.close();
process.exit(0);
