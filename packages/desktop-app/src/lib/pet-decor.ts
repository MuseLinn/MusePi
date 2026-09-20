/**
 * Companion decoration prefs — the builtin orb's optional surface detail.
 *
 * The mascot started with every layer the engine could draw switched ON:
 * a beacon mast on the crown, a gold hover-thrust glow under the ball, a
 * bounce light along its bottom edge, a ground shadow, plus the shell's
 * crown gloss / specular sweep / rim light. Several of those only make
 * sense for a body that LEVITATES over a floor — and the pet is nearly
 * always docked on the composer's edge, where there is no floor at all
 * (2026-09-20, user: 「头顶有个小呼吸点，嘴下方有个黄光…莫名其妙的复杂化」).
 *
 * So the decoration set is now a decision, not a default:
 *   - The floor family (thrust / bounce / ground) and the beacon mast are
 *     GONE — they were the "莫名其妙" layers, and no configuration makes a
 *     floor glow correct on an input card's edge.
 *   - The sphere's own surface shading (gloss + specular sweep) is the one
 *     layer that still earns its place in every context: it is what makes
 *     a flat dark circle read as a lit ball. It is therefore an opt-out
 *     switch rather than an opt-in — `gloss: false` flattens the shell to
 *     a plain silhouette for anyone who wants the quieter read.
 *
 * Storage is renderer-local (localStorage), same pattern as the pet's own
 * prefs in lib/pet.ts. Every window that renders the orb re-resolves on
 * `omp-pet-changed` / `storage`, so the settings toggle lands live in the
 * composer, the chat avatar and the floating desktop pet at once.
 *
 * Future accessories (notes, headphones, …) join this record as further
 * keys and are injected into `Silhouette` the same way — see
 * docs/gui-design.md §5l for the shape/accessory split.
 */

export const PET_DECOR_KEY = "musepi-gui-pet-decor";

/** Wearable accessories on the builtin orb (blobstudio's accessory slot,
 *  minimized: one pick, not a wardrobe). Drawn in orb-local coordinates by
 *  Silhouette — they scale with the ball and ride its body motion.
 *  - `note`       a gold eighth-note mark on the shell's upper right
 *  - `headphones` a band over the crown + a cup on each side */
export type PetAccessory = "none" | "note" | "headphones";

export const PET_ACCESSORIES: readonly PetAccessory[] = ["none", "note", "headphones"];

/** The decoration set, resolved. Add new accessory flags here. */
export interface PetDecor {
	/** Crown gloss + specular sweep on the shell. On by default — see the
	 *  module note: this is the layer that makes the ball read as lit. */
	gloss: boolean;
	/** The wearable accessory. `none` = bare orb. */
	accessory: PetAccessory;
}

/** Everything ON — the shape of a fresh install, and the resolve target
 *  for any key missing from storage. */
export const PET_DECOR_DEFAULT: PetDecor = { gloss: true, accessory: "none" };

/** Mirror of PetDecor for the settings UI: one switch per flag, so the
 *  appearance section can map over it instead of hand-writing rows.
 *  `accessory` is excluded — it is a pick-one segmented control, not a
 *  boolean row (see PetDecorSection). */
export const PET_DECOR_FLAGS: readonly {
	key: Exclude<keyof PetDecor, "accessory">;
	labelKey: string;
	descKey: string;
}[] = [{ key: "gloss", labelKey: "pet decor gloss", descKey: "pet decor gloss description" }];

/** Narrow a stored value into the accessory union — an unknown string
 *  (older build, hand-edited storage) falls back to `none`. */
function asAccessory(value: unknown): PetAccessory {
	return typeof value === "string" && (PET_ACCESSORIES as readonly string[]).includes(value)
		? (value as PetAccessory)
		: "none";
}

/** Resolve the stored decoration set. Unknown/garbled storage degrades to
 *  the defaults key-by-key rather than dropping the whole record — a
 *  malformed value must never blank the mascot. */
export function petDecor(): PetDecor {
	const out: PetDecor = { ...PET_DECOR_DEFAULT };
	let raw: string | null = null;
	try {
		raw = localStorage.getItem(PET_DECOR_KEY);
	} catch {
		return out;
	}
	if (!raw) return out;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return out;
		const rec = parsed as Record<string, unknown>;
		for (const key of Object.keys(PET_DECOR_DEFAULT) as (keyof PetDecor)[]) {
			const value = rec[key];
			if (key === "accessory") {
				out.accessory = asAccessory(value);
			} else if (typeof value === "boolean") {
				out[key] = value;
			}
		}
	} catch {
		// Unparseable — defaults already in `out`.
	}
	return out;
}

/** Persist one flag and notify every mounted orb. */
export function setPetDecorFlag(key: keyof PetDecor, value: boolean): void {
	try {
		localStorage.setItem(PET_DECOR_KEY, JSON.stringify({ ...petDecor(), [key]: value }));
	} catch {
		// Storage unavailable — the toggle is a no-op this session.
	}
	notifyPetDecorChanged();
}

/** Persist the accessory pick and notify every mounted orb. */
export function setPetAccessory(value: PetAccessory): void {
	try {
		localStorage.setItem(PET_DECOR_KEY, JSON.stringify({ ...petDecor(), accessory: value }));
	} catch {
		// Storage unavailable — the pick is a no-op this session.
	}
	notifyPetDecorChanged();
}

/** Broadcast to mounted renderers (the settings page is a different tree
 *  than the composer; a storage event alone would not reach it). */
export function notifyPetDecorChanged(): void {
	if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("omp-pet-changed"));
}
