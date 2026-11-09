import { isDashscopeCompatibleModeUrl, modelMatchesHost } from "@musepi/pi-catalog/hosts";
import { isDeepseekModelIdOrName, isQwenModelId } from "@musepi/pi-catalog/identity";
import { $env } from "@musepi/pi-utils";

import type { ImageContent, Model, TextContent, VideoContent } from "../types";

export const NON_VISION_IMAGE_PLACEHOLDER = "[image omitted: model does not support vision]";
export const NON_VIDEO_PLACEHOLDER = "[video omitted: provider has no video input]";

export function partitionVisionContent(
	content: ReadonlyArray<TextContent | ImageContent | VideoContent>,
	supportsImages: boolean,
): {
	textBlocks: TextContent[];
	imageBlocks: ImageContent[];
	omittedImages: boolean;
	/** A video block was present; the caller appends NON_VIDEO_PLACEHOLDER. */
	omittedVideos: boolean;
} {
	const textBlocks = content.filter((block): block is TextContent => block.type === "text");
	const imageBlocks = content.filter((block): block is ImageContent => block.type === "image");
	return {
		textBlocks,
		imageBlocks: supportsImages ? imageBlocks : [],
		omittedImages: !supportsImages && imageBlocks.length > 0,
		omittedVideos: content.some(block => block.type === "video"),
	};
}

export function joinTextWithImagePlaceholder(text: string, omittedImages: boolean, omittedVideos = false): string {
	const parts: string[] = [];
	if (text.length > 0) {
		parts.push(text);
	}
	if (omittedImages) {
		parts.push(NON_VISION_IMAGE_PLACEHOLDER);
	}
	if (omittedVideos) {
		parts.push(NON_VIDEO_PLACEHOLDER);
	}
	return parts.join("\n");
}

/**
 * Replace video blocks with a text marker for a provider whose wire has no
 * video input channel. Returns the input unchanged (same reference) when there
 * is nothing to degrade, so callers can keep cheap identity checks.
 */
export function replaceVideoWithPlaceholder(
	content: string | ReadonlyArray<TextContent | ImageContent | VideoContent>,
): string | ReadonlyArray<TextContent | ImageContent> {
	if (typeof content === "string") return content;
	if (!content.some(block => block.type === "video")) {
		return content as ReadonlyArray<TextContent | ImageContent>;
	}
	return content.map(block =>
		block.type === "video" ? { type: "text" as const, text: NON_VIDEO_PLACEHOLDER } : block,
	);
}

/**
 * Detect known text-only Qwen models served via Alibaba DashScope's consumer
 * `compatible-mode` endpoint that the upstream chat-completions API rejects
 * multimodal content arrays for. The compatible-mode endpoint also serves
 * multimodal Qwen SKUs without `vl` in the id (e.g. `qwen3.7-plus`), so this
 * guard only covers families verified to be text-only for issue #1859:
 * `qwen*-coder*` and `qwen*-max` up to and including `qwen3.7-max`.
 *
 * Qwen-Max became multimodal at `qwen3.8-max` (image input, issue #8019), so
 * `-max` SKUs at version 3.8 or newer are excluded — otherwise the override
 * would strip images from a genuinely vision-capable flagship (issue #8305).
 *
 * Used as a defensive override in `convertMessages` so a misconfigured custom
 * provider (issue #1859) can't drive the request into an unrecoverable 400.
 */
export function isDashscopeCompatibleModeTextOnlyQwen(model: Model<"openai-completions">): boolean {
	if (!isDashscopeCompatibleModeUrl(model.baseUrl)) {
		return false;
	}
	if (!isQwenModelId(model.id)) return false;
	const id = model.id.toLowerCase();
	if (/\bqwen(?:[\d.]+)?-coder\b/.test(id)) return true;
	const maxMatch = id.match(/\bqwen(?:(\d+)(?:\.(\d+))?)?-max\b/);
	if (!maxMatch) return false;
	// Bare `qwen-max` (no version) is the text-only 2.5-era flagship. Compare
	// major/minor component-wise, not as a decimal float, so `qwen3.10-max`
	// sorts after `qwen3.8-max`: text-only through 3.7, multimodal from 3.8 on.
	const major = maxMatch[1] ? Number.parseInt(maxMatch[1], 10) : 0;
	const minor = maxMatch[2] ? Number.parseInt(maxMatch[2], 10) : 0;
	return major < 3 || (major === 3 && minor < 8);
}

/**
 * Detect known text-only DeepSeek models served via OpenAI-compatible Chat
 * Completions endpoints whose server-side deserializers reject `image_url`
 * content parts with HTTP 400 (`unknown variant \`image_url\`, expected \`text\``).
 *
 * Used as a defensive override in `convertMessages` so misconfigured model
 * definitions or user overrides (e.g. `models.yml` claiming `input: [text, image]`)
 * do not crash the session with an unrecoverable 400.
 *
 * Multimodal SKUs are carved out by *name*, mirroring upstream's
 * `compat/rules/classes/deepseek.kdl` (strip on the class, re-enable per
 * token): `ocr` and `vision` there, plus `v4.1-flash` here — upstream carries
 * no V4.1 entry to inherit from, and both the models.dev catalog and the
 * command-code gateway advertise image input for it.
 */
export function isTextOnlyDeepSeek(model: Model<"openai-completions">): boolean {
	const id = model.id.toLowerCase();
	const name = (model.name ?? "").toLowerCase();
	if (id.includes("ocr") || name.includes("ocr")) return false;
	if (id.includes("vision") || name.includes("vision")) return false;
	const compact = `${id} ${name}`.replace(/[^a-z0-9]/g, "");
	if (compact.includes("v41flash")) return false;
	return (
		modelMatchesHost(model, "deepseekFamily") ||
		isDeepseekModelIdOrName(model.id) ||
		isDeepseekModelIdOrName(model.name ?? "") ||
		model.provider === "deepseek"
	);
}

/**
 * Evaluates whether an OpenAI-compatible Chat Completions model genuinely
 * supports multimodal image inputs on the wire. Defensive guards override
 * misconfigured provider descriptors or user model entries (e.g. text-only
 * DashScope Qwen SKUs, DeepSeek models) whose endpoints reject `image_url`.
 */
export function isOpenAICompletionsVisionSupported(model: Model<"openai-completions">): boolean {
	if (!model.input.includes("image")) return false;
	if (isDashscopeCompatibleModeTextOnlyQwen(model)) return false;
	if (isTextOnlyDeepSeek(model)) return false;
	return true;
}

/**
 * Whether the transport that will carry `model` sends image content on the
 * wire. The `pi-native` transport forwards the original context to the
 * gateway, which resolves its own model server-side, so the declared input
 * applies. OpenAI Chat Completions (and OpenRouter's chat fallback) runs the
 * text-only guards above; every other API ships the modalities the model
 * declares.
 */
export function sendsImageInputOnWire(model: Model): boolean {
	if (model.transport === "pi-native") return model.input.includes("image");
	if (model.api === "openai-completions") {
		return isOpenAICompletionsVisionSupported(model as Model<"openai-completions">);
	}
	if (model.api === "openrouter" && $env.PI_OPENROUTER_RESPONSES === "0") {
		return isOpenAICompletionsVisionSupported(model as Model<"openai-completions">);
	}
	return model.input.includes("image");
}
