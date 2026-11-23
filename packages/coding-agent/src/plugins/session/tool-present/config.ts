import { z } from "@musepi/pi-coding-agent/plugin-config";

/**
 * Present limits. `maxFiles` caps one call; the paths themselves are validated
 * at execute time because only the session knows its working directory.
 */
export interface Config {
	maxFiles: number;
}

export const Config = z.object({
	maxFiles: z.number().min(1).max(32).default(8).describe("Maximum files one present call may declare."),
});
