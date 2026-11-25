import { describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { advanceTail, EMPTY_TAIL, graphemeSpans } from "../src/tail-effect";

if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();

function host(): HTMLElement {
	const el = document.createElement("div");
	document.body.appendChild(el);
	return el;
}

/**
 * The streaming tail's per-character effect. What matters is that a character
 * animates exactly once: a growing tail appends only its delta, and a tail
 * replaced by the advancing markdown cut starts over instead of replaying the
 * characters already shown.
 */
describe("streaming tail effect", () => {
	it("appends one span per grapheme of the delta only", () => {
		const el = host();
		let state = advanceTail(el, "ab", "typewriter", EMPTY_TAIL);
		expect(el.querySelectorAll("span").length).toBe(2);

		state = advanceTail(el, "abc", "typewriter", state);
		// The earlier two are NOT re-created: only "c" was added.
		expect(el.querySelectorAll("span").length).toBe(3);
		expect(el.textContent).toBe("abc");
	});

	it("keeps newlines as text so a line break is not a span", () => {
		const el = host();
		advanceTail(el, "a\nb", "typewriter", EMPTY_TAIL);
		expect(el.textContent).toBe("a\nb");
		expect(el.querySelectorAll("span").length).toBe(2);
	});

	it("starts over when the cut advanced and does not replay", () => {
		const el = host();
		let state = advanceTail(el, "first tail", "typewriter", EMPTY_TAIL);
		expect(el.querySelectorAll("span").length).toBe(10);

		// A balanced blank line moved the old tail into the markdown head: the new
		// tail is unrelated text, so the container is cleared first.
		state = advanceTail(el, "new", "typewriter", state);
		expect(el.textContent).toBe("new");
		expect(el.querySelectorAll("span").length).toBe(3);
	});

	it("adds no spans for the shimmer preset", () => {
		const el = host();
		advanceTail(el, "abc", "shimmer", EMPTY_TAIL);
		expect(el.querySelectorAll("span").length).toBe(0);
		expect(el.textContent).toBe("abc");
	});

	it("counts a grapheme cluster as one character", () => {
		// Family emoji + combining accent: one visible character each.
		expect(graphemeSpans("👨‍👩‍👧").length).toBe(1);
		expect(graphemeSpans("e\u0301").length).toBe(1);
		expect(graphemeSpans("ab").length).toBe(2);
	});
});
