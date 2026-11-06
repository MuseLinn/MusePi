import { describe, expect, it } from "bun:test";
import type { Context, Model } from "@musepi/pi-ai";
import { buildModel } from "@musepi/pi-catalog/build";
import { TempDir } from "@musepi/pi-utils";

import { ProviderFileCache, type ProviderFileClient } from "../src/blob-broker/provider-file-types";
import { ProviderFileManager } from "../src/blob-broker/provider-files";

function model(input: Array<"text" | "image" | "video">): Model<"google-generative-ai"> {
	return buildModel({
		id: "gemini-3-pro",
		name: "gemini-3-pro",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		reasoning: false,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 8192,
	});
}

function userVideoContext(url: string): Context {
	return {
		messages: [{ role: "user", content: [{ type: "video", mimeType: "video/mp4", url }], timestamp: 1 }],
		tools: [],
	} as unknown as Context;
}

function stubClient(uploads: { bytes: number; mime: string }[]): ProviderFileClient {
	return {
		provider: "google",
		async upload(request) {
			uploads.push({ bytes: request.bytes.byteLength, mime: request.mimeType });
			return {
				provider: "google",
				id: "files/abc",
				uri: "https://generativelanguage.googleapis.com/v1beta/files/abc",
				mimeType: request.mimeType,
				bytes: request.bytes.byteLength,
				delete: {
					method: "DELETE",
					url: "https://generativelanguage.googleapis.com/v1beta/files/abc",
					headers: {},
				},
			};
		},
		async delete() {},
	};
}

describe("provider-file video decoration", () => {
	it("uploads a local file:// clip and attaches the provider reference to the request copy", async () => {
		using tempDir = TempDir.createSync("@provider-file-video-");
		const clip = `${tempDir.path()}/clip.mp4`;
		await Bun.write(clip, new Uint8Array([9, 8, 7]));
		const uploads: { bytes: number; mime: string }[] = [];
		const manager = new ProviderFileManager(
			new ProviderFileCache(`${tempDir.path()}/index.json`),
			async () => "credential",
			[() => stubClient(uploads)],
		);

		const context = userVideoContext(`file://${clip}`);
		const decorated = await manager.decorateContext(context, model(["text", "video"]));
		const content = decorated.messages[0]?.content;
		if (!Array.isArray(content)) throw new Error("expected decorated content array");
		const block = content[0] as { providerFile?: { uri?: string } };
		expect(uploads).toEqual([{ bytes: 3, mime: "video/mp4" }]);
		expect(block.providerFile?.uri).toContain("files/abc");
		// The session context is never mutated: only the provider copy is decorated.
		const originalContent = context.messages[0]?.content;
		if (!Array.isArray(originalContent)) throw new Error("expected original content array");
		expect((originalContent[0] as { providerFile?: unknown }).providerFile).toBeUndefined();
	});

	it("does not touch a local clip for a model without video input", async () => {
		using tempDir = TempDir.createSync("@provider-file-video-");
		const clip = `${tempDir.path()}/clip.mp4`;
		await Bun.write(clip, new Uint8Array([1]));
		const uploads: { bytes: number; mime: string }[] = [];
		const manager = new ProviderFileManager(
			new ProviderFileCache(`${tempDir.path()}/index.json`),
			async () => "credential",
			[() => stubClient(uploads)],
		);

		const context = userVideoContext(`file://${clip}`);
		const decorated = await manager.decorateContext(context, model(["text", "image"]));
		expect(uploads).toEqual([]);
		expect(decorated).toBe(context);
	});
});
