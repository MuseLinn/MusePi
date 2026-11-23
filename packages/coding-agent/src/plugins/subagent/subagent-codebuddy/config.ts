import { z } from "@musepi/pi-coding-agent/plugin-config";

/**
 * The plugin's declared config (the declared config): the host validates the
 * effective values through this schema, fills defaults, and derives the
 * management form from `toJsonSchema()`. The manifest no longer carries a
 * parallel field table.
 */
export interface Config {
	executable: string;
	model: string;
	permissionMode: "dontAsk" | "acceptEdits" | "plan" | "bypassPermissions";
	env: string;
	disposeGraceMs: number;
}

export const Config = z.object({
	executable: z.string().default("").describe("留空时从 PATH 查找 codebuddy。"),
	model: z.string().default("").describe("可选的 CodeBuddy 原生模型标识。"),
	permissionMode: z
		.enum(["dontAsk", "acceptEdits", "plan", "bypassPermissions"])
		.default("dontAsk")
		.describe("权限模式"),
	env: z.string().default("").describe("可选的字符串键值 JSON 对象。"),
	disposeGraceMs: z.number().default(3000).describe("退出宽限（毫秒）"),
});
