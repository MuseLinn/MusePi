/**
 * Composer probe shared by the live desktop verification scripts.
 *
 * The composer became a CodeMirror 6 editor (ADR 0004), so the historical
 * `[data-chat-input="true"] textarea` locator now matches nothing. A probe
 * that keeps the stale selector either times out (and may report success from
 * an unrelated assertion) or runs its steps against a missing input and calls
 * the result parity. This module is the one place that knows the current DOM:
 *
 *   .musepi-composer-editor            host mounted by ComposerEditor
 *     .cm-editor > .cm-content         CodeMirror's editable surface
 *
 * `[data-chat-input="true"]` still marks the frame (selection capture and the
 * Escape guard use it), and the session skin additionally carries
 * `data-composer-input` (composer-input-redirect). Every locator therefore
 * walks from the live frame to the CodeMirror content instead of guessing a
 * textarea. Missing elements throw: a smoke step must fail loudly rather than
 * spend its timeout and proceed.
 */

export const COMPOSER_INPUT_SELECTOR = '[data-chat-input="true"] .musepi-composer-editor .cm-content';
/** Session-only variant: the welcome composer shares the frame marker. */
export const SESSION_COMPOSER_INPUT_SELECTOR =
	'[data-chat-input="true"] .musepi-composer-editor[data-composer-input] .cm-content';

const pickSelector = session => (session ? SESSION_COMPOSER_INPUT_SELECTOR : COMPOSER_INPUT_SELECTOR);

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class ComposerMissingError extends Error {
	constructor(selector, diagnostics) {
		super(`composer input not found: ${selector}${diagnostics ? ` — ${diagnostics}` : ""}`);
		this.name = "ComposerMissingError";
		this.selector = selector;
		this.diagnostics = diagnostics ?? "";
	}
}

/** Diagnostic snapshot for a failed locator: what the page renders instead. */
async function composerDiagnostics(page, selector) {
	return page.evaluate(sel => {
		const visible = el => el.isConnected && (el.getClientRects().length > 0 || el.offsetParent !== null);
		const frames = [...document.querySelectorAll('[data-chat-input="true"]')];
		const editors = [...document.querySelectorAll(".musepi-composer-editor")];
		const contents = [...document.querySelectorAll(".cm-content")];
		return JSON.stringify({
			url: location.href,
			frames: frames.length,
			framesVisible: frames.filter(visible).length,
			editors: editors.length,
			sessionEditors: document.querySelectorAll(".musepi-composer-editor[data-composer-input]").length,
			cmContent: contents.length,
			cmContentVisible: contents.filter(visible).length,
			selector: sel,
			matched: document.querySelectorAll(sel).length,
			body: (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 300),
		});
	}, selector);
}

/**
 * Locate the composer's CodeMirror content.
 *
 * `session: true` requires the in-session skin; `requireVisible` (default)
 * rejects a mounted-but-hidden editor. Returns `{ element, selector }` or
 * throws `ComposerMissingError` with a page snapshot.
 */
export async function findComposer(page, { session = false, requireVisible = true } = {}) {
	const selector = pickSelector(session);
	const found = await page.evaluate(
		({ sel, requireVisible }) => {
			const visible = el => el.isConnected && (el.getClientRects().length > 0 || el.offsetParent !== null);
			const all = [...document.querySelectorAll(sel)];
			const candidates = requireVisible ? all.filter(visible) : all;
			const element = candidates[0] ?? null;
			return element ? { ok: true, count: all.length } : { ok: false, count: all.length };
		},
		{ sel: selector, requireVisible },
	);
	if (!found.ok) {
		throw new ComposerMissingError(selector, await composerDiagnostics(page, selector));
	}
	return { selector, count: found.count };
}

/** Same as findComposer, but waits for the editor to mount (boot/session swap). */
export async function waitForComposer(page, timeoutMs = 15_000, options = {}) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			return await findComposer(page, options);
		} catch (err) {
			if (!(err instanceof ComposerMissingError) || Date.now() >= deadline) throw err;
		}
		await sleep(250);
	}
}

/** Non-throwing snapshot: `{ found, value }`. Used after submit, where a
 *  welcome-composer send legitimately unmounts the editor as the session
 *  opens. */
async function composerSnapshot(page, selector) {
	return page.evaluate(sel => {
		const visible = el => el.isConnected && (el.getClientRects().length > 0 || el.offsetParent !== null);
		const content = [...document.querySelectorAll(sel)].find(visible);
		if (!content) return { found: false };
		const view = content.cmTile?.root?.view ?? null;
		return {
			found: true,
			value: view
				? view.state.doc.toString()
				: [...content.querySelectorAll(".cm-line")].map(line => line.textContent ?? "").join("\n"),
		};
	}, selector);
}

/** Exact document text. Reads the CodeMirror state when reachable; the DOM
 *  fallback joins rendered lines so a probe still reports a useful value if a
 *  future CodeMirror build stops exposing the view on the content node. */
export async function composerValue(page, options = {}) {
	const selector = pickSelector(options.session);
	const snapshot = await composerSnapshot(page, selector);
	if (!snapshot.found) {
		throw new ComposerMissingError(selector, await composerDiagnostics(page, selector));
	}
	return snapshot.value;
}

