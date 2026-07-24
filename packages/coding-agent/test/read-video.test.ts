import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadTool, createReadToolDefinition } from "../src/index.ts";

// Only `model.input` is consulted by the read tool's capability notes.
const textOnlyModel = { input: ["text"] } as any;
const videoModel = { input: ["text", "image", "video"] } as any;

// The definition (not the wrapped AgentTool) receives the extension context
// carrying the active model.
const readDefinition = createReadToolDefinition(process.cwd());

const readTool = createReadTool(process.cwd());

function createTinyMp4(): Buffer {
	// Minimal ISO-BMFF header: ftyp box with isom major brand.
	return Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00]);
}

describe("read tool video support", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-read-video-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("returns a video content block for mp4 files", async () => {
		const testFile = join(testDir, "clip.mp4");
		writeFileSync(testFile, createTinyMp4());

		const result = await readTool.execute("test-video-1", { path: testFile });

		const textBlock = result.content.find((c: any) => c.type === "text") as { text: string } | undefined;
		expect(textBlock?.text).toContain("Read video file [video/mp4]");

		const videoBlock = result.content.find((c: any) => c.type === "video") as
			| { data: string; mimeType: string }
			| undefined;
		expect(videoBlock).toBeTruthy();
		expect(videoBlock?.mimeType).toBe("video/mp4");
		expect(Buffer.from(videoBlock!.data, "base64").equals(createTinyMp4())).toBe(true);
	});

	it("warns and still attaches when the model lacks video input", async () => {
		const testFile = join(testDir, "clip.mp4");
		writeFileSync(testFile, createTinyMp4());

		const result = await readDefinition.execute("test-video-2", { path: testFile }, undefined, undefined, {
			model: textOnlyModel,
		} as any);

		const textBlock = result.content.find((c: any) => c.type === "text") as { text: string } | undefined;
		expect(textBlock?.text).toContain("Current model does not support videos");
		// The video block is still attached; transformMessages drops it for the wire.
		expect(result.content.some((c: any) => c.type === "video")).toBe(true);
	});

	it("omits the support note for models with video input", async () => {
		const testFile = join(testDir, "clip.mp4");
		writeFileSync(testFile, createTinyMp4());

		const result = await readDefinition.execute("test-video-3", { path: testFile }, undefined, undefined, {
			model: videoModel,
		} as any);

		const textBlock = result.content.find((c: any) => c.type === "text") as { text: string } | undefined;
		expect(textBlock?.text).not.toContain("does not support videos");
		expect(result.content.some((c: any) => c.type === "video")).toBe(true);
	});

	it("returns a text-only note for empty video files", async () => {
		const testFile = join(testDir, "empty.mp4");
		writeFileSync(testFile, createTinyMp4().subarray(0, 0));

		// An empty file has no ftyp signature, so it falls through to text reading.
		const result = await readTool.execute("test-video-4", { path: testFile });
		expect(result.content.every((c: any) => c.type === "text")).toBe(true);
	});

	it("still reads text files as text", async () => {
		const testFile = join(testDir, "notes.txt");
		writeFileSync(testFile, "hello world");

		const result = await readTool.execute("test-video-5", { path: testFile });
		expect(result.content.every((c: any) => c.type === "text")).toBe(true);
	});
});
