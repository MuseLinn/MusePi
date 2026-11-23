import { z } from "@musepi/pi-coding-agent/plugin-config";

/**
 * The plugin's declared config (the declared config): the host validates the
 * effective values through this schema, fills defaults, and derives the
 * management form from `toJsonSchema()`. The manifest no longer carries a
 * parallel field table.
 */
export interface Config {
	"terminal.provider": "auto" | "bun-pty" | "node-pty";
	"terminal.showImages": boolean;
	"terminal.showProgress": boolean;
}

export const Config = z.object({
	"terminal.provider": z
		.enum(["auto", "bun-pty", "node-pty"])
		.default("auto")
		.describe("自动选择或固定使用一个终端后端。"),
	"terminal.showImages": z.boolean().default(true).describe("在支持的终端中显示图片。"),
	"terminal.showProgress": z.boolean().default(true).describe("在终端中显示任务进度。"),
});
