/**
 * Thinking-text sentence splitting for the progressive reveal (aicss
 * aicss-style per-sentence animation).
 *
 * Fence-aware: ``` fenced code blocks are atomic units — a sentence
 * boundary inside a fence (e.g. a JSON example containing `...` or a
 * comment ending with `. `) must NOT split the fence across sentences.
 * A split fence would render as an unterminated code block followed by
 * a stray ``` line (markdown would treat the rest of the sentence as
 * code). Prose splits on the TUI's sentence punctuation, including
 * mid-line boundaries (original behavior).
 */

const FENCE_OPEN = /^\s*```/;
const FENCE_CLOSE = /^\s*```\s*$/;
const SENTENCE_BOUNDARY = /(?<=[。.!?！？])\s+/;

/**
 * Split thinking text into reveal sentences, keeping ``` fences whole.
 * Returns non-empty trimmed units; an empty input yields [].
 */
export function splitThinkingSentences(text: string): string[] {
	const out: string[] = [];
	let buf = "";
	let inFence = false;
	const push = (s: string): void => {
		const t = s.trim();
		if (t) out.push(t);
	};
	for (const line of text.split("\n")) {
		if (!inFence && FENCE_OPEN.test(line)) {
			// Opening fence: flush pending prose, carry the fence as its
			// own unit until the matching closer.
			push(buf);
			buf = line;
			inFence = true;
			continue;
		}
		if (inFence && FENCE_CLOSE.test(line)) {
			buf += `\n${line}`;
			push(buf);
			buf = "";
			inFence = false;
			continue;
		}
		if (inFence) {
			buf += `\n${line}`;
			continue;
		}
		// Prose: accumulate, then flush every completed sentence at the
		// first boundary and keep the remainder for the next line.
		buf += (buf ? "\n" : "") + line;
		let rest = buf;
		const done: string[] = [];
		for (let m = SENTENCE_BOUNDARY.exec(rest); m !== null; m = SENTENCE_BOUNDARY.exec(rest)) {
			done.push(rest.slice(0, m.index + 1));
			rest = rest.slice(m.index + m[0].length);
		}
		if (done.length > 0) {
			for (const s of done) push(s);
			buf = rest;
		}
	}
	push(buf);
	return out;
}
