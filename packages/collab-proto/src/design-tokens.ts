/**
 * The token vocabulary a design system may use, and what each slot means.
 *
 * A design system contributes a fragment of the host's own token ladder, and
 * every place that reads it — the hover preview's mini mock, the prompt brief —
 * needs to agree on which keys are optional and what stands in for a missing
 * one. The preview used to carry that knowledge privately, as a chain of `??`
 * lookups against a handful of guessed keys: a token nobody listed was
 * indistinguishable from one meant to be absent, and introducing a design system
 * with a new key meant editing a component to teach it that key.
 *
 * This is that knowledge, declared once. Slots are named rather than numbered,
 * and each resolves through its own alias chain, so two design systems can name
 * one slot with different keys — `--radius`, `--radius-2xl` and `--radius-xs`
 * are all "the corner radius" — without a reader having to know either in
 * advance.
 *
 * It lives here rather than beside the registry because both sides need it: the
 * daemon resolves a system when composing the prompt, the renderer resolves one
 * when drawing the preview card. `collab-proto` is the one package both already
 * depend on, and where the extension-slot vocabulary it parallels already sits.
 *
 * Why there is a requirement at all rather than "every key is optional": a mock
 * that falls back to the host default throughout draws five identical cards,
 * and the preview is the only place a person sees what they are about to pick.
 * So a system is asked for at least one appearance slot. Every built-in
 * satisfies it; an extension that does not is one whose card would look like
 * the others.
 *
 * @module design-tokens
 */

/** Slot identity, so callers refer to a role rather than to a key. */
export type TokenSlotName = "background" | "foreground" | "border" | "radius" | "font" | "accent" | "muted" | "blur";

/** A slot in the token vocabulary: the names a design system may use for it. */
export interface TokenSlot {
	/**
	 * Accepted keys, most specific first. Resolution takes the first the design
	 * system actually declares, which is what lets two systems express the same
	 * slot with different names (`--radius` and `--radius-2xl` are both "the
	 * corner radius") without the reader knowing either in advance.
	 */
	readonly keys: readonly string[];
	/**
	 * What the host renders when no alias is declared. `null` means the slot has
	 * no host value and the caller must omit the property entirely — emitting a
	 * literal fallback there would paint something the design system never asked
	 * for.
	 */
	readonly hostFallback: string | null;
	/** Rendered on the mini mock, and named in the prompt brief. */
	readonly purpose: string;
	/**
	 * What the slot's value is allowed to be.
	 *
	 * Most slots are a bare value of one kind, which cannot be checked by
	 * reading for a prefix — the colour ladder spans `oklch()`, hex and named
	 * colours, and a system may use any of them. `color-or-shorthand` is the
	 * exception, and it exists because built-ins genuinely disagree: three set a
	 * border colour and one sets `2px solid #1a1a1a`. Wrapping the shorthand
	 * again — `1px solid ${value}` — produces a declaration the browser drops, so
	 * the caller has to be able to tell the two apart per value.
	 */
	readonly valueKind: "color" | "length" | "font" | "color-or-shorthand";
}

/**
 * The vocabulary.
 *
 * Key names are the host ladder's, not this file's invention: a design system
 * overrides a variable the stylesheet already defines, so a name outside the
 * ladder would be a token nothing reads.
 *
 * Each entry names its own role, so the name and the slot cannot drift apart —
 * an earlier shape kept the roles in a parallel array beside this one, which
 * put a slot's identity one index away from its definition.
 */
export const TOKEN_SLOTS: readonly (TokenSlot & { readonly name: TokenSlotName })[] = [
	{
		name: "background",
		valueKind: "color",
		// The glass systems carry a second, more opaque surface for the panels
		// that sit on top of the first. It resolves as the surface — the mock
		// paints one card — so it is an alias rather than a slot of its own.
		keys: ["--bg", "--glass-bg", "--bg-raised", "--bg-inset", "--glass-bg-strong"],
		hostFallback: "var(--color-surface)",
		purpose: "the surface a card or page is painted on",
	},
	{
		name: "foreground",
		valueKind: "color",
		keys: ["--fg"],
		hostFallback: "var(--color-text)",
		purpose: "text and any mark that reads against the surface",
	},
	{
		name: "border",
		keys: ["--border", "--glass-border"],
		// Either a bare colour, which the caller wraps into a hairline, or a
		// complete `border` shorthand, which it must not. Built-ins do both —
		// three set a colour, one sets `2px solid #1a1a1a` — so the caller decides
		// per value rather than the slot deciding for it.
		valueKind: "color-or-shorthand",
		// Borderless is a real design decision rather than a missing value, so
		// the fallback is "draw nothing" rather than a grey line.
		hostFallback: null,
		purpose: "the hairline that separates one region from the next",
	},
	{
		name: "radius",
		valueKind: "length",
		keys: ["--radius", "--radius-2xl", "--radius-xs"],
		hostFallback: "6px",
		purpose: "corner rounding",
	},
	{
		name: "font",
		valueKind: "font",
		keys: ["--font-ui"],
		hostFallback: null,
		purpose: "the face text is set in",
	},
	{
		name: "accent",
		valueKind: "color",
		keys: ["--accent", "--accent-muted"],
		hostFallback: "var(--color-accent)",
		purpose: "the one colour that marks an action or a highlight",
	},
	{
		name: "muted",
		valueKind: "color",
		keys: ["--fg-muted"],
		hostFallback: "var(--color-text-muted)",
		purpose: "secondary text: captions, labels, timestamps",
	},
	{
		name: "blur",
		valueKind: "length",
		// Only the glass system declares one, and only the glass system needs
		// it — but a key no slot owns is a key `unknownTokenKeys` reports on every
		// load, which trains the reader to ignore that report.
		keys: ["--blur-3xl", "--glass-blur"],
		hostFallback: null,
		purpose: "how far a translucent surface is blurred from what is behind it",
	},
];

