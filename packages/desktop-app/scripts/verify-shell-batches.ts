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
 * Usage: bun scripts/verify-shell-batches.mjs [outDir]
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
			const targets = (await res.json()) as Array<{ id: string; type: string; url: string; webSocketDebuggerUrl: string }>;
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
		pending.set(id, (msg) => (msg as { error?: unknown }).error ? rej(new Error(JSON.stringify((msg as { error: unknown }).error))) : res(msg));
		setTimeout(() => {
			if (pending.has(id)) {
				pending.delete(id);
				rej(new Error(`CDP timeout: ${method}`));
			}
		}, 20000);
	});
}

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

// 03 open/create a session through the switcher (first row = 新建会话 or a recent session)
report.switcherClicked = await evaluate<boolean>(`(${CLICK})('[data-header-trigger="switcher"]')`);
await sleep(400);
report.sessionRows = await evaluate<number>(`document.querySelectorAll(".gui-header-title-menu .gui-header-session-row").length`);
await evaluate(`(${CLICK})(".gui-header-title-menu .gui-header-session-row")`);
await sleep(2500);
report.sessionHeader = await evaluate<{ ctx: string | null; branch: string | null }>(`(() => ({
	ctx: [...document.querySelectorAll(".gui-header-chip")].map(c => c.textContent).find(t => t?.startsWith("ctx")) ?? null,
	branch: [...document.querySelectorAll(".gui-header-chip")].map(c => c.textContent).find(t => !t?.startsWith("ctx")) ?? null,
}))()`);
await shot("03-session-header.png");

// 04 collapse the sidebar → session tabs strip
report.sidebarToggled = await evaluate<boolean>(`(${CLICK})(".gui-sidebar-toggle")`);
await sleep(700);
report.tabsStrip = await evaluate<{ shown: boolean; tabs: number }>(`({
	shown: !!document.querySelector(".gui-header-tabs"),
	tabs: document.querySelectorAll(".gui-header-tab").length,
})`);
await shot("04-tabs-strip.png");

// 05 open the managed browser through the right-edge rail
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
// navigate via the start page's first quick link
await evaluate(`(${CLICK})(".gui-browser-quick-card")`);
await sleep(4000);
await shot("05-browser-loaded.png");

// 06 phone preset → dashed frame + handles
report.vpMenuClicked = await evaluate<boolean>(`(${CLICK})(".gui-browser-actions .gui-browser-action-item button")`);
await sleep(400);
await evaluate(`(${CLICK})(".gui-browser-menu-viewports button:nth-child(2)")`);
await sleep(1500);
report.vpFrame = await evaluate<{ frame: boolean; size: string | null }>(`({
	frame: !!document.querySelector(".gui-browser-vp-frame"),
	size: document.querySelector(".gui-browser-vp-size")?.textContent ?? null,
})`);
await shot("06-vp-phone.png");

// 07 zoom in ×2 → 120%
await evaluate(`(${CLICK})(".gui-browser-zoom button:nth-child(3)")`);
await sleep(250);
await evaluate(`(${CLICK})(".gui-browser-zoom button:nth-child(3)")`);
await sleep(500);
report.zoom = await evaluate<string | null>(`document.querySelector(".gui-browser-zoom-value")?.textContent ?? null`);
await shot("07-zoom-120.png");

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

console.log(JSON.stringify(report, null, 2));
ws.close();
process.exit(0);
