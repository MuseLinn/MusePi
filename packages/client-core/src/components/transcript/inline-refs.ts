/**
 * Inline attachment references inside a stored user message.
 *
 * The send path rewrites a composer mention into plain text before the message
 * is stored: `@图片1` becomes `[图片 1]`, `@文件1` becomes
 * `[Attachment:name]`. The model needs exactly those strings — the ordinal
 * points at the Nth image block, the name points at the blob — so the stored
 * text keeps them. The transcript, however, should not show a reader the
 * plumbing: this module finds those runs so the renderer can draw a chip in
 * their place, the same way the composer draws one while typing.
 *
 * Both forms are anchored on the bracket that opens them. `[图片 1]` requires
 * the space, so a model's own prose about 图片 is not swallowed; the
 * `[Attachment:…]` form never matches the `[Attachment] blob://…` reference
 * LINE, which is handled separately and lifted out of the body entirely.
 */

export type InlineRefKind = "image" | "file";

export interface InlineRef {
	start: number;
	end: number;
	kind: InlineRefKind;
	/** What the chip shows: the ordinal label, or the attached file's name. */
	label: string;
}

/** `[图片 N]` and `[图片:name]` (the legacy name form). */
const IMAGE_REF = /\[图片 ?([1-9]\d*)\]|\[图片:(.+?)\]/g;
/** `[Attachment:name]` — an `@file` expansion. Name is greedy: it may hold brackets. */
const FILE_REF = /\[Attachment:(.+?)\]/g;

/** Every inline reference in `text`, in scan order. Overlaps cannot occur: the
 *  two patterns start with different words. */
export function parseInlineRefs(text: string): InlineRef[] {
	const refs: InlineRef[] = [];
	if (text.includes("[图片")) {
		for (const match of text.matchAll(IMAGE_REF)) {
			const start = match.index ?? 0;
			const ordinal = match[1];
			refs.push({
				start,
				end: start + match[0].length,
				kind: "image",
				// An ordinal chip says which image it is; the legacy name form has
				// no number to show, so the name stands in.
				label: ordinal !== undefined ? `图片 ${ordinal}` : (match[2] ?? ""),
			});
		}
	}
	if (text.includes("[Attachment:")) {
		for (const match of text.matchAll(FILE_REF)) {
			const start = match.index ?? 0;
			refs.push({
				start,
				end: start + match[0].length,
				kind: "file",
				label: match[1] ?? "",
			});
		}
	}
	return refs.sort((a, b) => a.start - b.start);
}