/**
 * Slots without which a design system's card would be indistinguishable.
 *
 * One, not two. A system that sets a surface is enough to read at a glance: the
 * glass systems set a translucent one and leave text to the host, and a
 * translucent surface over a known backdrop still reads as glass. Requiring a
 * foreground as well would have flagged that as incomplete when it is a
 * deliberate choice — and a rule that flags a deliberate choice stops being
 * read as a rule at all.
 *
 * A system that declares neither has nothing to show, and its card comes out
 * looking like the host's own.
 */
export const REQUIRED_TOKEN_SLOTS: readonly TokenSlotName[] = ["background"];

const SLOTS_BY_NAME: ReadonlyMap<TokenSlotName, TokenSlot> = new Map(TOKEN_SLOTS.map(slot => [slot.name, slot]));

/** The slot a role names, or undefined for a role this vocabulary omits. */
export function tokenSlot(name: TokenSlotName): TokenSlot | undefined {
	return SLOTS_BY_NAME.get(name);
}

/**
 * The first alias a design system declares for a slot.
 *
 * @returns the declared key, or `undefined` when the system declares none of
 * them — which is a valid answer for every slot except a required one.
 */
export function resolveToken(tokens: Readonly<Record<string, string>>, name: TokenSlotName): string | undefined {
	const slot = SLOTS_BY_NAME.get(name);
	if (!slot) return undefined;
	for (const key of slot.keys) {
		const value = tokens[key];
		if (typeof value === "string" && value.trim() !== "") return value;
	}
	return undefined;
}

/**
 * A declared value, or the host's own.
 *
 * `undefined` rather than a literal for the slots whose fallback is "draw
 * nothing", so the caller can leave the CSS property out instead of writing a
 * value the design system never chose.
 */
export function resolveTokenOrHost(tokens: Readonly<Record<string, string>>, name: TokenSlotName): string | undefined {
	const declared = resolveToken(tokens, name);
	if (declared !== undefined) return declared;
	return SLOTS_BY_NAME.get(name)?.hostFallback ?? undefined;
}

/**
 * Whether a design system declares enough to be recognisable at a glance.
 *
 * Returns the slots it is missing rather than a bare boolean, so a caller
 * registering an extension can say which one rather than refusing a card that
 * renders.
 */
export function missingRequiredSlots(tokens: Readonly<Record<string, string>>): TokenSlotName[] {
	return REQUIRED_TOKEN_SLOTS.filter(name => resolveToken(tokens, name) === undefined);
}

/**
 * A `border` declaration for the mock, or `undefined` for none.
 *
 * Separate from {@link resolveTokenOrHost} because this is the one slot whose
 * value may already be a complete declaration: the built-ins split three-to-one
 * between a colour and `2px solid #1a1a1a`, so the shape has to be read off the
 * value rather than assumed from the slot.
 */
export function resolveBorder(tokens: Readonly<Record<string, string>>): string | undefined {
	const declared = resolveToken(tokens, "border");
	if (declared === undefined) return undefined;
	// A shorthand carries its own width and style; anything else is a colour that
	// needs the hairline wrapped around it. The test is what is absent: a bare
	// colour — hex, `rgb()`, `oklch()`, a named colour — has no `solid`.
	return /\bsolid\b|\bnone\b|\bhidden\b/.test(declared) ? declared : `1px solid ${declared}`;
}

/**
 * Token keys outside the vocabulary.
 *
 * Not an error: the ladder grows, and a design system may legitimately set a
 * key this file has not learned about yet. It is reported so the gap is
 * visible — a key nothing reads renders as nothing, which looks like the token
 * was ignored rather than misspelled.
 */
export function unknownTokenKeys(tokens: Readonly<Record<string, string>>): string[] {
	const known = new Set(TOKEN_SLOTS.flatMap(slot => slot.keys));
	return Object.keys(tokens).filter(key => !known.has(key));
}