/**
 * Replace the composer document the way a user edit does: focus the
 * CodeMirror content, select its whole contents, then insert the text through
 * `execCommand("insertText")`. Chromium turns that into the beforeinput/input
 * sequence CodeMirror consumes, so the host's onChange runs and the send path
 * sees the text — a synthetic transaction would skip that path.
 *
 * The wait uses timers, not requestAnimationFrame: a backgrounded Electron
 * window suspends frame callbacks, which would hang the probe until Puppeteer's
 * protocol timeout.
 *
 * The document is read back and compared; a mismatch is a hard failure.
 */
export async function setComposerValue(page, text, options = {}) {
	const { selector } = await findComposer(page, options);
	const wrote = await page.evaluate(
		({ sel, text }) => {
			const visible = el => el.isConnected && (el.getClientRects().length > 0 || el.offsetParent !== null);
			const content = [...document.querySelectorAll(sel)].find(visible);
			if (!content) return { ok: false, reason: "missing" };
			content.focus();
			// Select the whole document, so insertText replaces it rather than
			// appending at whatever caret position the mount left behind.
			const range = document.createRange();
			range.selectNodeContents(content);
			const selection = window.getSelection();
			selection.removeAllRanges();
			selection.addRange(range);
			const inserted = document.execCommand("insertText", false, text);
			return { ok: true, inserted };
		},
		{ sel: selector, text },
	);
	if (!wrote.ok) throw new ComposerMissingError(selector, await composerDiagnostics(page, selector));
	await sleep(250);
	const value = await composerValue(page, options);
	if (value !== text) {
		throw new Error(
			`composer write failed${wrote.inserted ? "" : " (insertText returned false)"}: want ${JSON.stringify(text)} got ${JSON.stringify(value)}`,
		);
	}
	// Let React commit the onChange state before the send handler reads it.
	await sleep(200);
	return selector;
}

/** Submit with an Enter keydown on the focused composer. The synthetic event
 *  goes through CodeMirror's keymap (the same path as a physical key); the
 *  observable clear/unmount is proven by sendComposerPrompt. */
export async function submitComposer(page, options = {}) {
	const { selector } = await findComposer(page, options);
	await sleep(200); // settle React's onChange state before the key is read
	const sent = await page.evaluate(sel => {
		const visible = el => el.isConnected && (el.getClientRects().length > 0 || el.offsetParent !== null);
		const content = [...document.querySelectorAll(sel)].find(visible);
		if (!content) return { ok: false };
		content.focus();
		const event = new KeyboardEvent("keydown", {
			key: "Enter",
			code: "Enter",
			bubbles: true,
			cancelable: true,
		});
		content.dispatchEvent(event);
		return { ok: true, prevented: event.defaultPrevented };
	}, selector);
	if (!sent.ok) throw new ComposerMissingError(selector, await composerDiagnostics(page, selector));
	return { selector, prevented: sent.prevented };
}

/**
 * Type a prompt and submit it, then prove the interaction actually happened:
 * the document held the text, Enter was consumed by the app, and the composer
 * either cleared (in-session send) or unmounted (the welcome composer hands off
 * to the new session). Returns `{ selector, cleared | unmounted }`; a submit
 * with no observable effect throws with the still-held value.
 */
export async function sendComposerPrompt(page, text, { timeoutMs = 10_000, ...options } = {}) {
	const selector = await setComposerValue(page, text, options);
	await submitComposer(page, options);

	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const snapshot = await composerSnapshot(page, selector);
		if (!snapshot.found) return { selector, unmounted: true };
		if (snapshot.value === "") return { selector, cleared: true };
		if (Date.now() >= deadline) {
			throw new Error(`composer did not clear after submit: ${JSON.stringify(snapshot.value)} (selector ${selector})`);
		}
		await sleep(200);
	}
}

/** Press Escape at a chosen surface as the window-level handler sees it.
 *  `"composer"` targets the CodeMirror content inside the live frame; a
 *  missing target throws instead of silently skipping the step. */
export async function pressEscape(page, where, init = {}) {
	if (where === "composer") {
		const { selector } = await findComposer(page);
		const result = await page.evaluate(
			({ sel, init }) => {
				const visible = el => el.isConnected && (el.getClientRects().length > 0 || el.offsetParent !== null);
				const target = [...document.querySelectorAll(sel)].find(visible);
				if (!target) return { ok: false };
				target.focus();
				const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init });
				target.dispatchEvent(event);
				return { ok: true, claimed: event.defaultPrevented };
			},
			{ sel: selector, init },
		);
		if (!result.ok) throw new ComposerMissingError(selector, await composerDiagnostics(page, selector));
		return { where: "composer", claimed: result.claimed };
	}
	const result = await page.evaluate(
		({ where, init }) => {
			const target =
				where === "plainfield"
					? document.querySelector(
							".gui-session-search input, .gui-settings-search input, input:not([data-chat-input] *)",
						)
					: document.body;
			if (!target) return { ok: false, reason: `no target: ${where}` };
			const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init });
			target.dispatchEvent(event);
			return { ok: true, claimed: event.defaultPrevented };
		},
		{ where, init },
	);
	if (!result.ok) throw new Error(result.reason ?? `no target: ${where}`);
	return { where, claimed: result.claimed };
}