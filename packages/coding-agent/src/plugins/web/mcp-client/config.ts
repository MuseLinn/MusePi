import { z } from "@musepi/pi-coding-agent/plugin-config";

/**
 * The plugin's declared config (the declared config): the host validates the
 * effective values through this schema, fills defaults, and derives the
 * management form from `toJsonSchema()`. The manifest no longer carries a
 * parallel field table.
 */
export interface Config {
	serverName: string;
	transport: "stdio" | "http" | "sse";
	command: string;
	args: string;
	env: string;
	cwd: string;
	url: string;
	headers: string;
	timeout: number;
	enabled: boolean;
}

export const Config = z.object({
	serverName: z.string().default("").describe("工具命名空间 mcp__<serverName>__<tool>；同一会话内唯一。"),
	transport: z.enum(["stdio", "http", "sse"]).default("stdio").describe("传输方式"),
	command: z.string().default("").describe("仅 transport=stdio：可执行文件。"),
	args: z.string().default("").describe('例如 ["-y","@modelcontextprotocol/server-github"]'),
	env: z.string().default("").describe('例如 {"GITHUB_TOKEN":"..."}；与进程环境合并。'),
	cwd: z.string().default("").describe("留空时使用会话工作目录。"),
	url: z.string().default("").describe("仅 transport=http 或 sse。"),
	headers: z.string().default("").describe('例如 {"Authorization":"Bearer ..."}'),
	timeout: z.number().default(30000).describe("请求超时（毫秒）"),
	enabled: z.boolean().default(true).describe("关闭后保留该行但不连接。"),
});
