/**
 * The large-paste gesture.
 *
 * The interaction it encodes: the first big paste lands inline (the user sees
 * what they pasted), and a second identical paste inside the window is the
 * signal that inline was not wanted — the text becomes an attachment. Every
 * case below is a way the gesture can misfire and either swallow a paste or
 * convert one the user wanted inline.
 */
import { describe, expect, it } from "bun:test";
import { isLargePlainTextPaste, LargeTextPasteGesture } from "../src/components/composer/large-text-paste";

const BIG = "x".repeat(3000);

function snapshot(value: string, selectionStart: number, selectionEnd = selectionStart) {
	return { value, selectionStart, selectionEnd };
}

describe("large paste detection", () => {
	it("counts a long single line as large", () => {
		expect(isLargePlainTextPaste("x".repeat(2500))).toBe(true);
	});

	it("counts many short lines as large", () => {
		expect(isLargePlainTextPaste("line\n".repeat(30))).toBe(true);
	});

	it("leaves a small paste alone", () => {
		expect(isLargePlainTextPaste("hello")).toBe(false);
		expect(isLargePlainTextPaste("")).toBe(false);
		expect(isLargePlainTextPaste("   \n  \n")).toBe(false);
	});
});

describe("large paste gesture", () => {
	it("lets the first big paste land normally", () => {
		const gesture = new LargeTextPasteGesture();
		const candidate = gesture.beginPaste(BIG, snapshot("", 0));
		// Nothing to act on yet: the paste is the user's to read.
		expect(candidate).toBeNull();
	});

	it("converts on a second identical paste inside the window", () => {
		const gesture = new LargeTextPasteGesture();
		// First paste: pending, then the browser inserts it.
		gesture.beginPaste(BIG, snapshot("", 0));
		gesture.change(snapshot(BIG, BIG.length));
		// Second identical paste: this is the signal.
		const candidate = gesture.beginPaste(BIG, snapshot(BIG, BIG.length), Date.now() + 100);
		expect(candidate).not.toBeNull();
		expect(candidate?.clipboardText).toBe(BIG);
	});

	it("ignores a second paste of DIFFERENT text", () => {
		const gesture = new LargeTextPasteGesture();
		gesture.beginPaste(BIG, snapshot("", 0));
		gesture.change(snapshot(BIG, BIG.length));
		const other = "y".repeat(3000);
		expect(gesture.beginPaste(other, snapshot(BIG, BIG.length), Date.now() + 100)).toBeNull();
	});

	it("ignores a second paste after the window closed", () => {
		const gesture = new LargeTextPasteGesture();
		gesture.beginPaste(BIG, snapshot("", 0));
		gesture.change(snapshot(BIG, BIG.length));
		// Two seconds later: a fresh intent, not a second paste of one intent.
		const candidate = gesture.beginPaste(BIG, snapshot(BIG, BIG.length), Date.now() + 2000);
		expect(candidate).toBeNull();
	});

	it("forgets the gesture when the user edits the text instead", () => {
		const gesture = new LargeTextPasteGesture();
		gesture.beginPaste(BIG, snapshot("", 0));
		// The caret moved and something else was inserted: the paste gesture is
		// over, and a later identical paste starts fresh.
		gesture.change(snapshot("something else entirely", 19));
		expect(gesture.beginPaste(BIG, snapshot("something else entirely", 19), Date.now() + 100)).toBeNull();
	});

	it("replaces the inline text with a citation once the attachment is ready", async () => {
		const gesture = new LargeTextPasteGesture();
		gesture.beginPaste(BIG, snapshot("", 0));
		gesture.change(snapshot(BIG, BIG.length));
		const candidate = gesture.beginPaste(BIG, snapshot(BIG, BIG.length), Date.now() + 100);
		const replaced: Array<{ from: number; to: number; citation: string }> = [];
		const ok = await gesture.convert(
			candidate!,
			async () => true,
			() => snapshot(BIG, BIG.length),
			(from, to, citation) => {
				replaced.push({ from, to, citation });
			},
			"[附件]",
		);
		expect(ok).toBe(true);
		expect(replaced).toEqual([{ from: 0, to: BIG.length, citation: "[附件]" }]);
	});

	it("leaves the text alone when the attachment could not be made", async () => {
		const gesture = new LargeTextPasteGesture();
		gesture.beginPaste(BIG, snapshot("", 0));
		gesture.change(snapshot(BIG, BIG.length));
		const candidate = gesture.beginPaste(BIG, snapshot(BIG, BIG.length), Date.now() + 100);
		let replaced = false;
		const ok = await gesture.convert(
			candidate!,
			async () => false, // the attachment failed
			() => snapshot(BIG, BIG.length),
			() => {
				replaced = true;
			},
			"[附件]",
		);
		expect(ok).toBe(false);
		expect(replaced).toBe(false);
	});

	it("leaves the text alone when the user edited it while the attachment was prepared", async () => {
		const gesture = new LargeTextPasteGesture();
		gesture.beginPaste(BIG, snapshot("", 0));
		gesture.change(snapshot(BIG, BIG.length));
		const candidate = gesture.beginPaste(BIG, snapshot(BIG, BIG.length), Date.now() + 100);
		let replaced = false;
		const ok = await gesture.convert(
			candidate!,
			async () => true,
			// The user typed in the meantime.
			() => snapshot(`${BIG} and more`, BIG.length + 9),
			() => {
				replaced = true;
			},
			"[附件]",
		);
		expect(ok).toBe(false);
		expect(replaced).toBe(false);
	});
});
