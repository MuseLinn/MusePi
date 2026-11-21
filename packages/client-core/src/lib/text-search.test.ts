import { describe, expect, it } from "bun:test";
import { TextSearchIndex, type TextSearchKeys } from "./text-search";

/**
 * Search primitive contract: fuzzy and substring keys, folding, tiers, every
 * term required, multilingual keys, and build-order ties.
 */

interface Row {
	readonly id: string;
	readonly title?: string;
	readonly description?: string;
}

const rows: readonly Row[] = [
	{ id: "compact", title: "Compact context", description: "Summarize earlier turns to free model context" },
	{ id: "clipboard-paste", title: "Clipboard paste", description: "Paste images and text into the composer" },
	{ id: "computer-use", title: "Computer use", description: "Control the mouse, keyboard, and screen" },
	{ id: "session-title", title: "Session title", description: "Generate a title for each session with a model" },
];
const keys = (row: Row): TextSearchKeys => ({ fuzzy: [row.id, row.title], substring: [row.description] });
const ids = (query: string, items: readonly Row[] = rows): string[] =>
	new TextSearchIndex(items, keys).search(query).map(row => row.id);

describe("TextSearchIndex.search", () => {
	it("returns the build list itself for a blank query", () => {
		expect(new TextSearchIndex(rows, keys).search("   ")).toBe(rows);
		// A term made only of combining marks folds to nothing and constrains nothing.
		expect(new TextSearchIndex(rows, keys).search("\u0301")).toBe(rows);
	});

	it("matches fuzzy keys as word-start subsequences", () => {
		expect(ids("cpt")).toEqual(expect.arrayContaining(["compact", "computer-use"]));
		expect(ids("cpt")).not.toContain("session-title");
		expect(ids("xyz")).toEqual([]);
	});

	it("ranks exact, prefix, substring, sequence and substring-key hits in tiers", () => {
		const items: readonly Row[] = [
			{ id: "notes", description: "Keep model notes" },
			{ id: "big-model" },
			{ id: "model-list" },
			{ id: "model" },
		];
		expect(ids("model", items)).toEqual(["model", "model-list", "big-model", "notes"]);
	});

	it("prefers a tighter subsequence, then an earlier word start", () => {
		expect(ids("cpt", [{ id: "c-p-t-x" }, { id: "compact" }])).toEqual(["c-p-t-x", "compact"]);
		const later: readonly Row[] = [{ id: "a compact" }, { id: "compact b" }];
		// Both match at a word start with the same tightness; the earlier start wins.
		expect(ids("cpt", later)).toEqual(["compact b", "a compact"]);
	});

	it("accepts a subsequence only when it starts at a word start", () => {
		const items: readonly Row[] = [
			{ id: "refactor", title: "Refactor build pipeline" },
			{ id: "flash", title: "DeepSeekFlash" },
		];
		expect(ids("fab", items)).toEqual([]);
		expect(ids("rbp", items)).toEqual(["refactor"]);
		// A camel-case hump is a word start too.
		expect(ids("sflsh", items)).toEqual(["flash"]);
		// A word start after a separator begins a match.
		expect(ids("bz", [{ id: "foo-bar baz" }])).toEqual(["foo-bar baz"]);
	});

	it("treats every CJK character as a word start", () => {
		const items: readonly Row[] = [
			{ id: "zh", title: "插件筛选" },
			{ id: "other", title: "按名称筛选" },
		];
		expect(ids("件选", items)).toEqual(["zh"]);
		// Order inside the name still matters.
		expect(ids("选筛", items)).toEqual([]);
	});

	it("ignores case, width, diacritics and letter strokes", () => {
		const items: readonly Row[] = [{ id: "ＷＥＢ-search", description: "Café résumé" }];
		expect(ids("web", items)).toEqual(["ＷＥＢ-search"]);
		expect(ids("WEB", items)).toEqual(["ＷＥＢ-search"]);
		expect(ids("cafe", items)).toEqual(["ＷＥＢ-search"]);
		expect(ids("RESUME", items)).toEqual(["ＷＥＢ-search"]);
		expect(ids("lodz", [{ id: "Łódź" }])).toEqual(["Łódź"]);
		expect(ids("ostf", [{ id: "Østfold" }])).toEqual(["Østfold"]);
		// A decomposed query and a composed name match alike.
		expect(ids("re\u0301sm", [{ id: "Résumé" }])).toEqual(["Résumé"]);
		expect(ids("\uff57\uff45\uff42", [{ id: "WEB" }])).toEqual(["WEB"]);
	});

	it("keeps marks that change the letter", () => {
		// Kana voicing is not a diacritic: か does not match が.
		expect(ids("か", [{ id: "が" }])).toEqual([]);
	});

	it("matches substring keys only as a contiguous substring", () => {
		expect(ids("mouse")).toEqual(["computer-use"]);
		// The letters of "invoice" appear in order across "Summarize earlier turns to free model context".
		expect(ids("invoice")).toEqual([]);
		expect(ids("earlier turns")).toEqual(["compact"]);
	});

	it("matches every whitespace-separated term against some key", () => {
		expect(ids("paste composer")).toEqual(["clipboard-paste"]);
		expect(ids("paste mouse")).toEqual([]);
	});

	it("matches every language of a label", () => {
		const items = [{ id: "plugin-filter", title: "Plugin filter", description: "Filter by name" }];
		const localized = (item: (typeof items)[number]): TextSearchKeys => ({
			fuzzy: [item.id, item.title, "插件筛选"],
			substring: [item.description, "按名称筛选"],
		});
		const find = (query: string): string[] =>
			new TextSearchIndex(items, localized).search(query).map(item => item.id);
		expect(find("筛选")).toEqual(["plugin-filter"]);
		expect(find("名称")).toEqual(["plugin-filter"]);
		expect(find("plugin 筛选")).toEqual(["plugin-filter"]);
		expect(find("filter")).toEqual(["plugin-filter"]);
	});

	it("keeps build order among equal scores", () => {
		expect(ids("open", [{ id: "open-z" }, { id: "open-a" }, { id: "x-open" }])).toEqual([
			"open-z",
			"open-a",
			"x-open",
		]);
	});

	it("skips absent and empty values", () => {
		const items: readonly Row[] = [{ id: "" }, { id: "kept", title: "" }];
		expect(ids("kept", items)).toEqual(["kept"]);
		expect(new TextSearchIndex(items, () => ({})).search("kept")).toEqual([]);
	});
});

describe("TextSearchIndex.rank", () => {
	it("ranks with scores, and a blank query ranks nothing", () => {
		const index = new TextSearchIndex(rows, keys);
		expect(index.rank("  ")).toEqual([]);
		const ranked = index.rank("compact");
		expect(ranked[0]?.item.id).toBe("compact");
		expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);
	});

	it("reads keys once per item at build time", () => {
		let calls = 0;
		const index = new TextSearchIndex(rows, row => {
			calls += 1;
			return keys(row);
		});
		index.search("cpt");
		index.search("model");
		expect(calls).toBe(rows.length);
	});
});
