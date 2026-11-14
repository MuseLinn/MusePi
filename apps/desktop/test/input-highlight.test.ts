import "./dom-shim";
import { describe, expect, test } from "bun:test";
import { parseHighlightSpans } from "../src/components/composer/input-highlight";

/**
 * Contract (TUI editor parity): the overlay paints ONLY live syntax —
 * line-leading slash commands, line-leading shell bangs (!/!!) and
 * standalone magic keywords. Everything else stays plain so the pill is
 * a promise about what send will actually do; any glyph-advance change
 * would desync the caret (see gui-composer.css .gui-ta-hl-*).
 *
 * `resolveMention` is the host's live-chip resolver — these cases pass a
 * never-resolving one: no chip, so no `@` text is ever a mention here.
 */
const noChips = (): null => null;

describe("parseHighlightSpans", () => {
	test("line-leading slash command", () => {
		expect(parseHighlightSpans("/security now", noChips)).toEqual([{ start: 0, end: 9, kind: "slash" }]);
	});

	test("mid-text slashes stay plain — they are args of the first command, not commands", () => {
		// The user-reported case: "/security /guided-goal /security" — the
		// daemon's parseSlashCommand takes the FIRST token as the name and
		// the rest as args, so only the head token is live syntax.
		expect(parseHighlightSpans("/security /guided-goal /security", noChips)).toEqual([
			{ start: 0, end: 9, kind: "slash" },
		]);
	});

	test("escaped // stays plain", () => {
		expect(parseHighlightSpans("//not-a-command", noChips)).toEqual([]);
	});

	test("subsequent lines carry their own leading slash", () => {
		expect(parseHighlightSpans("intro\n/btw", noChips)).toEqual([{ start: 6, end: 10, kind: "slash" }]);
	});

	test("standalone magic words anywhere; prose boundaries respected", () => {
		expect(parseHighlightSpans("a ultrathink!", noChips)).toEqual([{ start: 2, end: 12, kind: "magic" }]);
		expect(parseHighlightSpans("foo.ultrathink", noChips)).toEqual([]);
	});

	test("slash wins over a magic word inside the command token", () => {
		expect(parseHighlightSpans("/ultrathink", noChips)).toEqual([{ start: 0, end: 11, kind: "slash" }]);
	});

	test("line-leading bang (and !!) wraps the shell head", () => {
		expect(parseHighlightSpans("!ls -la", noChips)).toEqual([{ start: 0, end: 3, kind: "bang" }]);
		expect(parseHighlightSpans("!!make test", noChips)).toEqual([{ start: 0, end: 6, kind: "bang" }]);
		// "! cmd" executes too (the send path trims the body) — the pill
		// covers the inner whitespace.
		expect(parseHighlightSpans("! cmd", noChips)).toEqual([{ start: 0, end: 5, kind: "bang" }]);
	});

	test("mid-text bang stays plain", () => {
		expect(parseHighlightSpans("hi !ls", noChips)).toEqual([]);
	});

	test("bang wins over a magic word inside the shell token", () => {
		expect(parseHighlightSpans("!!workflowz", noChips)).toEqual([{ start: 0, end: 11, kind: "bang" }]);
	});
});
