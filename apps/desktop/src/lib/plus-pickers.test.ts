import { describe, expect, test } from "bun:test";
import { FILE_ROW_LIMIT, filterFileRows, filterPluginRows, flattenWorkspaceFiles } from "./plus-pickers";

describe("flattenWorkspaceFiles", () => {
	test("empty tree yields an empty list", () => {
		expect(flattenWorkspaceFiles([])).toEqual([]);
	});

	test("a pure-directory tree yields no rows (the picker picks files, not folders)", () => {
		expect(
			flattenWorkspaceFiles([
				{ name: "src", path: "src", isDir: true },
				{ name: "docs", path: "docs", isDir: true },
			]),
		).toEqual([]);
	});

	test("files keep their relative path and the list is sorted by path", () => {
		// Source order simulates a depth-first scan: nested files arrive
		// before their shallower siblings.
		const rows = flattenWorkspaceFiles([
			{ name: "b.ts", path: "src/b.ts", isDir: false },
			{ name: "deep.ts", path: "src/nested/deep.ts", isDir: false },
			{ name: "src", path: "src", isDir: true },
			{ name: "a.md", path: "a.md", isDir: false },
		]);
		expect(rows).toEqual(["a.md", "src/b.ts", "src/nested/deep.ts"]);
	});
});

describe("filterFileRows", () => {
	const paths = ["README.md", "src/Foo.ts", "src/bar.tsx", "docs/guide.md"];

	test("matching is a case-insensitive path substring", () => {
		expect(filterFileRows(paths, "FOO").rows).toEqual(["src/Foo.ts"]);
		expect(filterFileRows(paths, "SRC/").rows).toEqual(["src/Foo.ts", "src/bar.tsx"]);
	});

	test("no match yields empty rows without the truncation flag", () => {
		const res = filterFileRows(paths, "no-such-file");
		expect(res.rows).toEqual([]);
		expect(res.truncated).toBe(false);
	});

	test("an empty query passes everything through", () => {
		expect(filterFileRows(paths, "").rows).toEqual(paths);
	});

	test("overflowing lists are capped and flag the truncation", () => {
		const many = Array.from({ length: FILE_ROW_LIMIT + 7 }, (_, i) => `f${i}.ts`);
		const res = filterFileRows(many, "");
		expect(res.rows).toHaveLength(FILE_ROW_LIMIT);
		expect(res.rows[0]).toBe("f0.ts");
		expect(res.truncated).toBe(true);
	});

	test("a custom limit truncates below the default cap", () => {
		const res = filterFileRows(paths, "", 2);
		expect(res.rows).toHaveLength(2);
		expect(res.truncated).toBe(true);
	});
});

describe("filterPluginRows", () => {
	const plugins = [
		{ name: "git-helper", displayName: "Git Helper", description: "Commit helpers" },
		{ name: "tree-sitter", displayName: "TreeSitter", description: "语法高亮" },
	];

	test("an empty query keeps every row in source order", () => {
		expect(filterPluginRows(plugins, "")).toEqual(plugins);
	});

	test("the query matches the display name case-insensitively", () => {
		expect(filterPluginRows(plugins, "git HELP")).toEqual([plugins[0]]);
	});

	test("the query matches the one-line description (CJK included)", () => {
		expect(filterPluginRows(plugins, "语法")).toEqual([plugins[1]]);
	});

	test("rows without a display name fall back to the raw name", () => {
		const bare = [{ name: "Plain", description: "does things" }];
		expect(filterPluginRows(bare, "plain")).toEqual(bare);
	});

	test("no match yields an empty list", () => {
		expect(filterPluginRows(plugins, "nope")).toEqual([]);
	});
});
