import { z } from "@musepi/pi-coding-agent/plugin-config";

/**
 * The plugin's declared config (dsh's `Config`): the host validates the
 * effective values through this schema, fills defaults, and derives the
 * management form from `toJsonSchema()`. The manifest no longer carries a
 * parallel field table.
 */
export interface Config {
	configPath: string;
	projectDir: string;
	pluginRoot: string;
	defaultTimeoutMs: number;
}

export const Config = z.object({
	configPath: z
		.string()
		.default("")
		.describe("Claude Code 的 hooks.json，或含 hooks 键的 settings 文件；相对路径按会话工作目录解析。"),
	projectDir: z.string().default("").describe("替换 ${CLAUDE_PROJECT_DIR}；留空时使用会话工作目录。"),
	pluginRoot: z.string().default("").describe("替换 ${CLAUDE_PLUGIN_ROOT}。"),
	defaultTimeoutMs: z.number().default(600000).describe("钩子未设置 timeout 时的预算。"),
});
