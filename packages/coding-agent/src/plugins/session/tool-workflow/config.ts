import { z } from "@musepi/pi-coding-agent/plugin-config";

/** Workflow result limits. */
export interface Config {
	maxResultChars: number;
}

export const Config = z.object({
	maxResultChars: z
		.number()
		.min(1000)
		.max(500000)
		.default(50000)
		.describe("Rendered workflow result ceiling; longer values are truncated with a notice."),
});
