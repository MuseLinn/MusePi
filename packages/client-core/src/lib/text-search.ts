/**
 * One search primitive for in-memory GUI lists.
 *
 * A {@link TextSearchIndex} prepares the search text of a list once and then
 * answers any number of queries over it. `fuzzy` keys — names, titles, labels,
 * readable ids — match as substrings or as word-start subsequences, so `cpt`
 * finds `Compact` while `fab` does not match inside `Refactor build`.
 * `substring` keys — descriptions, config keys, opaque ids — match only as a
 * contiguous substring: a subsequence scattered across a sentence is noise.
 * Every key may carry several values, such as every language of a label.
 *
 * Both key kinds ignore case, width (NFKC), U+0300–U+036F diacritics and the
 * stroke of letters such as `ł` and `ø`; kana voicing marks stay, because they
 * change the letter. A query splits on whitespace and every term must match
 * some key of the item.
 *
 * Each term scores its best tier: fuzzy-key exact, fuzzy-key prefix, fuzzy-key
 * substring, fuzzy word-start subsequence, then substring-key hit. Equal
 * scores keep the build order. Pure data, no DOM: a list filter builds the
 * index and searches it, and a list or locale change builds a new one.
 */

/** The text one item offers to a search; absent and empty values never match. */
export interface TextSearchKeys {
	/** Short identifying text matched as substrings or word-start fuzzy
	 *  subsequences, and ranked first: names, titles, labels, readable ids. */
	readonly fuzzy?: readonly (string | undefined)[];
	/** Longer text and opaque ids matched only as contiguous substrings:
	 *  descriptions, config keys, paths, UUIDs. */
	readonly substring?: readonly (string | undefined)[];
}

/** One ranked item; `score` sums every query term's best tier. */
export interface TextSearchHit<T> {
	readonly item: T;
	readonly score: number;
}

/** Tier bases; a subsequence hit adds its own quality in [0, 1) above its base. */
const TIER_EXACT = 8;
const TIER_PREFIX = 6;
const TIER_CONTAINS = 4;
const TIER_SEQUENCE = 2;
const TIER_SUBSTRING = 1;

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** Combining diacritical marks; other scripts' marks, such as kana voicing or Indic vowel signs, change the letter and stay. */
const DIACRITIC_MARKS = /[\u0300-\u036f]/gu;

/** Letters whose stroke decomposition leaves intact, mapped to their base letter. */
const STROKED: Readonly<Record<string, string>> = {
	ø: "o",
	Ø: "O",
	ł: "l",
	Ł: "L",
	đ: "d",
	Đ: "D",
	ð: "d",
	Ð: "D",
	ı: "i",
	ħ: "h",
	Ħ: "H",
	ŧ: "t",
	Ŧ: "T",
};
const STROKED_CHAR = /[øØłŁđĐðÐıħĦŧŦ]/gu;

const WORD_CHAR = /[\p{L}\p{N}]/u;
const UPPER = /\p{Lu}/u;
const LOWER = /\p{Ll}/u;
/** Scripts written without spaces between words: each character starts a word. */
const UNSPACED = /[\p{scx=Han}\p{scx=Hira}\p{scx=Kana}\p{scx=Hang}]/u;

/**
 * Width- and diacritic-insensitive form that keeps case, so camel-case humps
 * still mark word starts.
 */
function strip(value: string): string {
	// Printable ASCII has no width forms or combining marks, and most keys are ASCII.
	if (PRINTABLE_ASCII.test(value)) return value;
	return value
		.normalize("NFKD")
		.replace(DIACRITIC_MARKS, "")
		.normalize("NFKC")
		.replace(STROKED_CHAR, char => STROKED[char] ?? char);
}

/** Case-insensitive form of one code point, keeping the index aligned with the stripped text. */
function foldChar(char: string): string {
	return char.toLowerCase();
}

/** One key string prepared at build: the folded text for substring tests, its per-code-point form and its word starts. */
interface PreparedName {
	readonly text: string;
	readonly parts: readonly string[];
	readonly starts: readonly number[];
}

/** One item's keys prepared at build. */
interface PreparedKeys {
	readonly fuzzy: readonly PreparedName[];
	readonly substring: readonly string[];
}

/** One query term in the two forms the tiers compare. */
interface Term {
	readonly text: string;
	readonly parts: readonly string[];
}

function isWordStart(chars: readonly string[], index: number): boolean {
	if (index === 0) return true;
	const char = chars[index]!;
	const previous = chars[index - 1]!;
	return !WORD_CHAR.test(previous) || UNSPACED.test(char) || (UPPER.test(char) && LOWER.test(previous));
}

function prepareName(value: string): PreparedName {
	const chars = Array.from(strip(value));
	const parts = chars.map(foldChar);
	const starts: number[] = [];
	for (let index = 0; index < chars.length; index += 1) {
		if (isWordStart(chars, index)) starts.push(index);
	}
	return { text: parts.join(""), parts, starts };
}

