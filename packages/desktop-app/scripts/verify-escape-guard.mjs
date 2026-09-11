/**
 * Live verification for the bare-Escape interrupt guard (lib/escape-stop).
 *
 * Drives an ISOLATED desktop instance (CDP :9224) wired to its own daemon, on
 * a scratch session. Synthetic Escape events are the only keyboard input, so
 * the probe never presses Escape into another window's live session.
 *
 * Asserts the observable contract: whether the renderer puts a `session.abort`
 * frame on the wire.
 *
 * Usage: bun packages/desktop-app/scripts/verify-escape-guard.mjs
 */
import puppeteer from "puppeteer-core";

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9224" });
const page = (await browser.pages()).find(p => p.url().includes("dist/index.html"));
if (!page) throw new Error("GUI page not found");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Record every session.abort the renderer sends — the observable contract.
await page.evaluate(() => {
	window.__aborts = 0;
	const orig = WebSocket.prototype.send;
	WebSocket.prototype.send = function (data) {
		try {
			const s = typeof data === "string" ? data : new TextDecoder().decode(data);
			if (s.includes("session.abort")) window.__aborts++;
		} catch {}
		return orig.call(this, data);
	};
});

const aborts = () => page.evaluate(() => window.__aborts);
const working = () =>
	page.evaluate(() => {
		const t = document.querySelector(".gui-header")?.textContent ?? "";
		return /回复中|工作中|Replying|Working/.test(t);
	});

/** Dispatch Escape at a chosen target, as the window-level handler sees it. */
const pressEscape = (where, init = {}) =>
	page.evaluate(
		({ where, init }) => {
			const target =
				where === "composer"
					? document.querySelector('[data-chat-input="true"] textarea')
					: where === "plainfield"
						? document.querySelector(".gui-session-search input, .gui-settings-search input, input:not([data-chat-input] *)")
						: document.body;
			if (!target) return `no target: ${where}`;
			target.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init }),
			);
			return "ok";
		},
		{ where, init },
	);

// ── 0. Dismiss an onboarding modal if one is up ──────────────────────────
// A modal OWNS Escape while it is up (its capture handler preventDefaults and
// closes), so leaving one open would make step 5 vacuous.
//
// LIMITATION: the first-run setup dialog cannot be completed against a
// credential-less temp root, so on such an instance step 5 reports false and
// the parity branch stays proven only at the unit level (shouldEscapeStopTurn
// + the session-abort-rpc label seam). Run against a root that has finished
// onboarding to exercise it live.
const modalUp = () =>
	page.evaluate(() => !!document.querySelector('[aria-modal="true"], .gui-dialog-backdrop, .gui-obo, [class*=onboard]'));
if (await modalUp()) {
	await page.evaluate(() => {
		const host = document.querySelector(".gui-obo, [class*=onboard], [aria-modal='true']");
		const b = host
			? [...host.querySelectorAll("button")].find(x => /跳过|Skip/.test(x.textContent ?? ""))
			: null;
		b?.click();
	});
	await sleep(900);
}
console.log("modal still up:", await modalUp());

console.log("create scratch session…");
await page.evaluate(() => {
	const fresh = [...document.querySelectorAll("button")].find(b =>
		/新建任务|新建会话|New task|New session/.test(`${b.getAttribute("aria-label") ?? ""}${b.textContent ?? ""}`),
	);
	fresh?.click();
});
await sleep(5000);

// The isolated daemon's only credential is the offline fake provider, so the
// turn streams for ~45s without touching any real quota.
const sent = await page.evaluate(() => {
	const ta = document.querySelector('[data-chat-input="true"] textarea');
	if (!ta) return "no composer";
	Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, "回复 working 一百遍");
	ta.dispatchEvent(new Event("input", { bubbles: true }));
	ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
	return "sent";
});
console.log("prompt:", sent);
// Wait for the turn to actually be streaming (not merely accepted).
let isWorking = false;
for (let i = 0; i < 30 && !isWorking; i++) {
	await sleep(1000);
	isWorking = await working();
}
console.log("turn running:", isWorking, "| aborts:", await aborts());
if (!isWorking)
	console.log("WARNING: no running turn — the parity check below cannot prove anything");

// ── 1. Escape aimed at a NON-composer field: no interrupt ────────────────
{
	const before = await aborts();
	await pressEscape("plainfield");
	await sleep(1200);
	console.log("1. escape in a non-composer field  → aborted?", (await aborts()) !== before, "(want false)");
}

// ── 2. Escape with a floating menu open: closes it, no interrupt ─────────
{
	const before = await aborts();
	const opened = await page.evaluate(() => {
		// Header menu triggers carry data-header-trigger (GuiHeader).
		const b = document.querySelector("[data-header-trigger]");
		b?.click();
		return !!b;
	});
	await sleep(700);
	const menuUp = await page.evaluate(() => !!document.querySelector(".gui-menu-popup"));
	await pressEscape("body");
	await sleep(1200);
	const closed = await page.evaluate(() => !document.querySelector(".gui-menu-popup"));
	console.log(
		`2. escape with a menu open        → opened: ${opened}, menu up: ${menuUp}, closed: ${closed}, aborted?`,
		(await aborts()) !== before,
		"(want false)",
	);
}

// ── 3. Held Escape (key repeat): no interrupt ────────────────────────────
{
	const before = await aborts();
	await pressEscape("body", { repeat: true });
	await sleep(1000);
	console.log("3. held escape (repeat)            → aborted?", (await aborts()) !== before, "(want false)");
}

// ── 4. Escape a surface already claimed (onboarding/menu handler) ────────
{
	const before = await aborts();
	await page.evaluate(() => {
		const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
		e.preventDefault(); // simulate a surface that owns the key
		document.body.dispatchEvent(e);
	});
	await sleep(1000);
	console.log("4. escape claimed by a surface     → aborted?", (await aborts()) !== before, "(want false)");
}

// ── 5. Bare Escape with no owner: still interrupts (TUI parity) ──────────
{
	const before = await aborts();
	await pressEscape("body");
	await sleep(1500);
	const after = await aborts();
	console.log(`5. bare escape (parity preserved)  → aborted?`, after > before, `(${before}→${after}, want true)`);
}

await browser.disconnect();
process.exit(0);
