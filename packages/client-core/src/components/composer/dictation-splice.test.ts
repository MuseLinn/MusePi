import { describe, expect, test } from "bun:test";
import { type DictationAnchor, dictationSplice, mergeDictationFinal } from "./dictation-splice";

/** The bug this covers: while dictating mid-draft, each committed segment was
 *  appended to the END of the whole draft while the volatile preview was
 *  painted at the CARET. Continuous speech therefore scattered its own words —
 *  the second phrase landed after the draft's tail instead of after the first
 *  phrase, and the preview (which follows the caret) then looked like it
 *  belonged to some other sentence. */
describe("dictation splicing", () => {
	test("keeps consecutive segments in spoken order at the caret", () => {
		const anchor: DictationAnchor = { text: "note:  here", start: 6, end: 6, committed: "" };
		// A committed segment joins `committed`; the hypothesis is repainted.
		const r1 = dictationSplice({ ...anchor, committed: "first phrase" }, "");
		expect(r1.value).toBe("note: first phrase here");
		const r2 = dictationSplice({ ...r1.next, committed: "first phrase second phrase" }, "");
		// The second phrase follows the first, NOT the draft's tail.
		expect(r2.value).toBe("note: first phrase second phrase here");
		expect(r2.value).not.toContain("here second");
	});

	test("a hypothesis replaces only itself, never the committed text", () => {
		const anchor: DictationAnchor = { text: "a: b", start: 3, end: 3, committed: "one " };
		const growing = dictationSplice(anchor, "two");
		expect(growing.value).toBe("a: one two b");
		const longer = dictationSplice(anchor, "two three");
		// Repainting the hypothesis must not stack the previous one.
		expect(longer.value).toBe("a: one two three b");
	});

	test("never swallows draft text that follows the caret", () => {
		const anchor: DictationAnchor = { text: "alpha tail", start: 6, end: 6, committed: "" };
		const r = dictationSplice(anchor, "spoken");
		// "tail" is user-authored; a splice that replaced to the end would delete it.
		expect(r.value).toBe("alpha spoken tail");
		expect(r.value.endsWith(" tail")).toBe(true);
	});

	test("replaces the region instead of appending on a retracted segment", () => {
		const anchor: DictationAnchor = { text: "start ", start: 6, end: 6, committed: "" };
		const first = dictationSplice(anchor, "one");
		const retracted = dictationSplice(first.next, "one");
		expect(retracted.value).toBe("start one");
	});
});

describe("merging the final answer", () => {
	test("takes the whole utterance when the final already contains it", () => {
		// The recognizer returns everything it heard; appending it again is how
		// the last phrase doubled.
		expect(mergeDictationFinal("first phrase ", "first phrase second phrase")).toBe("first phrase second phrase");
	});

	test("appends the remaining run exactly once", () => {
		expect(mergeDictationFinal("first phrase ", "second phrase")).toBe("first phrase second phrase");
	});

	test("keeps what is there when the final is empty", () => {
		// A finished dictation must not lose the words it already wrote: this is
		// the "stopped but only the preview text remains" report.
		expect(mergeDictationFinal("spoken", "")).toBe("spoken");
	});
});
