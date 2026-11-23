import { z } from "@musepi/pi-coding-agent/plugin-config";

/**
 * The plugin's declared config (the declared config): the host validates the
 * effective values through this schema, fills defaults, and derives the
 * management form from `toJsonSchema()`. The manifest no longer carries a
 * parallel field table.
 */
export interface Config {
	base: string;
	root: string[];
	ignored: string[];
	debounce: number;
}

export const Config = z.object({
	base: z.string().default("").describe("Base directory for relative root entries. Defaults to the host process cwd."),
	root: z
		.array(z.string())
		.default(() => [])
		.describe("Comma-separated roots, resolved against base. Empty keeps the native extension/plugin roots."),
	ignored: z
		.array(z.string())
		.default(() => [])
		.describe("Comma-separated globs excluded on top of .git and the module cache."),
	debounce: z
		.number()
		.default(120)
		.describe("How long file changes are coalesced before one reload batch is emitted."),
});
