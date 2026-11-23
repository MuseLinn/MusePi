import { z } from "@musepi/pi-coding-agent/plugin-config";

/**
 * The plugin's declared config (the declared config): the host validates the
 * effective values through this schema, fills defaults, and derives the
 * management form from `toJsonSchema()`. The manifest no longer carries a
 * parallel field table.
 */
export interface Config {
	roots: string;
}

export const Config = z.object({
	roots: z.string().default("").describe('相对路径按会话工作目录解析，例如 ["./skills","~/.agents/skills/pack"]'),
});
