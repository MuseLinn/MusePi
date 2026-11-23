import { z } from "@musepi/pi-coding-agent/plugin-config";

/**
 * The plugin's declared config (the declared config): the host validates the
 * effective values through this schema, fills defaults, and derives the
 * management form from `toJsonSchema()`. The manifest no longer carries a
 * parallel field table.
 */
export interface Config {
	roots: string;
	python: string;
	defaultTimeoutMs: number;
}

export const Config = z.object({
	roots: z.string().default("").describe("每个根包含 pre/ 与 post/ 子目录；相对路径按会话工作目录解析。"),
	python: z.string().default("").describe("用于 .py 钩子；留空时不运行 Python 脚本。"),
	defaultTimeoutMs: z.number().default(600000).describe("默认超时（毫秒）"),
});
