#!/usr/bin/env bun
/** One-shot: sample .gui-pane-right--inner geometry at 25ms intervals through
 *  collapse / expand / maximize / restore to pin down the visual glitches:
 *   - collapse: "suddenly enlarges a bit then collapses"
 *   - maximize: "panel offset right-down" + "no animation on maximize"
 * Prints a compact timeline JSON. */
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

const PANEL = ".gui-pane-right--inner";
const COLUMN = ".gui-chat-column";

// Install an in-page sampler (25ms interval) writing to window.__cap.
await evaluate(`(() => {
	window.__cap = [];
	window.__capT0 = performance.now();
	window.__sampler = setInterval(() => {
		const el = document.querySelector(${JSON.stringify(PANEL)});
		if (!el) return;
		const r = el.getBoundingClientRect();
		const cs = getComputedStyle(el);
		const col = document.querySelector(${JSON.stringify(COLUMN)});
		const cr = col ? col.getBoundingClientRect() : null;
		window.__cap.push({
			t: Math.round(performance.now() - window.__capT0),
			w: Math.round(r.width * 10) / 10,
			l: Math.round(r.left * 10) / 10,
			rt: Math.round(r.right * 10) / 10,
			ml: cs.marginLeft, mr: cs.marginRight,
			pos: cs.position,
			closed: el.classList.contains("gui-pane-right--inner--closed"),
			max: el.classList.contains("gui-pane-right--maximized"),
			colL: cr ? Math.round(cr.left * 10) / 10 : null,
			colT: cr ? Math.round(cr.top * 10) / 10 : null,
			colW: cr ? Math.round(cr.width * 10) / 10 : null,
			colH: cr ? Math.round(cr.height * 10) / 10 : null,
		});
	}, 25);
	return true;
})()`);

async function runPhase(name: string, clickExpr: string, waitMs: number): Promise<Record<string, unknown>> {
	await evaluate(`(() => { window.__cap = []; window.__capT0 = performance.now(); return true; })()`);
	const clicked = await evaluate<boolean>(clickExpr);
	await sleep(waitMs);
	const samples = await evaluate<Array<Record<string, unknown>>>(
		`(() => { const c = window.__cap; window.__cap = []; return c; })()`,
	);
	return { name, clicked, samples };
}

const click = (sel: string) => `(() => {
	const el = document.querySelector(${JSON.stringify(sel)});
	if (!el) return false;
	const r = el.getBoundingClientRect();
	const x = r.left + r.width / 2, y = r.top + r.height / 2;
	for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click"]) {
		el.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, pointerId: 1 }));
	}
	return true;
})()`;

const clickRailToggle = (label: string) => `(() => {
	const el = [...document.querySelectorAll(".gui-right-rail-btn")].find(b => (b.getAttribute("aria-label") ?? "").includes(${JSON.stringify(label)}));
	if (!el) return false;
	const r = el.getBoundingClientRect();
	const x = r.left + r.width / 2, y = r.top + r.height / 2;
	for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click"]) {
		el.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, pointerId: 1 }));
	}
	return true;
})()`;

const report: Record<string, unknown> = {};

// Baseline state
report.baseline = await evaluate(`(() => {
	const el = document.querySelector(${JSON.stringify(PANEL)});
	if (!el) return null;
	const r = el.getBoundingClientRect();
	const cs = getComputedStyle(el);
	return { w: r.width, closed: el.classList.contains("gui-pane-right--inner--closed"), max: el.classList.contains("gui-pane-right--maximized"), ml: cs.marginLeft, mr: cs.marginRight };
})()`);

// Phase A: collapse (panel must be open first)
if (!(report.baseline as { closed: boolean })?.closed) {
	report.collapse = await runPhase("collapse", clickRailToggle("collapse right panel"), 800);
} else {
	report.collapse = await runPhase("expand→collapse", clickRailToggle("expand right panel"), 800).then(async r => {
		const second = await runPhase("collapse", clickRailToggle("collapse right panel"), 800);
		return [r, second];
	});
}

// Phase B: expand
report.expand = await runPhase("expand", clickRailToggle("expand right panel"), 800);

// Phase C: maximize (needs panel open)
report.maximize = await runPhase("maximize", click('.gui-pane-tool[aria-label="最大化面板"]'), 900);

// Phase D: restore
report.restore = await runPhase("restore", click('.gui-pane-tool[aria-label="还原面板"]'), 900);

// stop sampler
await evaluate(`(() => { clearInterval(window.__sampler); return true; })()`);

console.log(JSON.stringify(report, null, 1));
process.exit(0);
