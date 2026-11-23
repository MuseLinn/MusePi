import { z } from "@musepi/pi-coding-agent/plugin-config";

/**
 * The plugin's declared config (dsh's `Config`): the host validates the
 * effective values through this schema, fills defaults, and derives the
 * management form from `toJsonSchema()`. The manifest no longer carries a
 * parallel field table.
 */
export interface Config {
	adbPath: string;
	emulatorPath: string;
}

export const Config = z.object({
	adbPath: z.string().default("").describe("Optional absolute path to adb. Uses PATH when empty."),
	emulatorPath: z.string().default("").describe("Optional absolute path to emulator. Uses PATH when empty."),
});
