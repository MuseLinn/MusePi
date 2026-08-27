/**
 * Word-level diff for intra-line change highlighting — a pure-TS port of
 * `@musepi/pi-natives` `diffWords` (jsdiff `diffWords(old, new)` semantics,
 * default options): tokens carry surrounding whitespace, equality ignores
 * it, and the post-pass dedupes whitespace across change boundaries.
 *
 * The GUI cannot call the Rust native (browser guest has no N-API), so this
 * reimplements the same tokenizer + LCS so desktop and guest render the
 * same marks. Line contents are short (< ~100 tokens), so an O(n·m) DP LCS
 * is fast enough per row.
 */

export interface WordDiffPart {
	/** Joined token text for this run. */
	value: string;
	/** True when this run exists only in the new text. */
	added?: boolean;
	/** True when this run exists only in the old text. */
	removed?: boolean;
}

const WORD_RE = /\w+|\s+|[^\w\s]/g;

/** jsdiff `WordDiff.tokenize`: whitespace runs merge onto the adjacent word
 *  or punctuation part (interior whitespace duplicated into both neighbors). */
function wordTokens(text: string): string[] {
	const parts = text.match(WORD_RE) ?? [];
	const tokens: string[] = [];
	let prev: string | null = null;
	for (const part of parts) {
		const isWs = /^\s+$/.test(part);
		if (isWs) {
			if (prev === null) {
				tokens.push(part);
			} else {
				const last = tokens[tokens.length - 1]!;
				tokens[tokens.length - 1] = last + part;
			}
		} else if (prev !== null && /^\s+$/.test(prev)) {
			if (tokens[tokens.length - 1] === prev) {
				tokens[tokens.length - 1] = prev + part;
			} else {
				tokens.push(prev + part);
			}
		} else {
			tokens.push(part);
		}
		prev = part;
	}
	return tokens;
}

/** jsdiff equality: whitespace-insensitive (trim before compare). */
function tokenKey(token: string): string {
	return token.trim();
}

/**
 * Myers-style diff over token id sequences, emitted as runs of added /
 * removed / equal tokens. Uses a simple DP LCS backtrack (n·m bounded by
 * line length — typically < 2 000 cells).
 */
function tokenRuns(
	oldTokens: string[],
	newTokens: string[],
): Array<{ value: string; added?: boolean; removed?: boolean }> {
	const n = oldTokens.length;
	const m = newTokens.length;
	const oldKeys = oldTokens.map(tokenKey);
	const newKeys = newTokens.map(tokenKey);
	// dp[i][j] = LCS length of old[i..] / new[j..]
	const dp: Uint16Array[] = new Array(n + 1);
	for (let i = n; i >= 0; i--) {
		dp[i] = new Uint16Array(m + 1);
	}
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i]![j] = oldKeys[i] === newKeys[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
		}
	}
	const runs: Array<{ value: string; added?: boolean; removed?: boolean }> = [];
	const pushRun = (tokens: readonly string[], added?: boolean, removed?: boolean): void => {
		const last = runs[runs.length - 1];
		const value = wordJoin(tokens);
		if (last && Boolean(last.added) === Boolean(added) && Boolean(last.removed) === Boolean(removed)) {
			// A merged run is not the first token of the joined sequence —
			// strip leading whitespace like wordJoin would for tokens after
			// the first (jsdiff builds values from the whole run's tokens).
			last.value += value.replace(/^\s+/, "");
		} else {
			runs.push({ value, added, removed });
		}
	};
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (oldKeys[i] === newKeys[j]) {
			// Merge equal runs that follow each other (e.g. identical tokens
			// split by a whitespace-attach boundary).
			const eq: string[] = [];
			while (i < n && j < m && oldKeys[i] === newKeys[j]) {
				eq.push(oldTokens[i]!);
				i++;
				j++;
			}
			pushRun(eq);
		} else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
			// removed (or tie → removed first, matching jsdiff ordering)
			pushRun([oldTokens[i]!], false, true);
			i++;
		} else {
			pushRun([newTokens[j]!], true, false);
			j++;
		}
	}
	while (i < n) {
		pushRun([oldTokens[i]!], false, true);
		i++;
	}
	while (j < m) {
		pushRun([newTokens[j]!], true, false);
		j++;
	}
	return runs;
}

/** jsdiff `WordDiff.join`: concatenate, stripping leading whitespace from
 *  every token after the first. */
function wordJoin(tokens: readonly string[]): string {
	let out = "";
	for (let i = 0; i < tokens.length; i++) {
		out += i === 0 ? tokens[i]! : tokens[i]!.replace(/^\s+/, "");
	}
	return out;
}

const WS = /^\s*$/;
const LEADING_WS = /^\s*/;
const TRAILING_WS = /\s*$/;

function leadingWs(s: string): string {
	return s.match(LEADING_WS)?.[0] ?? "";
}

function trailingWs(s: string): string {
	return s.match(TRAILING_WS)?.[0] ?? "";
}

function longestCommonPrefix(a: string, b: string): string {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	return a.slice(0, i);
}

