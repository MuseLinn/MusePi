#!/usr/bin/env bun
/**
 * Shell-batches (A1/A2/B1/C) real-machine verification over CDP.
 *
 * Launched against a desktop app instance started with MUSEPI_CDP_PORT.
 * Drives the REAL React components with DOM-dispatched events (the
 * gui-implementation §124 lesson: element.click() is not enough for
 * pointer flows, so the handle drag dispatches a full PointerEvent
 * sequence), captures screenshots, and prints a JSON assertion report.
 *
 * Usage: bun scripts/verify-shell-batches.ts [outDir]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PORT = process.env.MUSEPI_CDP_PORT ?? "9224";
const OUT = resolve(process.argv[2] ?? "docs/review/0.5.0-shell-panels-topbar-design/shots");
mkdirSync(OUT, { recursive: true });

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function findTarget(): Promise<{ id: string; url: string; webSocketDebuggerUrl: string } | null> {
	for (let i = 0; i < 60; i++) {
		try {
			const res = await fetch(`http://127.0.0.1:${PORT}/json`);
			const targets = (await res.json()) as Array<{
				id: string;
				type: string;
				url: string;
				webSocketDebuggerUrl: string;
			}>;
			const page = targets.find(t => t.type === "page" && t.url.includes("index.html"));
			if (page) return page;
		} catch {
			// not up yet
		}
		await sleep(500);
	}
	return null;
}

const target = await findTarget();
if (!target) {
	console.log(JSON.stringify({ fatal: "no renderer target on CDP port " + PORT }));
	process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise<void>((res, rej) => {
	ws.onopen = () => res();
	ws.onerror = () => rej(new Error("ws error"));
});

let nextId = 1;
const pending = new Map<number, (v: unknown) => void>();
ws.onmessage = (ev: MessageEvent) => {
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
		pending.set(id, msg =>
			(msg as { error?: unknown }).error
				? rej(new Error(JSON.stringify((msg as { error: unknown }).error)))
				: res(msg),
		);
		setTimeout(() => {
			if (pending.has(id)) {
				pending.delete(id);
				rej(new Error(`CDP timeout: ${method}`));
			}
		}, 8000);
	});
}

// Watchdog: never hang the walkthrough past 4 minutes — dump whatever
// report we have and exit (the last run died silently at the 300s Bash
// ceiling mid-navigation).
const watchdog = setTimeout(() => {
	console.log(JSON.stringify({ fatal: "watchdog timeout", report }, null, 2));
	process.exit(2);
}, 240_000);

const report: Record<string, unknown> = {};
async function evaluate<T>(expression: string): Promise<T> {
	const msg = (await cdp("Runtime.evaluate", {
		expression,
		awaitPromise: true,
		returnByValue: true,
	})) as { result?: { result?: { value?: T } } };
	return msg?.result?.result?.value as T;
}
async function shot(name: string): Promise<void> {
	const msg = (await cdp("Page.captureScreenshot", { format: "png" })) as { result?: { data?: string } };
	writeFileSync(join(OUT, name), Buffer.from(msg.result?.data ?? "", "base64"));
}
/** Real pointer sequence for React pointer handlers (click() alone emits
 *  no compatibility/mouse sequence — the §124 lesson). */
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

await cdp("Page.enable");
// Readiness gate: daemon connect + first paint can take 10s+ on a cold
// boot — poll for the header instead of a fixed sleep, then settle.
let ready = false;
for (let i = 0; i < 90; i++) {
	ready = Boolean(await evaluate<boolean>(`!!document.querySelector(".gui-header")`));
	if (ready) break;
	await sleep(500);
}
report.ready = ready;
await sleep(1500);

// 01 welcome header (P-tier defaults: board/mini-chat/pause/instance faint)
report.welcome = await evaluate<{ title: string; p2: number }>(`(() => ({
	title: document.querySelector(".gui-header-title-btn")?.textContent?.slice(0, 30) ?? null,
	p2: document.querySelectorAll(".gui-tool-btn--p2").length,
	instanceRecessed: !!document.querySelector(".gui-instance-btn--recessed"),
}))()`);
await shot("01-welcome-header.png");

// 02 instance menu: bridge row + version + update badge
report.instanceMenuClicked = await evaluate<boolean>(`(${CLICK})('[data-header-trigger="instance"]')`);
await sleep(500);
report.instanceMenu = await evaluate<{ bridge: string | null; badge: string | null }>(`(() => ({
	bridge: [...document.querySelectorAll(".gui-instance-menu div")].map(d => d.textContent).find(t => t?.includes("端口") || t?.includes("Port") || t?.includes("未运行") || t?.includes("Not running")) ?? null,
	badge: document.querySelector(".gui-update-badge")?.textContent ?? null,
}))()`);
await shot("02-instance-menu.png");
await evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
await sleep(300);

