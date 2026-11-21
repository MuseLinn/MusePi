/**
 * Live verification for the bare-Escape interrupt guard (lib/escape-stop).
 *
 * Drives an ISOLATED desktop instance (CDP :9224, or MUSEPI_CDP_PORT) wired to
 * its own daemon, on a scratch session. Synthetic Escape events are the only
 * keyboard input, so the probe never presses Escape into another window's
 * live session.
 *
 * Asserts the observable contract: whether the renderer puts a `session.abort`
 * frame on the wire. The run exits non-zero when a step that should be
 * proven does not happen — the previous revision printed "want true/false"
 * diagnostics and always exited 0, so a missing composer or a turn that never
 * started still read as a pass.
 *
 * Usage: bun apps/desktop/scripts/verify-escape-guard.mjs
 */
import puppeteer from "puppeteer-core";
import { pressEscape, sendComposerPrompt, waitForComposer } from "./composer-probe.mjs";

const CDP_PORT = process.env.MUSEPI_CDP_PORT ?? "9224";
const browser = await puppeteer.connect({
	browserURL: `http://127.0.0.1:${CDP_PORT}`,
	// A wedged renderer must fail the smoke, not hang it: bound every CDP call.
	protocolTimeout: 45_000,
});
const page = (await browser.pages()).find(p => p.url().includes("dist/index.html"));
if (!page) throw new Error("GUI page not found");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = "") => {
	results.push({ name, ok });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

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

/** Ensure a turn is streaming so the interrupt checks are meaningful. */
async function ensureWorking() {
	if (await working()) return true;
	await sendComposerPrompt(page, "回复 working 一百遍", { session: true });
	for (let i = 0; i < 30; i++) {
		await sleep(1000);
		if (await working()) return true;
	}
	return false;
}

try {
	// ── 0. Dismiss an onboarding modal if one is up ──────────────────────────
	// A modal OWNS Escape while it is up (its capture handler preventDefaults and
	// closes), so leaving one open would make the bare-Escape parity step
	// vacuous.
	//
	// LIMITATION: the first-run setup dialog cannot be completed against a
	// credential-less temp root, so on such an instance the parity step reports
	// false and the branch stays proven only at the unit level
	// (shouldEscapeStopTurn + the session-abort-rpc label seam). Run against a
	// root that has finished onboarding to exercise it live.
	const isVisibleOverlay = () =>
		page.evaluate(() => {
			const visible = el => {
				if (!el.isConnected || el.getClientRects().length === 0) return false;
				const style = getComputedStyle(el);
				return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0;
			};
			return [...document.querySelectorAll('[aria-modal="true"], .gui-dialog-backdrop, .gui-obo, [class*=onboard]')].some(
				visible,
			);
		});
	if (await isVisibleOverlay()) {
		await page.evaluate(() => {
			const visible = el => {
				if (!el.isConnected || el.getClientRects().length === 0) return false;
				const style = getComputedStyle(el);
				return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0;
			};
			const host = [...document.querySelectorAll(".gui-obo, [class*=onboard], [aria-modal='true']")].find(visible);
			const b = host
				? [...host.querySelectorAll("button")].find(x => /跳过|Skip/.test(x.textContent ?? ""))
				: null;
			b?.click();
		});
		await sleep(900);
	}
	console.log("modal still up:", await isVisibleOverlay());

	console.log("create scratch session…");
	await page.evaluate(() => {
		const fresh = [...document.querySelectorAll("button")].find(b =>
			/新建任务|新建会话|New task|New session/.test(`${b.getAttribute("aria-label") ?? ""}${b.textContent ?? ""}`),
		);
		fresh?.click();
	});
	await sleep(5000);

	// The composer is CodeMirror. On the create/welcome surface the session
	// editor does not exist yet — the first submitted prompt creates it — so
	// wait for a composer (any skin) first, then for the session editor after
	// the send.
	await waitForComposer(page, 10_000);
	const sessionAlreadyUp = await page.evaluate(() => {
		const visible = el => el.isConnected && (el.getClientRects().length > 0 || el.offsetParent !== null);
		return [...document.querySelectorAll(".musepi-composer-editor[data-composer-input] .cm-content")].some(visible);
	});
	// The isolated daemon's only credential is the offline fake provider, so the
	// turn streams without touching any real quota.
	const prompt = "回复 working 一百遍";
	await sendComposerPrompt(page, prompt, { session: sessionAlreadyUp });
	await waitForComposer(page, 20_000, { session: true });
	let promptInTranscript = false;
	for (let i = 0; i < 40 && !promptInTranscript; i++) {
		promptInTranscript = await page.evaluate(
			text => [...document.querySelectorAll(".tr-row--user")].some(row => (row.textContent ?? "").includes(text)),
			prompt,
		);
		if (!promptInTranscript) await sleep(500);
	}
	check("0. prompt submitted through the CodeMirror composer", promptInTranscript, prompt);
	if (!promptInTranscript) throw new Error("submitted prompt never reached the transcript");

	let started = false;
	for (let i = 0; i < 30 && !started; i++) {
		await sleep(1000);
		started = await working();
	}
	console.log("turn running:", started, "| aborts:", await aborts());
	check("1. turn actually started", started, started ? "" : "no running turn — parity checks cannot be proven");
	if (!started) throw new Error("no running turn; abort parity is unobservable");

	// ── 1. Escape aimed at a NON-composer field: no interrupt ────────────────
	{
		const before = await aborts();
		await pressEscape(page, "plainfield");
		await sleep(1200);
		const after = await aborts();
		check("2. escape in a non-composer field does not abort", after === before, `${before}→${after}`);
	}

	// ── 2. Escape with a floating menu open: closes it, no interrupt ─────────
	{
		const before = await aborts();
		const opened = await page.evaluate(() => {
			// The session-title menu trigger opens a MenuPopup; other header
			// triggers run actions (dev server, open-in) and open no menu.
			const b = document.querySelector('[data-header-trigger="titleMenu"]');
			b?.click();
			return !!b;
		});
		await sleep(700);
		const menuUp = await page.evaluate(() => !!document.querySelector(".gui-menu-popup"));
		await pressEscape(page, "body");
		await sleep(1200);
		const closed = await page.evaluate(() => !document.querySelector(".gui-menu-popup"));
		const after = await aborts();
		check(
			"3. escape closes an open menu without aborting",
			opened && menuUp && closed && after === before,
			`opened=${opened} menuUp=${menuUp} closed=${closed} aborts ${before}→${after}`,
		);
	}

	// ── 3. Held Escape (key repeat): no interrupt ────────────────────────────
	{
		const before = await aborts();
		await pressEscape(page, "body", { repeat: true });
		await sleep(1000);
		const after = await aborts();
		check("4. held escape (repeat) does not abort", after === before, `${before}→${after}`);
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
		const after = await aborts();
		check("5. escape claimed by a surface does not abort", after === before, `${before}→${after}`);
	}

	// ── 5. Bare Escape with no owner: still interrupts (TUI parity) ──────────
	{
		const running = await ensureWorking();
		const before = await aborts();
		const bare = await pressEscape(page, "body");
		await sleep(1500);
		const after = await aborts();
		// `claimed` names the failure precisely: an always-mounted surface that
		// preventDefaults every Escape makes the window-level interrupt
		// unreachable, which is a product-side ownership bug rather than a
		// missing composer.
		check(
			"6. bare escape still interrupts (TUI parity)",
			running && !bare.claimed && after > before,
			`running=${running} claimed=${bare.claimed} ${before}→${after}`,
		);
	}

	const failed = results.filter(r => !r.ok);
	console.log(`\n== escape-guard verification: ${results.length - failed.length}/${results.length} passed ==`);
	for (const f of failed) console.log("  FAIL:", f.name);
	process.exitCode = failed.length === 0 ? 0 : 1;
} catch (err) {
	console.error(err instanceof Error ? err.message : err);
	process.exitCode = 1;
} finally {
	await browser.disconnect().catch(() => {});
}