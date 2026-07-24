// MusePi core — memory 引擎测试。
// 覆盖：pid 稳定性、骨架懒创建、retain 去重、edit 锚点改写、
// BM25 排序与分数地板、注入预算截断、scope 行为、空记忆零注入。
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { RELATIVE_SCORE_FLOOR, buildIndex, searchIndex, tokenize } from "../src/memory/bm25.ts";
import { buildMemoryInjection, estimateTokens, truncateToBudget } from "../src/memory/inject.ts";
import { searchMemory } from "../src/memory/ops.ts";
import { computeProjectId, memoryPaths } from "../src/memory/paths.ts";
import {
	editEntry,
	isEmptyMemory,
	memorySkeleton,
	readMemoryFile,
	retainEntry,
	writeMemoryFile,
} from "../src/memory/store.ts";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "musepi-memory-"));
	dirs.push(dir);
	return dir;
}
after(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("computeProjectId / memoryPaths", () => {
	it("is stable for the same cwd and differs across cwds", () => {
		const a1 = computeProjectId("/repo/alpha");
		const a2 = computeProjectId("/repo/alpha");
		const b = computeProjectId("/repo/beta");
		assert.strictEqual(a1, a2);
		assert.notStrictEqual(a1, b);
		assert.match(a1, /^[0-9a-f]{12}$/);
	});

	it("lays out global and per-project files under <dataDir>/memory", () => {
		const paths = memoryPaths("/data", "/repo/alpha");
		assert.strictEqual(paths.globalFile, join("/data", "memory", "global", "MEMORY.md"));
		assert.strictEqual(
			paths.projectFile,
			join("/data", "memory", "projects", computeProjectId("/repo/alpha"), "MEMORY.md"),
		);
	});
});

describe("store — skeleton / retain / edit", () => {
	it("lazily creates the skeleton with the four fixed sections", () => {
		const dir = tempDir();
		const file = join(dir, "MEMORY.md");
		const content = readMemoryFile(file, "project");
		for (const section of ["Project context", "Rules", "Architecture decisions", "Durable knowledge"]) {
			assert.ok(content.includes(`## ${section}`), `missing section ${section}`);
		}
		assert.ok(isEmptyMemory(content), "fresh skeleton counts as empty");
	});

	it("retain appends a dated entry to Durable knowledge", () => {
		const dir = tempDir();
		const file = join(dir, "MEMORY.md");
		const result = retainEntry(file, "project", "use pnpm, not npm");
		assert.strictEqual(result.appended, true);
		const content = readFileSync(file, "utf-8");
		assert.match(content, /## Durable knowledge\n- \[\d{4}-\d{2}-\d{2}\] use pnpm, not npm/);
		assert.ok(!isEmptyMemory(content));
	});

	it("retain dedupes adjacent duplicates but allows non-adjacent ones", () => {
		const dir = tempDir();
		const file = join(dir, "MEMORY.md");
		assert.strictEqual(retainEntry(file, "project", "fact A").appended, true);
		assert.strictEqual(retainEntry(file, "project", "fact A").appended, false, "adjacent dup skipped");
		assert.strictEqual(retainEntry(file, "project", "fact B").appended, true);
		assert.strictEqual(retainEntry(file, "project", "fact A").appended, true, "non-adjacent dup allowed");
		const entries = readFileSync(file, "utf-8").split("\n").filter((l) => l.includes("fact A"));
		assert.strictEqual(entries.length, 2);
	});

	it("retain targets a chosen section", () => {
		const dir = tempDir();
		const file = join(dir, "MEMORY.md");
		retainEntry(file, "project", "never mutate .git directly", "Rules");
		const content = readFileSync(file, "utf-8");
		const rulesAt = content.indexOf("## Rules");
		const decisionAt = content.indexOf("## Architecture decisions");
		const entryAt = content.indexOf("never mutate .git directly");
		assert.ok(rulesAt < entryAt && entryAt < decisionAt);
	});

	it("edit rewrites exactly one anchored line", () => {
		const dir = tempDir();
		const file = join(dir, "MEMORY.md");
		retainEntry(file, "project", "cache TTL is 5 minutes");
		const result = editEntry(file, "project", "cache TTL is 5 minutes", "- cache TTL is 30 minutes");
		assert.strictEqual(result.replaced, true);
		const content = readFileSync(file, "utf-8");
		assert.ok(content.includes("cache TTL is 30 minutes"));
		assert.ok(!content.includes("5 minutes"));
	});

	it("edit fails on missing or ambiguous anchors", () => {
		const dir = tempDir();
		const file = join(dir, "MEMORY.md");
		writeMemoryFile(file, memorySkeleton("project"));
		retainEntry(file, "project", "alpha common suffix");
		retainEntry(file, "project", "beta common suffix");
		assert.throws(() => editEntry(file, "project", "no such anchor", "x"), /anchor not found/);
		assert.throws(() => editEntry(file, "project", "common suffix", "x"), /matches 2 lines/);
	});
});

describe("bm25 — ranking and relative floor", () => {
	const docs = [
		{ index: 0, tokens: tokenize("typescript compiler strict mode"), text: "typescript compiler strict mode" },
		{ index: 1, tokens: tokenize("typescript config paths alias"), text: "typescript config paths alias" },
		{ index: 2, tokens: tokenize("unrelated gardening notes"), text: "unrelated gardening notes" },
	];

	it("ranks the more relevant document first", () => {
		const index = buildIndex(docs);
		const hits = searchIndex(index, docs, "typescript strict");
		assert.strictEqual(hits[0]!.index, 0);
	});

	it("drops zero-score documents entirely", () => {
		const index = buildIndex(docs);
		const hits = searchIndex(index, docs, "typescript");
		assert.ok(hits.every((h) => h.index !== 2));
	});

	it("applies the 15% relative floor to filter weak hits", () => {
		// 10 篇都含常见词 "common"（低 IDF），只有一篇还含独特词（高分）。
		// 查询命中两边后，只含 common 的弱命中应被 top 15% 地板滤掉。
		const corpus = [
			{ index: 0, tokens: tokenize("common quokka xylophone"), text: "best" },
			...Array.from({ length: 9 }, (_, i) => ({
				index: i + 1,
				tokens: tokenize(`common filler padding words ${i}`),
				text: `weak${i}`,
			})),
		];
		const index = buildIndex(corpus);
		const hits = searchIndex(index, corpus, "common quokka");
		assert.strictEqual(hits.length, 1, "weak common-only hits fall below the floor");
		assert.strictEqual(hits[0]!.index, 0);
		assert.ok(RELATIVE_SCORE_FLOOR > 0 && RELATIVE_SCORE_FLOOR < 1);
	});

	it("returns empty for empty query", () => {
		const index = buildIndex(docs);
		assert.deepStrictEqual(searchIndex(index, docs, "!!!"), []);
	});
});

describe("searchMemory — provenance", () => {
	it("returns hits with artifact path and 1-based line numbers", () => {
		const dir = tempDir();
		const projectFile = join(dir, "projects", "p1", "MEMORY.md");
		retainEntry(projectFile, "project", "the deploy pipeline uses blue-green releases");
		retainEntry(projectFile, "project", "unrelated note");
		const hits = searchMemory([{ file: projectFile, kind: "project" }], "blue-green deploy");
		assert.strictEqual(hits.length, 1);
		assert.strictEqual(hits[0]!.file, projectFile);
		const lines = readFileSync(projectFile, "utf-8").split("\n");
		assert.strictEqual(lines[hits[0]!.line - 1]!.includes("blue-green"), true, "line number points at the entry");
	});
});

describe("buildMemoryInjection — budget, scope, empty", () => {
	it("returns null for skeleton-only memory", () => {
		const dir = tempDir();
		assert.strictEqual(buildMemoryInjection({ dataDir: dir, cwd: "/repo/alpha", scope: "project" }), null);
	});

	it("injects project memory with the heuristic-not-facts preamble and artifact path", () => {
		const dir = tempDir();
		const paths = memoryPaths(dir, "/repo/alpha");
		retainEntry(paths.projectFile, "project", "integration tests need docker");
		const block = buildMemoryInjection({ dataDir: dir, cwd: "/repo/alpha", scope: "project" })!;
		assert.ok(block.includes("heuristics, not facts"));
		assert.ok(block.includes("repository wins"));
		assert.ok(block.includes("integration tests need docker"));
		assert.ok(block.includes(paths.projectFile), "cites the artifact path");
	});

	it("scope=project excludes global memory; scope=global includes it", () => {
		const dir = tempDir();
		const paths = memoryPaths(dir, "/repo/alpha");
		retainEntry(paths.projectFile, "project", "project-only fact");
		retainEntry(paths.globalFile, "global", "global-only fact");
		const projectOnly = buildMemoryInjection({ dataDir: dir, cwd: "/repo/alpha", scope: "project" })!;
		assert.ok(!projectOnly.includes("global-only fact"));
		const withGlobal = buildMemoryInjection({ dataDir: dir, cwd: "/repo/alpha", scope: "global" })!;
		assert.ok(withGlobal.includes("global-only fact"));
		assert.ok(withGlobal.includes("project-only fact"));
	});

	it("two projects are isolated by pid", () => {
		const dir = tempDir();
		const alpha = memoryPaths(dir, "/repo/alpha");
		const beta = memoryPaths(dir, "/repo/beta");
		retainEntry(alpha.projectFile, "project", "alpha secret");
		const forBeta = buildMemoryInjection({ dataDir: dir, cwd: "/repo/beta", scope: "global" });
		assert.strictEqual(forBeta, null, "beta sees nothing from alpha");
	});

	it("truncates oversized content to the token budget", () => {
		const long = Array.from({ length: 200 }, (_, i) => `- entry ${i} ${"x".repeat(100)}`).join("\n");
		const { text, truncated } = truncateToBudget(long, 100);
		assert.strictEqual(truncated, true);
		assert.ok(estimateTokens(text) <= 200, "stays near the budget (truncation note adds a little)");
		assert.ok(text.includes("memory truncated to fit the 100-token budget"));
		const untouched = truncateToBudget("short", 100);
		assert.strictEqual(untouched.truncated, false);
	});
});
