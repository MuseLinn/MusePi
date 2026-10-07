import { describe, expect, it } from "bun:test";
import {
	missingRequiredSlots,
	REQUIRED_TOKEN_SLOTS,
	resolveBorder,
	resolveToken,
	resolveTokenOrHost,
	TOKEN_SLOTS,
	tokenSlot,
	unknownTokenKeys,
} from "../src/design-tokens";

/**
 * The token vocabulary is what two independent readers share: the daemon turns a
 * design system into prompt text, the renderer turns the same system into a
 * preview card. They disagreed before this existed — the renderer carried its
 * own chain of `??` lookups against guessed keys, so a design system using a
 * key it had not heard of fell back to the host default and its card came out
 * looking like every other card.
 *
 * These cases pin the contract rather than the wording: which aliases collapse
 * into one slot, what a missing slot resolves to, and the two places where a
 * naive reading of a token's text produces CSS that does not mean what it says.
 */
describe("design system token vocabulary", () => {
	it("resolves one slot through whichever alias a design system used", () => {
		// The three built-ins that round corners each spell it differently, and
		// a fourth system will spell it a fourth way. The reader must not have
		// to know which spelling it is looking at.
		for (const key of ["--radius", "--radius-2xl", "--radius-xs"]) {
			expect(resolveToken({ [key]: "8px" }, "radius")).toBe("8px");
		}
	});

	it("prefers the more specific alias when a system declares two of them", () => {
		// `--bg` is the general surface and `--bg-inset` is a recessed one. A
		// system that declares both means the general one, so the order the
		// aliases are listed in is the contract.
		const tokens = { "--bg-inset": "recessed", "--bg": "surface" };
		expect(resolveToken(tokens, "background")).toBe("surface");
	});

	it("falls back to the host's own value rather than to nothing", () => {
		// A preview card drawn in the host's default colours still reads as "a
		// card"; one with no background at all renders as a transparent patch.
		expect(resolveTokenOrHost({}, "background")).toBe("var(--color-surface)");
		expect(resolveTokenOrHost({}, "foreground")).toBe("var(--color-text)");
		expect(resolveTokenOrHost({}, "radius")).toBe("6px");
	});

	it("leaves a slot absent when absence is the design decision", () => {
		// `border` and `font` have no host value on purpose: a borderless system
		// should stay borderless, and inventing a hairline would contradict it.
		expect(resolveTokenOrHost({}, "border")).toBeUndefined();
		expect(resolveTokenOrHost({}, "font")).toBeUndefined();
	});

	it("ignores an empty token rather than painting with it", () => {
		// A template or an import can leave a key present but blank. Treating
		// that as a declared value paints `background: ` and the card loses its
		// surface entirely.
		expect(resolveToken({ "--bg": "   " }, "background")).toBeUndefined();
		expect(resolveTokenOrHost({ "--bg": "" }, "background")).toBe("var(--color-surface)");
	});

	it("wraps a bare border colour but leaves a border shorthand alone", () => {
		// The two shapes both occur in the built-ins: three set a colour, one
		// sets `2px solid #1a1a1a`. Wrapping the shorthand produces a declaration
		// the browser drops, so the card silently loses its border.
		expect(resolveBorder({ "--border": "oklch(0 0 0 / 8%)" })).toBe("1px solid oklch(0 0 0 / 8%)");
		expect(resolveBorder({ "--border": "2px solid #1a1a1a" })).toBe("2px solid #1a1a1a");
		expect(resolveBorder({ "--border": "none" })).toBe("none");
		// A system that chose no border gets no declaration, not an empty one.
		expect(resolveBorder({})).toBeUndefined();
	});

	it("names the appearance slot a system must supply to be recognisable", () => {
		// A card that falls back on its surface is the host's own card, so a
		// system carrying no background reads as one that was never selected.
		// Text alone is enough, though: the glass systems set a translucent
		// surface and leave the foreground to the host on purpose, and a rule
		// that flagged that would stop being read as a rule.
		expect(REQUIRED_TOKEN_SLOTS).toEqual(["background"]);
		expect(missingRequiredSlots({ "--bg": "#fff" })).toEqual([]);
		expect(missingRequiredSlots({ "--fg": "#000" })).toEqual(["background"]);
		expect(missingRequiredSlots({})).toEqual(["background"]);
		// A system's own glass key counts as a background it supplied.
		expect(missingRequiredSlots({ "--glass-bg": "#fff" })).toEqual([]);
	});

	it("reports a key the vocabulary has not learned without refusing it", () => {
		// The ladder grows. A new key is not a registration error — it renders
		// nothing today — but it is the difference between "this token is
		// ignored" and "this token is spelled wrong", and only one of those is
		// the person's mistake.
		expect(unknownTokenKeys({ "--bg": "#fff", "--brand-gradient": "linear-gradient(red, blue)" })).toEqual([
			"--brand-gradient",
		]);
		expect(unknownTokenKeys({ "--bg": "#fff" })).toEqual([]);
	});

	it("gives every slot a name and an alias chain, with no role left unnamed", () => {
		for (const slot of TOKEN_SLOTS) {
			expect({ name: slot.name, keys: slot.keys.length > 0 }).toEqual({ name: slot.name, keys: true });
			expect(tokenSlot(slot.name)).toBe(slot);
		}
		// Every key the built-ins declare belongs to a declared slot. If a key is
		// missing from the vocabulary, a built-in's token resolves to nothing and
		// the vocabulary is incomplete rather than the built-in being wrong.
		const known = new Set(TOKEN_SLOTS.flatMap(slot => slot.keys));
		expect(known.has("--bg")).toBe(true);
		expect(known.has("--fg")).toBe(true);
		expect(known.has("--glass-bg")).toBe(true);
		expect(known.has("--radius-2xl")).toBe(true);
		expect(known.has("--font-ui")).toBe(true);
		expect(known.has("--accent-muted")).toBe(true);
		expect(known.has("--fg-muted")).toBe(true);
		expect(known.has("--blur-3xl")).toBe(true);
	});

	it("answers undefined for a role it does not declare rather than guessing", () => {
		// Typed callers cannot reach this, but the exported lookup takes a plain
		// string at runtime and must not invent a slot for it.
		expect(tokenSlot("nonexistent" as Parameters<typeof tokenSlot>[0])).toBeUndefined();
		expect(resolveToken({ "--bg": "#fff" }, "nonexistent" as Parameters<typeof resolveToken>[1])).toBeUndefined();
	});
});
