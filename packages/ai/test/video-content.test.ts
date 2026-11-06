import { describe, expect, it } from "bun:test";
import { convertMessages } from "@musepi/pi-ai/providers/google-shared";
import {
	NON_VIDEO_PLACEHOLDER,
	partitionVisionContent,
	replaceVideoWithPlaceholder,
} from "@musepi/pi-ai/providers/vision-guard";
import type { Context, Model, Usage, VideoContent } from "@musepi/pi-ai/types";
import { buildModel } from "@musepi/pi-catalog/build";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function googleModel(id: string, input: Array<"text" | "image" | "video">): Model<"google-generative-ai"> {
	return buildModel({
		id,
		name: id,
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

const VIDEO: VideoContent = { type: "video", mimeType: "video/mp4", url: "https://cdn.example/clip.mp4" };

function context(content: Context["messages"][number]["content"]): Context {
	return { messages: [{ role: "user", content, timestamp: 1 }], tools: [] } as Context;
}

describe("video content boundary", () => {
	it("Gemini models that declare video input receive a file part", () => {
		const contents = convertMessages(googleModel("gemini-3-pro", ["text", "image", "video"]), context([VIDEO]));
		const parts = contents[0]?.parts ?? [];
		expect(parts).toContainEqual({ fileData: { fileUri: "https://cdn.example/clip.mp4", mimeType: "video/mp4" } });
	});

	it("Gemini models without video input get an honest marker instead of the bytes", () => {
		const contents = convertMessages(googleModel("gemini-2.5-flash", ["text", "image"]), context([VIDEO]));
		const text = (contents[0]?.parts ?? []).map(part => ("text" in part ? part.text : "")).join("\n");
		expect(text).toContain(NON_VIDEO_PLACEHOLDER);
	});

	it("providers without a video channel degrade the block to a marker", () => {
		const content = [{ type: "text" as const, text: "look" }, VIDEO];
		const degraded = replaceVideoWithPlaceholder(content);
		expect(degraded).toEqual([
			{ type: "text", text: "look" },
			{ type: "text", text: NON_VIDEO_PLACEHOLDER },
		]);
		// No video block → the same array reference (cheap identity check).
		const textOnly = [{ type: "text" as const, text: "look" }];
		expect(replaceVideoWithPlaceholder(textOnly)).toBe(textOnly);
	});

	it("partitionVisionContent reports a dropped video", () => {
		const partition = partitionVisionContent([VIDEO], true);
		expect(partition.omittedVideos).toBe(true);
		expect(partition.imageBlocks).toEqual([]);
		expect(ZERO_USAGE.totalTokens).toBe(0);
	});
});
