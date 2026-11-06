import { describe, expect, it } from "bun:test";
import type { Model, VideoContent } from "@musepi/pi-ai";
import { buildModel } from "@musepi/pi-catalog/build";
import { TempDir } from "@musepi/pi-utils";

import { fileUrlPath, normalizeModelContextVideos } from "../src/utils/video-loading";

function model(input: Array<"text" | "image" | "video">): Model<"google-generative-ai"> {
	return buildModel({
		id: "gemini-3-pro",
		name: "gemini-3-pro",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://example.com",
		reasoning: false,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 8192,
	});
}

describe("fileUrlPath", () => {
	it("decodes percent-encoded local paths and ignores other sources", () => {
		expect(fileUrlPath("file:///tmp/a%20b.mp4")).toBe("/tmp/a b.mp4");
		expect(fileUrlPath("file:///tmp/%E8%A7%86%E9%A2%91.mp4")).toBe("/tmp/视频.mp4");
		expect(fileUrlPath("https://cdn.example/a.mp4")).toBeNull();
		expect(fileUrlPath(undefined)).toBeNull();
	});
});

describe("normalizeModelContextVideos", () => {
	it("inlines a local clip for a model that declares video input", async () => {
		using tempDir = TempDir.createSync("@video-loading-");
		const path = `${tempDir.path()}/clip.mp4`;
		await Bun.write(path, new Uint8Array([1, 2, 3, 4]));
		const videos: VideoContent[] = [{ type: "video", mimeType: "video/mp4", url: `file://${path}` }];

		const normalized = await normalizeModelContextVideos(videos, { model: model(["text", "video"]) });
		expect(normalized?.[0]?.data).toBe(Buffer.from([1, 2, 3, 4]).toString("base64"));
		// The reference stays alongside the bytes (the transcript keeps playing it).
		expect(normalized?.[0]?.url).toBe(`file://${path}`);
	});

	it("leaves remote clips and non-video models untouched", async () => {
		const remote: VideoContent[] = [{ type: "video", mimeType: "video/mp4", url: "https://cdn.example/a.mp4" }];
		const same = await normalizeModelContextVideos(remote, { model: model(["text", "video"]) });
		expect(same?.[0]).toBe(remote[0]);

		const local: VideoContent[] = [{ type: "video", mimeType: "video/mp4", url: "file:///tmp/missing.mp4" }];
		const untouched = await normalizeModelContextVideos(local, { model: model(["text", "image"]) });
		expect(untouched?.[0]).toBe(local[0]);
	});

	it("keeps an unreadable local reference instead of dropping the block", async () => {
		const local: VideoContent[] = [{ type: "video", mimeType: "video/mp4", url: "file:///no/such/clip.mp4" }];
		const normalized = await normalizeModelContextVideos(local, { model: model(["text", "video"]) });
		expect(normalized).toHaveLength(1);
		expect(normalized?.[0]?.data).toBeUndefined();
		expect(normalized?.[0]?.url).toBe("file:///no/such/clip.mp4");
	});
});
