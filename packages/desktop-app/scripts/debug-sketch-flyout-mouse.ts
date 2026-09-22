// @ts-nocheck — one-off CDP debug scripts; typed loosely on purpose.
// One-off: real-mouse test of the SketchPad shape flyout via CDP Input.
const PORT = process.argv[2] ?? "9226";

const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
const target = list.find(t => t.url.includes("index.html"));
if (!target) throw new Error("index.html target not found");

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
	return r.result?.result?.value;
};
const mouse = async (type, x, y) => {
	await send("Input.dispatchMouseEvent", {
		type,
		x,
		y,
		button: "left",
		buttons: type === "mouseMoved" ? 0 : 1,
		clickCount: 1,
	});
};
const clickAt = async (x, y) => {
	await mouse("mouseMoved", x, y);
	await mouse("mousePressed", x, y);
	await mouse("mouseReleased", x, y);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 0. open the sketch pad via the attach menu
const at = await evalJs(
	`(() => { const b = [...document.querySelectorAll('.gui-composer-ico')].find(b => b.getAttribute('aria-label') === '附件与模式'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`,
);
await clickAt(at.x, at.y);
await sleep(400);
const sk = await evalJs(
	`(() => { const o = [...document.querySelectorAll('.gui-attach-opt')].find(o => o.textContent.trim() === '绘画'); if (!o) return null; const r = o.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`,
);
await clickAt(sk.x, sk.y);
await sleep(900);

// 1. open flyout with a REAL click on the toggle
const t = await evalJs(
	`(() => { const b = document.querySelector('.gui-sketch-shapes > button'); if (!b) return null; b.scrollIntoView({block:'nearest'}); const r = b.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`,
);
console.log("toggle at", t);
await clickAt(t.x, t.y);
await sleep(400);
console.log("flyout open:", await evalJs(`!!document.querySelector('.gui-sketch-flyout')`));

// 2. REAL click on the toggle again — should close
await clickAt(t.x, t.y);
await sleep(400);
console.log("flyout after 2nd toggle click:", await evalJs(`!!document.querySelector('.gui-sketch-flyout')`));

// 3. reopen, REAL click a shape item
await clickAt(t.x, t.y);
await sleep(400);
const it = await evalJs(
	`(() => { const items = [...document.querySelectorAll('.gui-sketch-flyout-item')]; const r = items[2].getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2, title: items[2].title }; })()`,
);
console.log("item at", it);
await clickAt(it.x, it.y);
await sleep(400);
console.log(
	"after item click:",
	await evalJs(
		`JSON.stringify({ flyout: !!document.querySelector('.gui-sketch-flyout'), toggleTitle: document.querySelector('.gui-sketch-shapes > button').title, toggleOn: document.querySelector('.gui-sketch-shapes > button').className.includes('--on'), hitTest: (() => { const b = document.querySelector('.gui-sketch-shapes > button'); const r = b.getBoundingClientRect(); const el = document.elementFromPoint(r.left+r.width/2, r.top+r.height/2); return el ? el.tagName + '.' + String(el.className).slice(0,40) : 'null'; })() })`,
	),
);

ws.close();
process.exit(0);
