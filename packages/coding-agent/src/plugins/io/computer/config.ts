import { z } from "@musepi/pi-coding-agent/plugin-config";

/**
 * The plugin's declared config (the declared config): the host validates the
 * effective values through this schema, fills defaults, and derives the
 * management form from `toJsonSchema()`. The manifest no longer carries a
 * parallel field table.
 */
export interface Config {
	"computer.display": string;
	"computer.maxWidth": number;
}

export const Config = z.object({
	"computer.display": z.string().default("all").describe("选择截图与操作使用的显示器。"),
	"computer.maxWidth": z.number().default(3840).describe("限制电脑操作截图的最大宽度。"),
});
