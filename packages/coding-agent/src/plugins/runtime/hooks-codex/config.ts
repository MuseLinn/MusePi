import { z } from "@musepi/pi-coding-agent/plugin-config";

/**
 * The plugin's declared config (the declared config): the host validates the
 * effective values through this schema, fills defaults, and derives the
 * management form from `toJsonSchema()`. The manifest no longer carries a
 * parallel field table.
 */
export interface Config {
	configPath: string;
	defaultTimeoutMs: number;
}

export const Config = z.object({
	configPath: z.string().default("").describe("Codex 的 hooks.json；相对路径按会话工作目录解析。"),
	defaultTimeoutMs: z.number().default(600000).describe("钩子未设置 timeout 时的预算。"),
});
