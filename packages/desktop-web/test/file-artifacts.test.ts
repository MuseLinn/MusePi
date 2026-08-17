import { describe, expect, test } from "bun:test";
import { artifactPaths, finalArtifacts } from "../src/components/transcript/file-artifacts";

describe("artifactPaths", () => {
	test("write: file_path wins, path fallback", () => {
		expect(artifactPaths("write", { file_path: "a.ts", path: "b.ts" })).toEqual(["a.ts"]);
		expect(artifactPaths("write", { path: "b.ts" })).toEqual(["b.ts"]);
		expect(artifactPaths("write", {})).toEqual([]);
	});

	test("edit: hashline [path#tag] headers", () => {
		expect(artifactPaths("edit", { content: "[src/a.ts#a1b2]\n- old\n+ new\n" })).toEqual(["src/a.ts"]);
	});

	test("edit: apply_patch file headers", () => {
		const patch = "*** Begin Patch\n*** Update File: src/foo.ts\n@@\n- a\n+ b\n";
		expect(artifactPaths("edit", { content: patch })).toEqual(["src/foo.ts"]);
	});

	test("ast_edit: content headers plus paths array", () => {
		const args = { content: "[src/x.ts]\n", paths: ["src/x.ts", "src/y.ts"] };
		expect(artifactPaths("ast_edit", args)).toEqual(["src/x.ts", "src/y.ts"]);
	});

	test("generate_image: output path", () => {
		expect(artifactPaths("generate_image", { path: "out/hero.png" })).toEqual(["out/hero.png"]);
	});

	test("read-class tools produce nothing", () => {
		expect(artifactPaths("read", { path: "src/a.ts" })).toEqual([]);
		expect(artifactPaths("grep", { pattern: "x" })).toEqual([]);
		expect(artifactPaths("web_search", {})).toEqual([]);
		expect(artifactPaths("board", { action: "save" })).toEqual([]);
	});
});

describe("finalArtifacts", () => {
	const blocks = [
		{ type: "toolCall", id: "t1", name: "write", arguments: { path: "docs/a.md" } },
		{ type: "toolCall", id: "t2", name: "read", arguments: { path: "docs/a.md" } },
		{ type: "toolCall", id: "t3", name: "write", arguments: { path: "docs/a.md" } },
		{ type: "toolCall", id: "t4", name: "write", arguments: { path: "docs/b.md" } },
	];

	test("dedupes by path, last write wins, read-class excluded", () => {
		const results = new Map([
			["t1", { isError: false }],
			["t3", { isError: false }],
			["t4", { isError: false }],
		] as unknown as Map<string, { isError: boolean }>);
		const got = finalArtifacts(blocks, id => {
			const r = results.get(id);
			return r !== undefined && r.isError !== true;
		});
		// docs/a.md deduped to the LAST write (t3); docs/b.md kept; order = first-seen
		expect(got).toEqual([
			{ id: "t3", path: "docs/a.md" },
			{ id: "t4", path: "docs/b.md" },
		]);
	});

	test("failed tools excluded", () => {
		const got = finalArtifacts(blocks, id => id === "t1"); // only t1 "completed"
		expect(got).toEqual([{ id: "t1", path: "docs/a.md" }]);
	});

	test("empty / no completed → []", () => {
		expect(finalArtifacts([], () => true)).toEqual([]);
		expect(finalArtifacts(blocks, () => false)).toEqual([]);
	});
});
