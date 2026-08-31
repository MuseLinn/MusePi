/**
 * Subsequence fuzzy matching for the model picker search (TUI parity).
 *
 * The TUI's `/switch` picker matches a query as a character subsequence —
 * "go" matches "google", "ds" matches "deepseek-v4-flash" — while the GUI
 * used substring `includes()`, which requires the letters to be contiguous.
 * This module reproduces the subsequence semantics on the wire fields a model
 * row exposes (provider, id, name) so both pickers narrow the same way.
 *
 * Query tokens are split on whitespace; every token must subsequence-match
 * the searchable text (all tokens required, same as the TUI's fuzzyRank).
 */

/** True when `needle`'s characters appear in `haystack` in order (not necessarily contiguous). */
function isSubsequence(needle: string, haystack: string): boolean {
	if (needle.length === 0) return true;
	if (needle.length > haystack.length) return false;
	let needleIndex = 0;
	for (let i = 0; i < haystack.length && needleIndex < needle.length; i++) {
		if (haystack[i] === needle[needleIndex]) needleIndex++;
	}
	return needleIndex === needle.length;
}

/**
 * Match a picker query against a model row. Every whitespace-separated token
 * must subsequence-match the combined `provider/id/name` text (case-folded).
 * An empty or whitespace-only query matches everything.
 */
export function matchesModelQuery(query: string, provider: string, id: string, name: string): boolean {
	const q = query.trim().toLowerCase();
	if (q.length === 0) return true;
	const tokens = q.split(/\s+/);
	if (tokens.some(token => token.length === 0)) return true;
	const haystack = `${provider} ${id} ${name}`.toLowerCase();
	return tokens.every(token => isSubsequence(token, haystack));
}
