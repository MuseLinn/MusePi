import { z } from "@musepi/pi-coding-agent/plugin-config";

/**
 * The plugin's declared config (dsh's `Config`): the host validates the
 * effective values through this schema, fills defaults, and derives the
 * management form from `toJsonSchema()`. The manifest no longer carries a
 * parallel field table.
 */
export interface Config {
	"stt.modelName": "fast" | "balanced" | "turbo" | "parakeet" | "sensevoice";
	"stt.language": string;
	"stt.vadEndMs": number;
	"stt.submitTrigger": "never" | "release" | "release-complete" | "say-submit";
}

export const Config = z.object({
	"stt.modelName": z
		.enum(["fast", "balanced", "turbo", "parakeet", "sensevoice"])
		.default("balanced")
		.describe("选择默认的本地语音转写模型。"),
	"stt.language": z.string().default("").describe("留空时自动检测语言。"),
	"stt.vadEndMs": z.number().default(700).describe("连续静音达到该毫秒数后结束录音。"),
	"stt.submitTrigger": z
		.enum(["never", "release", "release-complete", "say-submit"])
		.default("never")
		.describe("选择听写完成后是否以及如何提交。"),
});