// 03 open/create a session through the switcher. Row 0 is 新建会话;
// prefer the first EXISTING session row (rows[1]) so the session view —
// ctx/branch chips + right rail — actually mounts (a fresh session opens
// on the composer and has no transcript chips yet).
try {
	report.switcherClicked = await evaluate<boolean>(`(${CLICK})('[data-header-trigger="switcher"]')`);
	await sleep(400);
	report.sessionRows = await evaluate<number>(
		`document.querySelectorAll(".gui-header-title-menu .gui-header-session-row").length`,
	);
	report.sessionRowClicked = await evaluate<boolean>(`(() => {
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
	// Opening a history session reactivates the daemon stream — poll for
	// the right rail (ChatView chrome) instead of a fixed sleep.
	report.sessionView = false;
	for (let i = 0; i < 30; i++) {
		report.sessionView = Boolean(await evaluate<boolean>(`!!document.querySelector(".gui-right-rail-btn")`));
		if (report.sessionView) break;
		await sleep(500);
	}
	report.sessionHeader = await evaluate<{ ctx: string | null; branch: string | null }>(`(() => ({
	ctx: [...document.querySelectorAll(".gui-header-chip")].map(c => c.textContent).find(t => t?.startsWith("ctx")) ?? null,
	branch: [...document.querySelectorAll(".gui-header-chip")].map(c => c.textContent).find(t => !t?.startsWith("ctx")) ?? null,
}))()`);
	await shot("03-session-header.png");
} catch (e) {
	report.sessionError = String(e);
}

// 04 collapse the sidebar → the session-title pill must stay clear of the
// fixed float-controls cluster (§5t carve spacer). State-aware: if the
// sidebar is already collapsed (toggle offers 打开侧边栏), expand it
// first so this step always demonstrates the collapse transition.
try {
	report.sidebarBefore = await evaluate<string | null>(
		`document.querySelector(".gui-sidebar-toggle")?.getAttribute("aria-label") ?? null`,
	);
	if (report.sidebarBefore && /打开|open/i.test(String(report.sidebarBefore))) {
		await evaluate<boolean>(`(${CLICK})(".gui-sidebar-toggle")`);
		await sleep(700);
	}
	report.sidebarToggled = await evaluate<boolean>(`(${CLICK})(".gui-sidebar-toggle")`);
	await sleep(1000);
	report.titleClearOfFloatControls = await evaluate<{ clear: boolean; overlapPx: number; spacerPx: number }>(`(() => {
	const title = document.querySelector(".gui-header-title");
	const float = document.querySelector(".gui-float-controls--overlay");
	const spacer = document.querySelector(".gui-header-spacer");
	if (!title || !float) return { clear: false, overlapPx: -1, spacerPx: -1 };
	const a = title.getBoundingClientRect();
	const b = float.getBoundingClientRect();
	const ox = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
	const oy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
	return { clear: ox * oy === 0, overlapPx: ox * oy, spacerPx: spacer ? Math.round(spacer.getBoundingClientRect().width) : -1 };
	})()`);
	await shot("04-collapsed-title-clear.png");
} catch (e) {
	report.tabsError = String(e);
}

// 05 open the managed browser through the right-edge rail
try {
	report.railBrowserClicked = await evaluate<boolean>(`(() => {
	const btn = [...document.querySelectorAll(".gui-right-rail-btn")].find(b => (b.getAttribute("aria-label") ?? "").includes("浏览") || (b.getAttribute("aria-label") ?? "").toLowerCase().includes("browser"));
	if (!btn) return false;
	const r = btn.getBoundingClientRect();
	for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "click"]) {
		btn.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, pointerId: 1 }));
	}
	return true;
})()`);
	await sleep(1500);
	report.browserPane = await evaluate<{ zoom: boolean; address: boolean }>(`({
	zoom: !!document.querySelector(".gui-browser-zoom"),
	address: !!document.querySelector(".gui-browser-address"),
})`);
	// Offline walkthrough: skip the external quick-link navigation (it hung
	// the previous run on network) — the readiness placeholder/start page is
	// enough to verify the pane chrome.
	report.navigation = "skipped (offline walkthrough)";
	await shot("05-browser-loaded.png");
} catch (e) {
	report.browserError = String(e);
}

// 06–08 viewport/zoom/drag — each step isolated so one CDP hiccup never
// kills the walkthrough.
try {
	report.vpMenuClicked = await evaluate<boolean>(`(${CLICK})(".gui-browser-actions .gui-browser-action-item button")`);
	await sleep(400);
	await evaluate(`(${CLICK})(".gui-browser-menu-viewports button:nth-child(2)")`);
	await sleep(1500);
	report.vpFrame = await evaluate<{ frame: boolean; size: string | null }>(`({
	frame: !!document.querySelector(".gui-browser-vp-frame"),
	size: document.querySelector(".gui-browser-vp-size")?.textContent ?? null,
})`);
	await shot("06-vp-phone.png");
} catch (e) {
	report.vpError = String(e);
}

try {
	// 07 zoom on a blank tab: controls render but stay disabled (zooming
	// about:blank is meaningless — §3.2.1). External navigation stays
	// offline-skipped, so disabled-on-blank IS the verifiable behavior.
	report.zoomDisabledOnBlank = await evaluate<boolean | null>(
		`document.querySelector(".gui-browser-zoom .gui-browser-icon-btn")?.disabled ?? null`,
	);
	report.zoom = await evaluate<string | null>(
		`document.querySelector(".gui-browser-zoom-value")?.textContent ?? null`,
	);
	await shot("07-zoom-120.png");
} catch (e) {
	report.zoomError = String(e);
}

try {
	// 08 drag the right handle +40 visual px → layout width grows ~40/scale
	report.handleDrag = await evaluate<{ before: string | null; after: string | null }>(`(async () => {
	const label = () => document.querySelector(".gui-browser-vp-size")?.textContent ?? null;
	const handle = document.querySelector(".gui-browser-vp-handle--x");
	if (!handle) return { before: null, after: null };
	const r = handle.getBoundingClientRect();
	const x = r.left + r.width / 2, y = r.top + r.height / 2;
	const before = label();
	const fire = (type: string, clientX: number): void => {
		handle.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, view: window, clientX, clientY: y, button: 0, pointerId: 1 }));
	};
	fire("pointerdown", x);
	fire("pointermove", x + 40);
	fire("pointerup", x + 40);
	await new Promise(res => setTimeout(res, 600));
	return { before, after: label() };
})()`);
	await shot("08-vp-after-drag.png");
} catch (e) {
	report.dragError = String(e);
}

clearTimeout(watchdog);
console.log(JSON.stringify(report, null, 2));
ws.close();
process.exit(0);
