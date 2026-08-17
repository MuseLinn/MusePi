/**
 * Syntax probe for candidate edit results, via the native tree-sitter parser.
 *
 * Delimiter-balance arithmetic cannot tell a block closer from a `}` inside a
 * regex literal, a string, or Markdown prose. A parser can, so it holds veto
 * power over every repair whose justification is "this line closes a syntactic
 * block": when the edit the author actually wrote still parses, no such repair
 * may rewrite it. The probe never *forces* a repair — an unrecognized language
 * or an already-broken file simply yields no veto, leaving the delimiter
 * heuristics as the only available evidence.
 */

import { enclosingBlockBoundaries } from "@musepi/pi-natives";

/** Parse-result cache keyed by content hash + path; FIFO-bounded. */
const parseCache = new Map<string, boolean>();
const PARSE_CACHE_MAX = 256;

/**
 * `true` when `text` parses without a syntax error under the language inferred
 * from `path`. `false` covers "does not parse" and "cannot tell" alike — no
 * path, an unrecognized language, or a native failure — because both mean the
 * probe has nothing to prove with. Callers must therefore never treat `false`
 * as evidence *about the edit*: it only withholds permission to rewrite.
 *
 * Uses `enclosingBlockBoundaries` over a whole-file window: no node can cross
 * that window, so the boundary walk is trivial and the tree-sitter parse is the
 * only real cost. It returns `null` for an unrecognized language and for a
 * source that fails to parse, which this predicate deliberately conflates.
 */
export function parsesCleanly(path: string | undefined, text: string): boolean {
	if (path === undefined) return false;
	const key = `${Bun.hash(text).toString(36)}:${text.length}:${path}`;
	const cached = parseCache.get(key);
	if (cached !== undefined) return cached;
	const lineCount = text.length === 0 ? 1 : text.split("\n").length;
	let ok: boolean;
	try {
		ok = enclosingBlockBoundaries({ code: text, path, ranges: [{ startLine: 1, endLine: lineCount }] }) !== null;
	} catch {
		ok = false;
	}
	if (parseCache.size >= PARSE_CACHE_MAX) {
		const oldest = parseCache.keys().next().value;
		if (oldest !== undefined) parseCache.delete(oldest);
	}
	parseCache.set(key, ok);
	return ok;
}
