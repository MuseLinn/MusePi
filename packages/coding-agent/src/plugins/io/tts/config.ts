import { z } from "@musepi/pi-coding-agent/plugin-config";

/**
 * The plugin's declared config (the declared config): the host validates the
 * effective values through this schema, fills defaults, and derives the
 * management form from `toJsonSchema()`. The manifest no longer carries a
 * parallel field table.
 */
export interface Config {
	"tts.localModel": "kokoro" | "melotts-zh";
	"tts.localVoice":
		| "af_heart"
		| "af_bella"
		| "af_nicole"
		| "af_aoede"
		| "af_kore"
		| "af_sarah"
		| "am_michael"
		| "am_fenrir"
		| "am_puck"
		| "bf_emma"
		| "bm_george"
		| "bm_fable"
		| "default";
	"tts.rate": number;
	"tts.inputMode": "raw" | "sanitize" | "summarize";
	"tts.autoRead": boolean;
}

export const Config = z.object({
	"tts.localModel": z.enum(["kokoro", "melotts-zh"]).default("kokoro").describe("选择默认的本地语音合成模型。"),
	"tts.localVoice": z
		.enum([
			"af_heart",
			"af_bella",
			"af_nicole",
			"af_aoede",
			"af_kore",
			"af_sarah",
			"am_michael",
			"am_fenrir",
			"am_puck",
			"bf_emma",
			"bm_george",
			"bm_fable",
			"default",
		])
		.default("af_heart")
		.describe("选择合成语音的默认音色。"),
	"tts.rate": z.number().min(0.5).max(2).default(1).describe("调整朗读速度，范围为 0.5 至 2 倍。"),
	"tts.inputMode": z
		.enum(["raw", "sanitize", "summarize"])
		.default("sanitize")
		.describe("选择朗读前保留、清理或总结文本。"),
	"tts.autoRead": z.boolean().default(false).describe("助手回复完成后自动开始朗读。"),
});
