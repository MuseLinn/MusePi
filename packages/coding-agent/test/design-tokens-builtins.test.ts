import { describe, expect, it } from "bun:test";
import { missingRequiredSlots, unknownTokenKeys } from "@musepi/collab-proto/design-tokens";
import { BUILTIN_DESIGN_SYSTEMS } from "@musepi/pi-coding-agent/presets/design-systems";

/**
 * The token vocabulary lives in `collab-proto` because both sides need it; the
 * table it describes lives here. So the two are maintained apart, and the token
 * ladder grows over time — each can gain a key the other has not heard of.
 *
 * That is fine in principle, since a key nothing reads renders as nothing, but
 * it is exactly the failure this check exists to catch because it is
 * invisible: the card renders, just not in the design system's own colours.
 * Hence running over the shipped data rather than over fixtures — a failure
 * here means a design system a person can select today says something the
 * reader cannot act on.
 */
describe("built-in design systems against the token vocabulary", () => {
	it("leaves no built-in with a key the vocabulary does not own", () => {
		// The one allowed exception is a key a system deliberately sets beyond the
		// card's vocabulary — it still renders in whatever surface the system is
		// applied to, just not on the preview mock. Reporting is enough; failing
		// on it would mean refusing a design system that works.
		const unclaimed = BUILTIN_DESIGN_SYSTEMS.flatMap(system =>
			unknownTokenKeys(system.tokens).map(key => `${system.id}: ${key}`),
		);
		expect(unclaimed).toEqual([]);
	});

	it("gives every built-in enough tokens for its card to be recognisable", () => {
		const incomplete = BUILTIN_DESIGN_SYSTEMS.filter(system => missingRequiredSlots(system.tokens).length > 0).map(
			system => `${system.id} lacks ${missingRequiredSlots(system.tokens).join(", ")}`,
		);
		expect(incomplete).toEqual([]);
	});

	it("gives every built-in a card that differs from every other", () => {
		// Five cards that all fall back to the host surface are five copies of
		// the same card, and the preview is the only place the choice is visible.
		// Comparing the two slots that decide a card's appearance is enough: a
		// pair of systems sharing both is a pair of identical previews.
		const signatures = BUILTIN_DESIGN_SYSTEMS.map(system => ({
			id: system.id,
			signature: `${system.tokens["--bg"] ?? ""}|${system.tokens["--glass-bg"] ?? ""}|${system.tokens["--fg"] ?? ""}`,
		}));
		const unique = new Set(signatures.map(entry => entry.signature));
		expect(unique.size).toBe(signatures.length);
	});
});
