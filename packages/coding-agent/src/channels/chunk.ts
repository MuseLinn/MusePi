/** Split a long reply into channel-sized chunks WITHOUT dropping the tail
 *  (the old per-adapter `slice(0, limit)` silently discarded everything past
 *  the cap — agent answers just ended mid-thought). Prefers breaking at the
 *  last newline before the limit; falls back to the last space; hard-splits
 *  only when a single unbroken run exceeds the limit. Fenced code blocks are
 *  closed and reopened across the split instead of being cut in half. */
export function chunkText(text: string, limit: number): string[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	if (trimmed.length <= limit) return [trimmed];
	// Reserve room for the closing ``` that a mid-code split has to add.
	const budget = Math.max(limit - 8, 1);
	const chunks: string[] = [];
	let rest = trimmed;
	while (rest.length > limit) {
		let cut = rest.lastIndexOf("\n", budget);
		if (cut < budget * 0.3) {
			cut = rest.lastIndexOf(" ", budget);
			if (cut < budget * 0.3) cut = budget;
		}
		if (cut < 1) cut = budget;
		let head = rest.slice(0, cut).trim();
		let tail = rest.slice(cut);
		if (!head) {
			head = rest.slice(0, budget);
			tail = rest.slice(budget);
		}
		const lang = openFenceLanguage(head);
		if (lang === null) {
			chunks.push(head);
			rest = tail.trim();
			continue;
		}
		// Every chunk is rendered on its own, so a split inside a fenced block
		// would leak an unpaired ``` into BOTH halves: close the block here and
		// reopen it in the next chunk.
		chunks.push(`${head}\n\`\`\``);
		rest = `\`\`\`${lang}\n${tail.trimStart()}`;
	}
	if (rest) chunks.push(rest);
	return chunks;
}

/** Language tag when `text` ends inside an unterminated ``` block (an odd
 *  number of line-leading fence markers), otherwise null. */
function openFenceLanguage(text: string): string | null {
	const markers = text.match(/^```/gm)?.length ?? 0;
	if (markers % 2 === 0) return null;
	const openers = [...text.matchAll(/^```([\w-]*)/gm)];
	const last = openers[openers.length - 1];
	return last?.[1] ?? "";
}
