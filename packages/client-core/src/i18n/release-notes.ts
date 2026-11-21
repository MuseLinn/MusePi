/**
 * Release-note projection — renders the canonical Chinese changelog structure
 * (`### 新功能/改进/修复`, `本次发布：…`) in the requested locale.
 *
 * The update dialog and the what's-new panel read the same bilingual markdown,
 * so their heading and counts-line projection must agree; the display copy
 * itself lives in the `release` domain dictionaries, and the canonical Chinese
 * parse tokens are derived from those same values.
 */
import { type TranslationKey, tFor } from "./index.js";

export type ReleaseCategory = "added" | "changed" | "fixed";

/** Categorized headings: canonical Chinese token and localized display. */
const CATEGORY_HEADING_KEYS = {
	added: "release heading new features",
	changed: "release heading improvements",
	fixed: "release heading fixes",
} as const satisfies Record<ReleaseCategory, TranslationKey>;

/** Count-line items: the zh-CN value is the canonical measure phrase that
 *  follows the number (`2 项新功能`), the pair is its singular/plural display. */
const SUMMARY_LABEL_KEYS = [
	["release summary new feature one", "release summary new feature many"],
	["release summary improvement one", "release summary improvement many"],
	["release summary fix one", "release summary fix many"],
	["release summary other change one", "release summary other change many"],
] as const satisfies ReadonlyArray<readonly [TranslationKey, TranslationKey]>;

const SUMMARY_LABELS = new Map<string, readonly [TranslationKey, TranslationKey]>(
	SUMMARY_LABEL_KEYS.map(([one, many]) => [tFor("zh-CN", one), [one, many] as const]),
);

/** Category whose canonical Chinese heading names `heading`, if any. */
export function releaseCategoryOfHeading(heading: string): ReleaseCategory | undefined {
	for (const [category, key] of Object.entries(CATEGORY_HEADING_KEYS)) {
		if (tFor("zh-CN", key) === heading) return category as ReleaseCategory;
	}
	return undefined;
}

/** Localized text for a canonical Chinese category heading, or undefined when
 *  `heading` is not one of the three categorized headings. */
export function localizeReleaseHeading(heading: string, locale: string): string | undefined {
	const category = releaseCategoryOfHeading(heading);
	return category === undefined ? undefined : tFor(locale, CATEGORY_HEADING_KEYS[category]);
}

/** Canonical and en-US spellings of every categorized heading, for parsers
 *  that also accept released English sections. */
export function releaseHeadingAliases(): ReadonlyArray<readonly [string, ReleaseCategory]> {
	return Object.entries(CATEGORY_HEADING_KEYS).flatMap(([category, key]) => [
		[tFor("zh-CN", key), category as ReleaseCategory] as const,
		[tFor("en-US", key).toLowerCase(), category as ReleaseCategory] as const,
	]);
}

/** The canonical counts-line prefix (`本次发布：`), looked up for `locale`. */
export function releaseSummaryPrefix(locale: string): string {
	return tFor(locale, "release summary prefix");
}

/** Translate the canonical tail of the counts line (`2 项新功能 · 1 项改进`)
 *  and keep any unrecognized segment verbatim instead of dropping the
 *  breakdown. */
export function localizeReleaseSummary(summary: string, locale: string): string {
	const prefix = releaseSummaryPrefix(locale);
	if (summary.trim() === tFor("zh-CN", "release summary empty")) {
		return `${prefix} ${tFor(locale, "release summary empty")}`;
	}
	const parts = summary.split(" · ").map(item => {
		const match = item.match(/^(\d+)\s*(.+)$/);
		if (!match) return item;
		const labels = SUMMARY_LABELS.get(match[2] ?? "");
		if (!labels) return item;
		const count = Number(match[1]);
		return `${count} ${tFor(locale, count === 1 ? labels[0] : labels[1])}`;
	});
	return `${prefix} ${parts.join(" · ")}`;
}
