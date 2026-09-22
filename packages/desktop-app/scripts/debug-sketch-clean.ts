// @ts-nocheck — one-off CDP debug scripts; typed loosely on purpose.
// Definitive clean test: reload → open sketch → toggle flyout open/close via REAL clicks.
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
const realClick = async (x, y) => {
	await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
	await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
	await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
};
const clickSel = async sel => {
	const p = await evalJs(
		`(() => { const el = ${sel}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`,
	);
	if (!p) return false;
	await realClick(p.x, p.y);
	return true;
};

await send("Page.enable");
await send("Page.reload");
await sleep(9000);

// open sketch pad
console.log(
	"attach:",
	await clickSel(
		`[...document.querySelectorAll('.gui-composer-ico')].find(b => b.getAttribute('aria-label') === '附件与模式')`,
	),
);
await sleep(400);
console.log(
	"sketch item:",
	await clickSel(
		`[...document.querySelectorAll('.gui-attach-opt')].find(o => { const t = o.querySelector('.gui-attach-opt-title'); return t && t.textContent.trim() === '绘画'; })`,
	),
);
await sleep(1000);

// toggle open
console.log("toggle#1:", await clickSel(`document.querySelector('.gui-sketch-shapes > button')`));
await sleep(400);
console.log("  flyout open:", await evalJs(`!!document.querySelector('.gui-sketch-flyout')`));
// toggle close
console.log("toggle#2:", await clickSel(`document.querySelector('.gui-sketch-shapes > button')`));
await sleep(400);
console.log("  flyout after close:", await evalJs(`!!document.querySelector('.gui-sketch-flyout')`));
// toggle open again
console.log("toggle#3:", await clickSel(`document.querySelector('.gui-sketch-shapes > button')`));
await sleep(400);
console.log("  flyout re-open:", await evalJs(`!!document.querySelector('.gui-sketch-flyout')`));
// click a shape item (rect = 3rd)
console.log("item:", await clickSel(`[...document.querySelectorAll('.gui-sketch-flyout-item')][2]`));
await sleep(400);
console.log("  flyout after item:", await evalJs(`!!document.querySelector('.gui-sketch-flyout')`));
console.log(
	"  toggle armed(on):",
	await evalJs(`document.querySelector('.gui-sketch-shapes > button').className.includes('--on')`),
);
ws.close();
process.exit(0);
