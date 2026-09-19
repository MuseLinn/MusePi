import { describe, expect, test } from "bun:test";
import { tuiOnlySettingKeys } from "../src/config/settings-schema";

/**
 * Regression for issue #40: the GUI-session system prompt enumerated every
 * `ui.tuiOnly` setting path (~40 keys, ~250 tokens) on every single request.
 *
 * The enumeration was cut from the daemon's prompt note — the agent has no
 * use for a negative list of desktop-GUI software's terminal-only keys, and
 * the GUI already badges those rows from the schema flag. `tuiOnlySettingKeys`
 * survives as the single source of truth for "which settings are TUI-only",
 * so this suite guards the invariant the note used to rest on: the set is
 * non-trivial (flagging still works) and stays a pure schema derivation.
 */

describe("issue #40 — TUI-only settings list", () => {
	test("the flag still marks a substantial set (the note's old payload)", () => {
		// If this ever drops to ~0 the enumeration was never the problem and
		// the flag itself has rotted — either way the assumption behind
		// cutting the note needs revisiting.
		expect(tuiOnlySettingKeys().length).toBeGreaterThan(30);
	});

	test("known terminal-only families are present", () => {
		const keys = tuiOnlySettingKeys();
		for (const prefix of ["theme.", "statusLine.", "terminal.", "tui."]) {
			expect(keys.some(k => k.startsWith(prefix))).toBe(true);
		}
	});

	test("derivation is deterministic across calls", () => {
		// No mutation, no memoised state — the schema is the only input.
		expect(tuiOnlySettingKeys()).toEqual(tuiOnlySettingKeys());
	});

	test("the old enumeration would have cost real tokens", () => {
		// Guards the premise of the fix, not the fix itself: ~40 paths joined
		// is a few hundred tokens per request, forever.
		const joined = tuiOnlySettingKeys().join(", ");
		expect(joined.length).toBeGreaterThan(300);
	});
});
