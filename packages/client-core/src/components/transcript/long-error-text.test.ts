import { describe, expect, test } from "bun:test";
import { getLongErrorPreview } from "./long-error-text";

/**
 * The collapse rule decides how much of a provider failure the transcript holds at
 * once. Each case names what a reader would see if the rule regressed.
 */
describe("getLongErrorPreview", () => {
	test("leaves a short error whole", () => {
		// The common case must render in full: folding a one-line 429 would hide the
		// reason behind a click for no saving.
		expect(getLongErrorPreview("429 insufficient balance, top up required")).toBeNull();
	});

	test("treats the threshold as inclusive", () => {
		// One character either side of the rule decides whether the user has to
		// click, so both sides are pinned rather than left to the comparison's mood.
		expect(getLongErrorPreview("x".repeat(1_000))).toBeNull();
		expect(getLongErrorPreview("x".repeat(1_001))).not.toBeNull();
	});

	test("caps the preview by characters, not by lines", () => {
		// A provider body is usually one enormous line. Capping lines alone would let
		// a 200k-character row through, filling the transcript on its own.
		const preview = getLongErrorPreview("y".repeat(50_000));

		expect(preview).not.toBeNull();
		expect(preview?.length).toBe(401);
		expect(preview?.endsWith("…")).toBe(true);
	});

	test("caps the preview by lines when the body has them", () => {
		// A multi-line dump is capped at six lines so the fold button stays visible
		// without scrolling past it.
		const preview = getLongErrorPreview(`${"line\n".repeat(400)}tail`);

		expect(preview).not.toBeNull();
		expect(preview?.split("\n")).toHaveLength(6);
	});

	test("never splits a surrogate pair", () => {
		// A cut between the halves of an emoji or rare CJK character renders as a
		// replacement glyph, which is visible corruption of the provider's own text.
		const body = `${"a".repeat(399)}😀${"b".repeat(2_000)}`;
		const preview = getLongErrorPreview(body);

		expect(preview).not.toBeNull();
		// The pair moved fully to the detail side rather than being cut in half.
		expect(preview).not.toContain("\uFFFD");
		expect([...(preview ?? "")].every(ch => ch.codePointAt(0)! < 0xd800 || ch.codePointAt(0)! > 0xdfff)).toBe(true);
	});

	test("trims trailing whitespace before the ellipsis", () => {
		// A newline left dangling before the ellipsis reads as a blank line inside the
		// preview, which looks like a rendering fault rather than a fold.
		const preview = getLongErrorPreview(`${"z".repeat(1_050)}\n\n`);

		expect(preview).not.toBeNull();
		expect(preview?.endsWith("…")).toBe(true);
		expect(preview?.endsWith(" \u2026")).toBe(false);
	});
});
