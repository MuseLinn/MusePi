import { describe, expect, test } from "bun:test";
import { resolveModelCapabilities } from "@musepi/pi-catalog/identity";

describe("resolveModelCapabilities", () => {
	test("text-only model advertises only the text capability", () => {
		const caps = resolveModelCapabilities("deepseek-v4-flash", ["text"]);
		expect(caps).toEqual({ text: true, image: false, video: false, imageGen: false, videoGen: false });
	});

	test("missing input modalities default to text (universal input)", () => {
		const caps = resolveModelCapabilities("custom-model", undefined);
		expect(caps.text).toBe(true);
		expect(caps.image).toBe(false);
		expect(caps.video).toBe(false);
	});

	test("image modalities surface image understanding but not generation", () => {
		const caps = resolveModelCapabilities("claude-opus-4.7", ["text", "image"]);
		expect(caps.image).toBe(true);
		expect(caps.video).toBe(false);
		expect(caps.imageGen).toBe(false);
		expect(caps.videoGen).toBe(false);
	});

	test("video input modality surfaces video understanding (kimi-k3 in models.dev)", () => {
		const caps = resolveModelCapabilities("moonshotai/kimi-k3", ["text", "image", "video"]);
		expect(caps.image).toBe(true);
		expect(caps.video).toBe(true);
		expect(caps.imageGen).toBe(false);
	});

	test("hosted image-generation ids surface imageGen (gpt-image, agnes-image, DALL-E, flux)", () => {
		expect(resolveModelCapabilities("openai/gpt-image-2", ["text"]).imageGen).toBe(true);
		expect(resolveModelCapabilities("agnes-image-3.0-flash", ["text", "image"]).imageGen).toBe(true);
		expect(resolveModelCapabilities("dall-e-3", ["text"]).imageGen).toBe(true);
		expect(resolveModelCapabilities("flux-1-dev", ["text"]).imageGen).toBe(true);
		// Plain chat ids never light the generation flags.
		expect(resolveModelCapabilities("gpt-5.4", ["text"]).imageGen).toBe(false);
	});

	test("hosted video-generation ids surface videoGen (agnes-video, veo, sora)", () => {
		expect(resolveModelCapabilities("agnes-video-v2.0", ["text"]).videoGen).toBe(true);
		expect(resolveModelCapabilities("veo-3", ["text"]).videoGen).toBe(true);
		expect(resolveModelCapabilities("sora-2", ["text"]).videoGen).toBe(true);
		expect(resolveModelCapabilities("kimi-k3", ["text", "image"]).videoGen).toBe(false);
	});

	test("kimi-k3 restores video understanding when bundled input omits it", () => {
		// The bundled models.json declares kimi-k3 as text|image only; the
		// family check restores video so surfaces never under-render it.
		const caps = resolveModelCapabilities("moonshotai/kimi-k3", ["text", "image"]);
		expect(caps.video).toBe(true);
		expect(caps.image).toBe(true);
	});
});
