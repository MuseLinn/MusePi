/**
 * FTS5 text preparation shared by every index that answers CJK queries.
 *
 * unicode61 (FTS5's default tokenizer) keeps a contiguous CJK run as ONE
 * token, so a query for a word inside a longer run ("后端" inside "记忆后端")
 * can never match by prefix. The fix every caller here shares is a bigram
 * expansion stored in a dedicated column: the original text keeps living in
 * its own column so `snippet()` reads readable prose, while MATCH runs against
 * the expanded copy where "记忆后端" became the tokens 记忆 忆后 后端 端.
 *
 * Both sides expand: indexed text and the query. A query for 后端 therefore
 * hits 记忆后端, and a query for a whole run hits the same row.
 *
 * Non-CJK text passes through untouched, so mostly-ASCII columns cost one
 * regex scan and no rewriting.
 */

/** Bigram-expand every CJK run; everything else is left byte-identical. */
export function expandCjk(s: string): string {
	return s.replace(/[\u4e00-\u9fff]+/g, run => {
		const grams: string[] = [];
		// A trailing 1-char gram keeps the run's last character reachable by a
		// single-character query ("端" → 端*) once the wildcard is applied.
		for (let i = 0; i < run.length; i++) grams.push(run.slice(i, i + 2));
		return grams.join(" ");
	});
}

/**
 * Index-side preparation: the value stored in an `expanded` column.
 *
 * Callers keep the original text in a sibling column; this value is only ever
 * fed to MATCH.
 */
export function expandForIndex(s: string): string {
	return expandCjk(s);
}

/**
 * Query-side preparation: bigram expansion plus a prefix wildcard per token,
 * joined by implicit AND.
 *
 * The trailing `*` is what lets a single CJK character ("看") reach a bigram
 * starting with it, and what lets "log" reach "login". Callers catch the
 * SQLite error a malformed expression raises and treat it as no matches — a
 * punctuation-only query reduces to a bare `*`, the common failure.
 */
export function expandForQuery(q: string): string {
	return expandCjk(q.trim().replace(/\s+/g, " "))
		.split(" ")
		.filter(Boolean)
		.map(token => `${token}*`)
		.join(" ");
}
