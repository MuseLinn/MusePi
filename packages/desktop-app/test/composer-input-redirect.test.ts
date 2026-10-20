/**
 * Type-anywhere redirect: which events land in the composer.
 *
 * The value of this feature is entirely in what it declines to steal, so the
 * cases below are mostly negatives. Each is a way the naive version breaks the
 * app in a way users would report as "typing stopped working here":
 *
 *  - a focused button where Space is a press;
 *  - a settings dialog where typing belongs to its field;
 *  - a selected paragraph where typing starts an annotation;
 *  - an IME composition that is mid-word.
 */
import "./happy-dom-shim"; // MUST be first: installs the DOM globals.
import { beforeEach, describe, expect, it } from "bun:test";
import {
	findComposerTextarea,
	isComposerRedirectTarget,
	redirectKeyToComposer,
	redirectPasteToComposer,
} from "../src/lib/composer-input-redirect";

function textarea(): HTMLTextAreaElement {
	return document.querySelector<HTMLTextAreaElement>("textarea[data-composer-input]")!;
}

beforeEach(() => {
	document.body.innerHTML = `
		<div class="gui-chat-body">
			<div class="gui-transcript" id="transcript">some transcript text</div>
			<textarea data-composer-input=""></textarea>
			<button id="btn">send</button>
			<input id="field" />
		</div>`;
	// happy-dom has no layout; a zero-rect element reads as "not on screen" and
	// the redirect would skip it, so every fixture element must report a rect.
	for (const el of document.querySelectorAll(".gui-chat-body *")) {
		(el as unknown as { getClientRects: () => { length: number }[] }).getClientRects = () => [{ length: 1 }];
	}
});

function key(init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent {
	return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
}

describe("composer input redirect", () => {
	it("lands a printable key in the composer when nothing is focused", () => {
		const event = key({ key: "h" });
		document.getElementById("transcript")!.dispatchEvent(event);
		expect(redirectKeyToComposer(event)).toBe(true);
		expect(textarea().value).toBe("h");
	});

	it("leaves a focused control's own keys alone", () => {
		// Space on a focused button is a press; stealing it would make the
		// keyboard unusable with a screen reader or a keyboard-only user.
		const event = key({ key: " " });
		document.getElementById("btn")!.dispatchEvent(event);
		expect(redirectKeyToComposer(event)).toBe(false);
		expect(textarea().value).toBe("");
	});

	it("leaves a text field's input alone", () => {
		const event = key({ key: "x" });
		document.getElementById("field")!.dispatchEvent(event);
		expect(redirectKeyToComposer(event)).toBe(false);
	});

	it("ignores modifier chords, which are app shortcuts", () => {
		const event = key({ key: "k", metaKey: true });
		document.getElementById("transcript")!.dispatchEvent(event);
		expect(redirectKeyToComposer(event)).toBe(false);
	});

	it("ignores a mid-composition keystroke", () => {
		// Stealing a key during IME composition loses the character.
		const event = new KeyboardEvent("keydown", { key: "あ", bubbles: true, cancelable: true, isComposing: true });
		document.getElementById("transcript")!.dispatchEvent(event);
		expect(redirectKeyToComposer(event)).toBe(false);
	});

	it("declines while a floating layer is up", () => {
		// A dialog owns the keyboard; its field may not be focused yet.
		const dialog = document.createElement("div");
		dialog.setAttribute("role", "dialog");
		(dialog as unknown as { getClientRects: () => { length: number }[] }).getClientRects = () => [{ length: 1 }];
		document.body.appendChild(dialog);
		const event = key({ key: "a" });
		document.getElementById("transcript")!.dispatchEvent(event);
		expect(redirectKeyToComposer(event)).toBe(false);
	});

	it("appends to the end of the existing draft instead of replacing it", () => {
		textarea().value = "hello ";
		const event = key({ key: "w" });
		document.getElementById("transcript")!.dispatchEvent(event);
		expect(redirectKeyToComposer(event)).toBe(true);
		expect(textarea().value).toBe("hello w");
	});

	it("finds no composer when the session textarea is off screen", () => {
		(textarea() as unknown as { getClientRects: () => unknown[] }).getClientRects = () => [];
		expect(findComposerTextarea()).toBeNull();
	});

	it("reports a redirect target only when the event is still preventable", () => {
		const event = key({ key: "z" });
		event.preventDefault();
		expect(isComposerRedirectTarget(event)).toBe(false);
	});

	it("does not treat a paste as a redirect target when a field is focused", () => {
		const data = new DataTransfer();
		data.setData("text/plain", "pasted");
		const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
		document.getElementById("field")!.dispatchEvent(event);
		// The field keeps it; nothing is replayed into the composer.
		expect(redirectPasteToComposer(event)).toBe(false);
		expect(textarea().value).toBe("");
	});
});
