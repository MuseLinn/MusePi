import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeMusepiSettings } from "@musepi/core";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createHashlineContext } from "../src/musepi/hashline.ts";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-hashline-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

const FILE_CONTENT = ["alpha", "beta", "gamma", "delta"].join("\n");

function enabledContext() {
	const settings = mergeMusepiSettings({ edit: { hashline: true } });
	const ctx = createHashlineContext(settings);
	if (!ctx) throw new Error("expected hashline context");
	return ctx;
}

describe("hashline seam — read tool", () => {
	it("prefixes output with [path#TAG] and numbers displayed lines", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "a.txt"), FILE_CONTENT);
		const hashline = enabledContext();
		const read = createReadToolDefinition(dir, { hashline });
		const result = await read.execute("call-1", { path: "a.txt" }, undefined, undefined, {} as ExtensionContext);
		const text = textOf(result as never);
		const lines = text.split("\n");
		expect(lines[0]).toMatch(/^\[a\.txt#[0-9A-F]{4}\]$/);
		expect(lines[1]).toBe("1:alpha");
		expect(lines[4]).toBe("4:delta");
	});

	it("numbers partial reads from the offset and records only displayed lines", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "a.txt"), FILE_CONTENT);
		const hashline = enabledContext();
		const read = createReadToolDefinition(dir, { hashline });
		const result = await read.execute(
			"call-1",
			{ path: "a.txt", offset: 2, limit: 2 },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const text = textOf(result as never);
		expect(text).toContain("2:beta");
		expect(text).toContain("3:gamma");
		expect(text).not.toContain("1:alpha");
		// seen-line provenance is sparse: only lines 2-3
		const snapshot = hashline.store.head(join(dir, "a.txt"));
		expect(snapshot?.seenLines?.has(2)).toBe(true);
		expect(snapshot?.seenLines?.has(4)).toBe(false);
	});

	it("keeps pi-native output when hashline is disabled", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "a.txt"), FILE_CONTENT);
		const read = createReadToolDefinition(dir);
		const result = await read.execute("call-1", { path: "a.txt" }, undefined, undefined, {} as ExtensionContext);
		const text = textOf(result as never);
		expect(text).toBe(FILE_CONTENT);
	});
});

describe("hashline seam — edit tool", () => {
	async function readAndTag(dir: string, hashline: ReturnType<typeof enabledContext>, path = "a.txt") {
		const read = createReadToolDefinition(dir, { hashline });
		const result = await read.execute("call-read", { path }, undefined, undefined, {} as ExtensionContext);
		const header = textOf(result as never).split("\n")[0]!;
		const match = /^\[(.+)#([0-9A-F]{4})\]$/.exec(header);
		if (!match) throw new Error(`no hashline header in read output: ${header}`);
		return { tag: match[2]! };
	}

	it("applies a tag-anchored patch end-to-end and returns a fresh tag", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "a.txt"), FILE_CONTENT);
		const hashline = enabledContext();
		const { tag } = await readAndTag(dir, hashline);

		const edit = createEditToolDefinition(dir, { hashline });
		const result = await edit.execute(
			"call-edit",
			{ patch: `[a.txt#${tag}]\nSWAP 2:\n+BETA` } as never,
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe(["alpha", "BETA", "gamma", "delta"].join("\n"));
		const text = textOf(result as never);
		expect(text).toMatch(/\[a\.txt#[0-9A-F]{4}\] — applied/);
		expect(text).toContain("fresh tags");
		expect((result as { details?: { firstChangedLine?: number } }).details?.firstChangedLine).toBe(2);
	});

	it("rejects a stale tag with an actionable re-read message", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "a.txt"), FILE_CONTENT);
		const hashline = enabledContext();
		const { tag } = await readAndTag(dir, hashline);
		// External modification of an anchored line
		await writeFile(join(dir, "a.txt"), ["alpha", "changed", "gamma", "delta"].join("\n"));

		const edit = createEditToolDefinition(dir, { hashline });
		await expect(
			edit.execute(
				"call-edit",
				{ patch: `[a.txt#${tag}]\nSWAP 2:\n+BETA` } as never,
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow(/Re-read the file with the read tool/);
		expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe(["alpha", "changed", "gamma", "delta"].join("\n"));
	});

	it("recovers a stale tag when external edits only shifted lines", async () => {
		const dir = await createTempDir();
		await writeFile(join(dir, "a.txt"), FILE_CONTENT);
		const hashline = enabledContext();
		const { tag } = await readAndTag(dir, hashline);
		await writeFile(join(dir, "a.txt"), ["inserted head", ...FILE_CONTENT.split("\n")].join("\n"));

		const edit = createEditToolDefinition(dir, { hashline });
		const result = await edit.execute(
			"call-edit",
			{ patch: `[a.txt#${tag}]\nSWAP 2:\n+BETA` } as never,
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(await readFile(join(dir, "a.txt"), "utf-8")).toBe(
			["inserted head", "alpha", "BETA", "gamma", "delta"].join("\n"),
		);
		expect(textOf(result as never)).toContain("recovered from a stale tag");
	});

	it("uses the hashline patch schema and description", () => {
		const hashline = enabledContext();
		const edit = createEditToolDefinition(process.cwd(), { hashline });
		expect(edit.parameters.properties).toHaveProperty("patch");
		expect(edit.parameters.properties).not.toHaveProperty("edits");
		expect(edit.description).toContain("hashline patch");
	});

	it("keeps the pi-native schema when hashline is disabled", () => {
		const edit = createEditToolDefinition(process.cwd());
		expect(edit.parameters.properties).toHaveProperty("edits");
		expect(edit.parameters.properties).not.toHaveProperty("patch");
	});
});
