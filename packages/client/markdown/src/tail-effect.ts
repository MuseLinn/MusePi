/**
 * The streaming tail's per-grapheme entrance effect.
 *
 * The tail is the region of a reply that has not yet taken markdown shape (see
 * the pipeline's `renderStreamingMarkdown`): it renders as plain text, and this
 * module is what turns each NEW grapheme into its own span so the effect plays
 * exactly once for that character.
 *
 * Two properties matter and are both about not replaying:
 *
 * - The container is stable. The caller mounts one element and never rebuilds
 *   its children; React owns the element, not its contents.
 * - Append-only growth. A growing tail appends only the delta; when the tail is
 *   replaced wholesale (a balanced `\n\n` advanced the cut, so the previous tail
 *   moved into the markdown head) the container is cleared first, and
 *   already-shown characters are not re-animated.
 */

/** Grapheme iteration for the effect. Splitting by code point keeps emoji and
 *  combining marks whole, which is what makes one "character" one span. */
export interface Grapheme {
	/** The grapheme itself (one visible character, possibly several code units). */
	word: string;
}

const segmenter =
	typeof Intl !== "undefined" && "Segmenter" in Intl
		? new Intl.Segmenter(undefined, { granularity: "grapheme" })
		: null;

/** Split text into grapheme clusters (falls back to code points). */
export function graphemeSpans(text: string): Grapheme[] {
	if (text === "") return [];
	const out: Grapheme[] = [];
	if (segmenter) {
		for (const { segment } of segmenter.segment(text)) out.push({ word: segment });
		return out;
	}
	for (const word of Array.from(text)) out.push({ word });
	return out;
}

/** The effect presets a tail can carry. `shimmer` is a root-level CSS sweep and
 *  deliberately adds no per-character spans. */
export type TailEffect = "typewriter" | "burst" | "glitch" | "flip" | "ink" | "shimmer";

function effectClass(effect: TailEffect): string {
	return effect === "typewriter" ? "tr-char tr-char--typewriter" : `tr-char tr-char--${effect}`;
}

/** What the container currently holds; the caller keeps it across renders. */
export interface TailState {
	readonly appended: string;
}

export const EMPTY_TAIL: TailState = { appended: "" };

/**
 * Bring `container` up to `target` and return the state to keep for the next
 * call. Appends only the delta; clears first when the tail was replaced.
 */
export function advanceTail(
	container: HTMLElement,
	target: string,
	effect: TailEffect,
	previous: TailState,
	doc: Document = document,
): TailState {
	if (target === previous.appended) return previous;

	if (!target.startsWith(previous.appended)) {
		// The cut advanced, so the previous tail became part of the markdown
		// head and this tail is unrelated text: start over without replaying.
		container.textContent = "";
		previous = EMPTY_TAIL;
	}

	const delta = target.slice(previous.appended.length);
	if (delta === "") return previous;

	const fragment = doc.createDocumentFragment();
	if (effect === "shimmer") {
		// A root-level sweep: text, not spans.
		fragment.appendChild(doc.createTextNode(delta));
	} else {
		const className = effectClass(effect);
		for (const { word } of graphemeSpans(delta)) {
			if (word === "\n") {
				fragment.appendChild(doc.createTextNode("\n"));
				continue;
			}
			const span = doc.createElement("span");
			span.className = className;
			span.textContent = word;
			fragment.appendChild(span);
		}
	}
	container.appendChild(fragment);
	return { appended: target };
}
