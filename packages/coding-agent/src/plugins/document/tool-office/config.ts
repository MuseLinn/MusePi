import { z } from "@musepi/pi-coding-agent/plugin-config";

/** Office skill admission and render bounds. */
export interface Config {
	activationSkills: string[];
	maxChars: number;
	maxImages: number;
	maxBytes: number;
}

export const Config = z.object({
	activationSkills: z
		.array(z.string())
		.min(1)
		.default(() => ["office", "office-docx", "office-xlsx", "office-pptx"])
		.describe("Skills whose successful load admits the Office tools from the next step."),
	maxChars: z.number().min(1000).max(500000).default(120000).describe("Default character ceiling for converted text."),
	maxImages: z.number().min(1).max(10000).default(20).describe("Most images one render returns."),
	maxBytes: z
		.number()
		.min(1)
		.max(Number.MAX_SAFE_INTEGER)
		.default(32 * 1024 * 1024)
		.describe("Most PNG bytes across all images of one render."),
});
