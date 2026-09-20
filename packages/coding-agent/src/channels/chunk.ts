/** Split a long reply into channel-sized chunks WITHOUT dropping the tail
 *  (the old per-adapter `slice(0, limit)` silently discarded everything past
 *  the cap — agent answers just ended mid-thought). Prefers breaking at the
 *  last newline before the limit; falls back to the last space; hard-splits
 *  only when a single unbroken run exceeds the limit. */
export function chunkText(text: string, limit: number): string[] {
	const trimmed = text.trim();
	if (!trimmed) return [];
	if (trimmed.length <= limit) return [trimmed];
	const chunks: string[] = [];
	let rest = trimmed;
	while (rest.length > limit) {
		let cut = rest.lastIndexOf("\n", limit);
		if (cut < limit * 0.3) {
			cut = rest.lastIndexOf(" ", limit);
			if (cut < limit * 0.3) cut = limit;
		}
		chunks.push(rest.slice(0, cut).trim());
		rest = rest.slice(cut).trim();
	}
	if (rest) chunks.push(rest);
	return chunks;
}
