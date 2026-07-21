import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeProjectId } from "@musepi/core";
import { afterEach, describe, expect, it } from "vitest";
import {
	initMusepiMemoryForTest,
	musepiMemoryToolDef,
	transformMusepiMemoryContext,
} from "../src/musepi/memory-native.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-memory-native-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	initMusepiMemoryForTest(null);
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

function makeBinding(
	dataDir: string,
	cwd: string,
	overrides: Partial<Parameters<typeof initMusepiMemoryForTest>[0]> = {},
) {
	return {
		enabled: true,
		cwd,
		dataDir,
		scope: "project" as const,
		caps: { project: 10_000, global: 6_000 },
		injected: false,
		...overrides,
	};
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

async function execute(params: Record<string, unknown>) {
	return musepiMemoryToolDef.execute("call-1", params, undefined, undefined, {} as never);
}

describe("musepi memory — disabled", () => {
	it("no binding: transform passes messages through untouched and tool errors politely", async () => {
		initMusepiMemoryForTest(null);
		const messages = [{ role: "user", content: [] }];
		expect(transformMusepiMemoryContext(messages)).toBe(messages);
		await expect(execute({ operation: "search", query: "x" })).rejects.toThrow(/memory is not enabled/);
	});
});

describe("musepi memory — injection", () => {
	it("injects once, one-shot, with budgeted block", async () => {
		const dataDir = await createTempDir();
		const cwd = await createTempDir();
		initMusepiMemoryForTest(makeBinding(dataDir, cwd));
		// Seed a fact through the tool itself.
		await execute({ operation: "retain", text: "deploys run through terraform" });

		const messages = [{ role: "user", content: [] }];
		const first = transformMusepiMemoryContext(messages);
		expect(first.length).toBe(2);
		const injected = (first[1] as { content: Array<{ text: string }> }).content[0]!.text;
		expect(injected).toContain("heuristics, not facts");
		expect(injected).toContain("deploys run through terraform");
		expect(injected).toContain(computeProjectId(cwd));

		const second = transformMusepiMemoryContext(first);
		// one-shot: later requests pass through
		expect(second).toBe(first);
	});

	it("injects nothing when memory is skeleton-only", async () => {
		const dataDir = await createTempDir();
		const cwd = await createTempDir();
		initMusepiMemoryForTest(makeBinding(dataDir, cwd));
		const messages = [{ role: "user", content: [] }];
		expect(transformMusepiMemoryContext(messages)).toBe(messages);
	});
});

describe("musepi memory tool — retain / search / edit", () => {
	it("retain then search returns the entry with path:line, edit rewrites it", async () => {
		const dataDir = await createTempDir();
		const cwd = await createTempDir();
		initMusepiMemoryForTest(makeBinding(dataDir, cwd));

		const retained = await execute({ operation: "retain", text: "the api gateway listens on 8443" });
		expect(textOf(retained as never)).toContain("Retained at");

		// Adjacent duplicate is skipped.
		const dup = await execute({ operation: "retain", text: "the api gateway listens on 8443" });
		expect(textOf(dup as never)).toContain("Skipped");

		const found = await execute({ operation: "search", query: "gateway port" });
		const foundText = textOf(found as never);
		expect(foundText).toContain("8443");
		expect(foundText).toMatch(/MEMORY\.md:\d+:/);

		const edited = await execute({
			operation: "edit",
			anchor: "listens on 8443",
			replacement: "- the api gateway listens on 9443",
		});
		expect(textOf(edited as never)).toContain("Rewrote");

		const projectFile = join(dataDir, "memory", "projects", computeProjectId(cwd), "MEMORY.md");
		const content = await readFile(projectFile, "utf-8");
		expect(content).toContain("9443");
		expect(content).not.toContain("8443");
	});

	it("retain validates section names", async () => {
		const dataDir = await createTempDir();
		const cwd = await createTempDir();
		initMusepiMemoryForTest(makeBinding(dataDir, cwd));
		await expect(execute({ operation: "retain", text: "x", section: "Nope" })).rejects.toThrow(/unknown section/);
	});

	it("scope=global retains into the global file and search covers it when scope=global", async () => {
		const dataDir = await createTempDir();
		const cwd = await createTempDir();
		initMusepiMemoryForTest(makeBinding(dataDir, cwd, { scope: "global" }));
		await execute({ operation: "retain", text: "editorconfig is mandatory everywhere", scope: "global" });
		const found = await execute({ operation: "search", query: "editorconfig" });
		const foundText = textOf(found as never);
		expect(foundText).toContain("editorconfig");
		expect(foundText).toContain("global");
	});
});
