/**
 * Where a dictation writes, and how its growing hypothesis replaces itself.
 *
 * Speech arrives as a stream of growing hypotheses (the in-progress run) and
 * occasional commits (a finished run). Both describe THE SAME region of the
 * draft, so the only way to render them is to fix that region once, at the
 * caret where the user started speaking, and rewrite it in place.
 *
 * The failure this replaces: commits were appended to the end of the whole
 * draft (`prev + " " + transcript`) while the hypothesis was painted at the
 * caret. Speaking two phrases mid-draft put the second phrase after the
 * draft's tail, and every later hypothesis — which follows the caret — then
 * looked like it belonged to a different sentence. The word order of the
 * committed text was wrong and the insertion could sit inside other content.
 *
 * Mirrors KiroCrew's `spliceDictationText`: the rectified text is inserted at
 * the frozen caret with the surrounding draft carried across untouched, and a
 * separator is added only against the side that has words.
 */

/** The spot dictation owns. Frozen at the first hypothesis, never re-derived
 *  from the live caret (the user may type while speaking). */
export interface DictationAnchor {
	/** The composed text right before dictation started. */
	text: string;
	/** The caret where the first word lands. */
	start: number;
	/** Selection end at that moment (dictation replaces a selection). */
	end: number;
	/** How much of `text` this dictation has already written into the region. */
	committed: string;
}

export interface DictationSplice {
	value: string;
	/** Caret immediately after the dictated region. */
	caret: number;
	/** Where the dictated block starts in `value` (after the lead separator). */
	from: number;
	/** End of the block: `caret` plus any trailing separator it owns. */
	to: number;
	/** The exact text the block occupies, both seams included. Replacing
	 *  `[from, to)` of the live document with this is the write. */
	ins: string;
	/** The anchor to keep. */
	next: DictationAnchor;
}

/** A space between dictated text and existing words, but never at a boundary
 *  that already has whitespace or a line break. */
function separator(before: string, after: string): string {
	if (!before || !after) return "";
	if (/\s$/.test(before) || /^\s/.test(after)) return "";
	return " ";
}

/**
 * Replace the dictated region with `committed + hypothesis`.
 *
 * `committed` is what this dictation has already FINALIZED and writes itself;
 * `hypothesis` is the run still being recognized, replaced on every update.
 * Keeping them separate is what lets the same call render both states: adding
 * to `committed` is a commit, changing `hypothesis` is just a repaint.
 */
export function dictationSplice(anchor: DictationAnchor, hypothesis: string): DictationSplice {
	const base = anchor.text;
	const start = Math.max(0, Math.min(anchor.start, base.length));
	const end = Math.max(start, Math.min(anchor.end, base.length));
	const before = base.slice(0, start);
	const after = base.slice(end);

	const dictated = `${anchor.committed}${hypothesis}`;
	const lead = separator(before, dictated);
	const tail = separator(dictated, after);
	const value = `${before}${lead}${dictated}${tail}${after}`;
	// The block owns BOTH seams: it is what replaces `[from, to)` of the current
	// document, and the trailing separator is part of keeping the next words
	// apart. Excluding it left "wordsafter" once only the block was replaced.
	const from = before.length + lead.length;
	const caret = from + dictated.length;
	const to = caret + tail.length;

	// `anchor.text` stays the pre-dictation document and `committed` is what the
	// caller has already finalized, so the region is re-derived exactly, and a
	// retracted or repeated hypothesis cannot stack.
	return { value, caret, from, to, ins: value.slice(from, to), next: anchor };
}

/**
 * Merge the recognizer's final answer into what this dictation already holds.
 *
 * Recorders answer in two shapes and both must land once, never twice: the
 * WHOLE utterance (`"first second"` after `"first"` was committed) or just the
 * run that was still in flight (`"second"`). Taking the final as the whole when
 * it already contains the committed text is what stops the last phrase from
 * doubling — or from being dropped, which is how a finished dictation kept
 * showing only its provisional tail.
 */
export function mergeDictationFinal(committed: string, finalText: string): string {
	const done = committed.trim();
	const last = finalText.trim();
	if (!last) return committed;
	if (done && last.startsWith(done)) return last;
	return `${committed}${last}`;
}
