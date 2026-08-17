import { describe, expect, test } from "bun:test";
import { artifactPaths, finalArtifacts } from "./file-artifacts";

describe("artifactPaths", () => {
	test("keeps durable repo paths from write", () => {
		expect(artifactPaths("write", { path: "src/foo.ts" })).toEqual(["src/foo.ts"]);
		expect(artifactPaths("write", { file_path: "/Users/me/repo/notes.md" })).toEqual(["/Users/me/repo/notes.md"]);
	});

	test("filters OS temp roots (macOS / Linux / Windows)", () => {
		// macOS: /tmp → /private/tmp symlink, per-user /var/folders
		expect(artifactPaths("write", { path: "/tmp/verify-tr-font/x.ts" })).toEqual([]);
		expect(artifactPaths("write", { path: "/private/tmp/scratch.js" })).toEqual([]);
		expect(artifactPaths("write", { path: "/var/folders/ab/cdef/T/x.ts" })).toEqual([]);
		expect(artifactPaths("write", { path: "/private/var/folders/ab/cdef/T/x.ts" })).toEqual([]);
		// Windows %TEMP% (case-insensitive)
		expect(artifactPaths("write", { path: "C:\\Users\\me\\AppData\\Local\\Temp\\x.ts" })).toEqual([]);
		expect(artifactPaths("write", { path: "c:\\users\\me\\appdata\\local\\temp\\x.ts" })).toEqual([]);
		expect(artifactPaths("write", { path: "C:\\Temp\\x.ts" })).toEqual([]);
	});

	test("keeps repo-relative tmp/ dirs (not the OS temp root)", () => {
		expect(artifactPaths("write", { path: "tmp/generated.ts" })).toEqual(["tmp/generated.ts"]);
	});

	test("still filters internal URL schemes", () => {
		expect(artifactPaths("write", { path: "xd://tool" })).toEqual([]);
		expect(artifactPaths("write", { path: "skill://foo" })).toEqual([]);
	});

	test("applies to edit-family tools", () => {
		const repoDiff = "[src/foo.ts]\n+line\n";
		expect(artifactPaths("edit", { content: repoDiff })).toEqual(["src/foo.ts"]);
		expect(artifactPaths("edit", { content: "[/tmp/scratch.ts]\n+line\n" })).toEqual([]);
		expect(artifactPaths("apply_patch", { patch: "*** Update File: /tmp/x.ts\n" })).toEqual([]);
		expect(artifactPaths("ast_edit", { paths: ["/tmp/a.ts", "src/b.ts"] })).toEqual(["src/b.ts"]);
	});

	test("applies to image tools", () => {
		expect(artifactPaths("generate_image", { output: "/tmp/img.png" })).toEqual([]);
		expect(artifactPaths("generate_image", { path: "assets/img.png" })).toEqual(["assets/img.png"]);
	});
});

describe("finalArtifacts", () => {
	const blocks = [
		{ type: "toolCall", id: "a", name: "write", arguments: { path: "/tmp/throwaway.ts" } },
		{ type: "toolCall", id: "b", name: "write", arguments: { path: "src/ok.ts" } },
		{ type: "toolCall", id: "c", name: "write", arguments: { path: "src/ok.ts" } },
	];

	test("excludes tmp writes, keeps last write per path", () => {
		expect(finalArtifacts(blocks, () => true)).toEqual([{ id: "c", path: "src/ok.ts" }]);
	});

	test("ignores uncompleted tool calls", () => {
		expect(finalArtifacts(blocks, id => id === "b")).toEqual([{ id: "b", path: "src/ok.ts" }]);
	});
});
