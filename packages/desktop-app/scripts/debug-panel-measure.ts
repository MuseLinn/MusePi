#!/usr/bin/env bun
/** One-shot: measure right-panel layer widths + open the browser pane and
 * measure its chrome layers. Prints JSON. */
const PORT = process.env.MUSEPI_CDP_PORT ?? "9225";
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function findTarget() {
	for (let i = 0; i < 30; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${PORT}/json`);
			const targets = (await res.json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
			const page = targets.find(t => t.type === "page" && t.url.includes("index.html"));
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
ws.onmessage = ev => {
	const msg = JSON.parse(String(ev.data));
	if (msg.id && pending.has(msg.id)) {
		pending.get(msg.id)?.(msg);
		pending.delete(msg.id);
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
		}, 8000);
	});
}
async function evaluate<T>(expression: string): Promise<T> {
	const msg = (await cdp("Runtime.evaluate", { expression, returnByValue: true })) as {
		result?: { result?: { value?: T } };
	};
	return msg.result?.result?.value as T;
}
const CLICK = `(sel) => {
	const el = document.querySelector(sel);
	if (!el) return false;
	const r = el.getBoundingClientRect();
	const x = r.left + r.width / 2, y = r.top + r.height / 2;
	for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click"]) {
		el.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, pointerId: 1 }));
	}
	return true;
}`;

const report: Record<string, unknown> = {};

// open a session via switcher
report.switcher = await evaluate<boolean>(`(${CLICK})('[data-header-trigger="switcher"]')`);
await sleep(400);
report.row = await evaluate<boolean>(`(() => {
	const rows = document.querySelectorAll(".gui-header-title-menu .gui-header-session-row");
	const el = rows[1] ?? rows[0];
	if (!el) return false;
	const r = el.getBoundingClientRect();
	const x = r.left + r.width / 2, y = r.top + r.height / 2;
	for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click"]) {
		el.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, pointerId: 1 }));
	}
	return true;
})()`);
for (let i = 0; i < 30; i++) {
	if (await evaluate<boolean>(`!!document.querySelector(".gui-right-rail-btn")`)) break;
	await sleep(500);
}

// open browser pane via rail
report.rail = await evaluate<boolean>(`(() => {
	const btn = [...document.querySelectorAll(".gui-right-rail-btn")].find(b => (b.getAttribute("aria-label") ?? "").includes("浏览"));
	if (!btn) return false;
	const r = btn.getBoundingClientRect();
	for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click"]) {
		btn.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, pointerId: 1 }));
	}
	return true;
})()`);
await sleep(1500);
// state-aware: the rail click toggles — if the persisted state had the panel
// open, our click closed it; reopen when the aside measures 0.
const asideW = await evaluate<number>(
	`document.querySelector(".gui-pane-right--inner")?.getBoundingClientRect().width ?? 0`,
);
if (asideW < 50) {
	await evaluate<boolean>(`(() => {
		const btn = [...document.querySelectorAll(".gui-right-rail-btn")].find(b => (b.getAttribute("aria-label") ?? "").includes("浏览"));
		if (!btn) return false;
		const r = btn.getBoundingClientRect();
		for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click"]) {
			btn.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, pointerId: 1 }));
		}
		return true;
	})()`);
	await sleep(1500);
}

const MEASURE = `(() => {
	const out = {};
	const grab = (key, sel) => {
		const el = document.querySelector(sel);
		if (!el) { out[key] = null; return; }
		const r = el.getBoundingClientRect();
		const cs = getComputedStyle(el);
		out[key] = { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), pl: cs.paddingLeft, pr: cs.paddingRight, ml: cs.marginLeft, mr: cs.marginRight, box: cs.boxSizing };
	};
	grab("aside", ".gui-pane-right--inner");
	grab("asideParent", ".gui-pane-right");
	grab("bodyCol", ".gui-pane-right--inner > div.flex");
	grab("tabRow", ".gui-pane-right--inner .gui-surface-tabs") || grab("tabRow2", ".gui-pane-right--inner .flex.px-2");
	grab("browserContent", ".gui-browser-content");
	grab("slot", ".gui-browser-slot");
	grab("startOverlay", ".gui-browser-start-overlay");
	grab("start", ".gui-browser-start");
	grab("host", ".gui-managed-host");
	// find the address bar row: the flex row containing the address input
	const addr = document.querySelector(".gui-browser-address, [class*='address']");
	grab("addrEl", ".gui-browser-address");
	const pane = document.querySelector(".gui-browser-pane, .gui-browser-content")?.closest("div");
	// widths of every direct child column of aside
	const aside = document.querySelector(".gui-pane-right--inner");
	out.children = aside ? [...aside.children].map(c => { const r = c.getBoundingClientRect(); return { cls: c.className.slice(0, 60), left: Math.round(r.left), width: Math.round(r.width) }; }) : null;
	return out;
})()`;
report.measure = await evaluate(MEASURE);

// screenshot
const shot = (await cdp("Page.captureScreenshot", { format: "png" })) as { result?: { data?: string } };
const { writeFileSync, mkdirSync } = await import("node:fs");
mkdirSync("docs/review/0.5.0-shell-panels-topbar-design/shots", { recursive: true });
writeFileSync(
	"docs/review/0.5.0-shell-panels-topbar-design/shots/debug-panel-measure.png",
	Buffer.from(shot.result?.data ?? "", "base64"),
);
console.log(JSON.stringify(report, null, 2));
process.exit(0);