function longestCommonSuffix(a: string, b: string): string {
	let i = 0;
	while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
	return a.slice(a.length - i);
}

/** jsdiff `dedupeWhitespaceInChangeObjects` — move whitespace the tokenizer
 *  duplicated across a keep/delete/insert boundary into the keep runs so
 *  change marks hug the changed words. */
function dedupeWhitespace(
	changes: WordDiffPart[],
	startKeep: number | null,
	deletion: number | null,
	insertion: number | null,
	endKeep: number | null,
): void {
	if (deletion != null && insertion != null) {
		const del = changes[deletion]!;
		const ins = changes[insertion]!;
		const oldWsPrefix = leadingWs(del.value);
		const oldWsSuffix = trailingWs(del.value);
		const newWsPrefix = leadingWs(ins.value);
		const newWsSuffix = trailingWs(ins.value);
		if (startKeep != null) {
			const common = longestCommonPrefix(oldWsPrefix, newWsPrefix);
			const keep = changes[startKeep]!;
			changes[startKeep]!.value = keep.value.endsWith(newWsPrefix)
				? keep.value.slice(0, -newWsPrefix.length) + common
				: keep.value;
			del.value = del.value.slice(common.length);
			ins.value = ins.value.slice(common.length);
		}
		if (endKeep != null) {
			const common = longestCommonSuffix(oldWsSuffix, newWsSuffix);
			const keep = changes[endKeep]!;
			changes[endKeep]!.value = keep.value.startsWith(newWsSuffix)
				? common + keep.value.slice(newWsSuffix.length)
				: keep.value;
			del.value = del.value.slice(0, del.value.length - common.length);
			ins.value = ins.value.slice(0, ins.value.length - common.length);
		}
	} else if (insertion != null && deletion == null) {
		if (startKeep != null) {
			const wsLen = leadingWs(changes[insertion]!.value).length;
			changes[insertion]!.value = changes[insertion]!.value.slice(wsLen);
		}
		if (endKeep != null) {
			const wsLen = leadingWs(changes[endKeep]!.value).length;
			changes[endKeep]!.value = changes[endKeep]!.value.slice(wsLen);
		}
	} else if (deletion != null && insertion == null) {
		if (startKeep != null && endKeep != null) {
			const endWs = leadingWs(changes[endKeep]!.value);
			const delFullWs = leadingWs(changes[deletion]!.value);
			if (WS.test(delFullWs) && delFullWs.length > 0) {
				changes[endKeep]!.value = delFullWs + changes[endKeep]!.value.slice(endWs.length);
				changes[deletion]!.value = changes[deletion]!.value.slice(delFullWs.length);
			} else {
				changes[endKeep]!.value = changes[endKeep]!.value.slice(endWs.length) + changes[deletion]!.value;
				changes[deletion]!.value = "";
			}
		} else if (startKeep != null && endKeep == null) {
			const wsLen = leadingWs(changes[deletion]!.value).length;
			changes[deletion]!.value = changes[deletion]!.value.slice(wsLen);
		} else if (startKeep == null && endKeep != null) {
			const wsLen = leadingWs(changes[endKeep]!.value).length;
			changes[endKeep]!.value = changes[endKeep]!.value.slice(wsLen);
		}
	}
}

/** Whitespace dedupe across change boundaries (jsdiff post-process). */
function postProcess(changes: WordDiffPart[]): WordDiffPart[] {
	let lastKeep: number | null = null;
	let insertion: number | null = null;
	let deletion: number | null = null;
	for (let i = 0; i < changes.length; i++) {
		if (changes[i]!.added) {
			insertion = i;
		} else if (changes[i]!.removed) {
			deletion = i;
		} else {
			if (insertion != null || deletion != null) {
				dedupeWhitespace(changes, lastKeep, deletion, insertion, i);
			}
			lastKeep = i;
			insertion = null;
			deletion = null;
		}
	}
	if (insertion != null || deletion != null) {
		dedupeWhitespace(changes, lastKeep, deletion, insertion, null);
	}
	return changes;
}

/**
 * Word diff with jsdiff `diffWords(oldText, newText)` semantics. Returns
 * runs of added / removed / equal text; concatenating all `value` fields in
 * order reproduces `newText` (removed runs are old-only text).
 */
export function diffWords(oldText: string, newText: string): WordDiffPart[] {
	const oldTokens = wordTokens(oldText);
	const newTokens = wordTokens(newText);
	if (oldTokens.length === 0 && newTokens.length === 0) return [];
	const runs = tokenRuns(oldTokens, newTokens);
	// Merge adjacent runs of the same kind so values read naturally.
	const merged: WordDiffPart[] = [];
	for (const run of runs) {
		const prev = merged[merged.length - 1];
		if (prev && Boolean(prev.added) === Boolean(run.added) && Boolean(prev.removed) === Boolean(run.removed)) {
			prev.value += run.value;
		} else {
			merged.push({ ...run });
		}
	}
	return postProcess(merged);
}
