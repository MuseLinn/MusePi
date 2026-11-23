import { z } from "@musepi/pi-coding-agent/plugin-config";

/** Office extraction limits. */
export interface Config {
	maxChars: number;
}

export const Config = z.object({
	maxChars: z.number().min(1000).max(500000).default(120000).describe("Default character ceiling for extracted text."),
});
