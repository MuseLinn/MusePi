// @ts-nocheck — one-off CDP debug scripts; typed loosely on purpose.
// Observe aria-expanded mutations on the toggle during real clicks.
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
	const btn = document.querySelector('.gui-sketch-shapes > button');
	window.__log = [];
	new MutationObserver(muts => {
		for (const m of muts) window.__log.push('attr ' + m.attributeName + ' -> ' + btn.getAttribute('aria-expanded'));
	}).observe(btn, { attributes: true });
	document.addEventListener('click', () => window.__log.push('doc-click seen, expanded=' + (document.querySelector('.gui-sketch-shapes > button')?.getAttribute('aria-expanded'))), false);
	return 'armed';
})()`);

const t = await evalJs(
	`(() => { const b = document.querySelector('.gui-sketch-shapes > button'); const r = b.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2, expanded: b.getAttribute('aria-expanded') }; })()`,
);
console.log("state:", t);
// real click — attempt to close (flyout currently open)
await clickAt(t.x, t.y);
await sleep(500);
console.log("log:", JSON.stringify(await evalJs(`window.__log`)));
console.log("flyout now:", await evalJs(`!!document.querySelector('.gui-sketch-flyout')`));
ws.close();
process.exit(0);
