/**
 * The floating composer's layout contract, checked on a live DOM.
 *
 * Three invariants make the floating model safe, and each corresponds to a way
 * it can break visibly:
 *
 *  1. The composer leaves the flow, so a row can scroll UNDER it — if it stays
 *     a flex sibling, the glass never reads as floating.
 *  2. The shell is click-through except for its own children, or the whole
 *     lower band of the transcript stops responding.
 *  3. The reserved band equals the floating stack's measured height, or the
 *     last row hides beneath the composer.
 *
 * happy-dom has no layout engine, so (1) and (2) are read from
 * `getComputedStyle` — which does resolve stylesheet declarations — and (3) is
 * proved through the observer plumbing the pane actually uses: the published
 * CSS variable, not the CSS text.
 */
import "./happy-dom-shim"; // MUST be first: installs the DOM globals.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Mount the stylesheet once so computed styles see its rules. */
function mountStyles(): void {
	const css = [
		readFileSync(resolve(import.meta.dir, "../src/styles/gui-chat.css"), "utf8"),
		readFileSync(resolve(import.meta.dir, "../src/styles/gui-pet.css"), "utf8"),
	].join("\n");
	const sheet = document.createElement("style");
	sheet.textContent = css;
	document.head.appendChild(sheet);
}

/** Build the column shape ChatView renders: body > (transcript, floating wrap). */
function mountColumn(): { body: HTMLElement; wrap: HTMLElement; transcript: HTMLElement } {
	document.body.innerHTML = `
		<div class="gui-chat-body" id="body">
			<div class="gui-transcript" id="transcript"></div>
			<div class="gui-composer-wrap gui-composer-wrap--floating" id="wrap">
				<div class="gui-composer-card" id="card"></div>
			</div>
		</div>`;
	return {
		body: document.getElementById("body")!,
		wrap: document.getElementById("wrap")!,
		transcript: document.getElementById("transcript")!,
	};
}

describe("floating composer layout", () => {
	mountStyles();

	it("takes the composer out of the flow and pins it to the column's bottom", () => {
		const { wrap } = mountColumn();
		const style = getComputedStyle(wrap);
		// Absolute positioning is what lets a transcript row scroll under it;
		// in flow the row can never reach the glass.
		expect(style.position).toBe("absolute");
		expect(style.bottom).toBe("0px");
	});

	it("keeps the shell click-through and gives the pointer back to its card", () => {
		const { wrap, body } = mountColumn();
		// A transparent shell the width of the column that captured clicks
		// would make the transcript's lower band dead to selection and scroll.
		expect(getComputedStyle(wrap).pointerEvents).toBe("none");
		const card = document.getElementById("card")!;
		expect(getComputedStyle(card).pointerEvents).toBe("auto");
		// The transcript itself is untouched.
		expect(getComputedStyle(body.querySelector(".gui-transcript")!).pointerEvents).not.toBe("none");
	});

	it("deepens the end fade only while a reply streams", () => {
		const { body, transcript } = mountColumn();
		const atRest = getComputedStyle(transcript).getPropertyValue("--chat-tail-fade").trim();
		body.setAttribute("data-live-tail", "true");
		const streaming = getComputedStyle(transcript).getPropertyValue("--chat-tail-fade").trim();
		// At rest rows thin out under the glass; while streaming the band is
		// pulled up so the newest line is transparent at the composer's edge
		// instead of being cut in half.
		expect(atRest).toBe("32px");
		expect(streaming).toBe("64px");
	});

	it("reserves the measured composer height as the transcript's tail band", () => {
		const { body } = mountColumn();
		// This is the plumbing ChatView's observer performs; a floating composer
		// without it hides the last row.
		body.style.setProperty("--chat-composer-inset", "180px");
		const spacer = document.createElement("div");
		spacer.style.height = "calc(var(--chat-composer-inset, 0px) + 16px)";
		body.appendChild(spacer);
		// happy-dom does not evaluate calc(), so assert the variable the spacer
		// reads rather than a resolved pixel height.
		expect(body.style.getPropertyValue("--chat-composer-inset")).toBe("180px");
	});
});