function prepareTerm(value: string): Term {
	const parts = Array.from(strip(value)).map(foldChar);
	return { text: parts.join(""), parts };
}

function prepareKeys(keys: TextSearchKeys): PreparedKeys {
	const fuzzy: PreparedName[] = [];
	for (const value of keys.fuzzy ?? []) {
		if (value === undefined || value === "") continue;
		fuzzy.push(prepareName(value));
	}
	const substring: string[] = [];
	for (const value of keys.substring ?? []) {
		if (value === undefined || value === "") continue;
		substring.push(prepareName(value).text);
	}
	return { fuzzy, substring };
}

function termsOf(query: string): Term[] {
	return query
		.trim()
		.split(/\s+/u)
		.map(prepareTerm)
		.filter(term => term.text !== "");
}

/**
 * The best quality of `needle` as a subsequence of `name` that starts at a
 * word start, or undefined when no word start leads to a match. Quality
 * prefers a tight span and, within that, an earlier start.
 */
function subsequenceScore(needle: Term, name: PreparedName): number | undefined {
	let best: number | undefined;
	for (const start of name.starts) {
		if (name.parts[start] !== needle.parts[0]) continue;
		let at = start;
		let last = start;
		for (let index = 1; index < needle.parts.length; index += 1) {
			let found = -1;
			for (let cursor = at + 1; cursor < name.parts.length; cursor += 1) {
				if (name.parts[cursor] === needle.parts[index]) {
					found = cursor;
					break;
				}
			}
			if (found < 0) {
				last = -1;
				break;
			}
			at = found;
			last = found;
		}
		if (last < 0) continue;
		const span = last - start + 1;
		// A contiguous match scores 1; gaps take it down, and a later start takes a small share.
		const quality = (needle.parts.length / span) * 0.9 + 0.1 / (1 + start);
		const score = Math.min(0.99, quality);
		best = best === undefined ? score : Math.max(best, score);
	}
	return best;
}

/** The best tier score of one query term over one item's keys, or undefined when no key matches. */
function termScore(term: Term, keys: PreparedKeys): number | undefined {
	let best: number | undefined;
	const take = (score: number): void => {
		best = best === undefined ? score : Math.max(best, score);
	};
	for (const name of keys.fuzzy) {
		const at = name.text.indexOf(term.text);
		if (at === 0) {
			take(name.text === term.text ? TIER_EXACT : TIER_PREFIX);
		} else if (at > 0) {
			take(TIER_CONTAINS);
		} else {
			const sequence = subsequenceScore(term, name);
			if (sequence !== undefined) take(TIER_SEQUENCE + sequence);
		}
	}
	for (const text of keys.substring) {
		if (text.includes(term.text)) take(TIER_SUBSTRING);
	}
	return best;
}

/**
 * Search index over one list. The constructor prepares every key of every
 * item; {@link TextSearchIndex.search} then answers queries without re-reading
 * the items or their keys. An index holds its list by reference and never
 * changes: callers must not mutate the list or its items, and must build a new
 * index when the list, a label's language, or any key changes.
 */
export class TextSearchIndex<T> {
	readonly #items: readonly T[];
	readonly #keys: readonly PreparedKeys[];

	/**
	 * @param items - candidates in their display order, which ties keep.
	 * @param keys - the search text of one item, called once per item here.
	 */
	constructor(items: readonly T[], keys: (item: T) => TextSearchKeys) {
		this.#items = items;
		this.#keys = items.map(item => prepareKeys(keys(item)));
	}

	/**
	 * Filter and rank the indexed items.
	 * @param query - the user's search text.
	 * @returns the build list itself for a blank query or one made only of
	 * combining marks; otherwise the matching items, best total score first.
	 */
	search(query: string): readonly T[] {
		const terms = termsOf(query);
		if (terms.length === 0) return this.#items;
		return this.#match(terms).map(hit => hit.item);
	}

	/**
	 * Ranked hits with their scores, for callers that interleave another signal
	 * or cap the list.
	 * @param query - the user's search text.
	 * @returns an empty list for a blank query; only matches otherwise.
	 */
	rank(query: string): TextSearchHit<T>[] {
		const terms = termsOf(query);
		return terms.length === 0 ? [] : this.#match(terms);
	}

	#match(terms: readonly Term[]): TextSearchHit<T>[] {
		const hits: TextSearchHit<T>[] = [];
		this.#keys.forEach((keys, index) => {
			let score = 0;
			for (const term of terms) {
				const hit = termScore(term, keys);
				if (hit === undefined) return;
				score += hit;
			}
			hits.push({ item: this.#items[index]!, score });
		});
		return hits.sort((left, right) => right.score - left.score);
	}
}
