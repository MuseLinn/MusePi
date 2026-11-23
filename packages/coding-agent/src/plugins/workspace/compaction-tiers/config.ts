import { type Volatile, volatile, z } from "@musepi/pi-coding-agent/plugin-config";

/**
 * The plugin's declared config (the declared config): the host validates the
 * effective values through this schema, fills defaults, and derives the
 * management form from `toJsonSchema()`. The manifest no longer carries a
 * parallel field table.
 */
export interface Config {
	capPercent: Volatile<number>;
}

export const Config = z.object({
	capPercent: volatile(
		z.number().default(70).describe("长上下文按溢价计费的模型，其压缩触发点不超过该窗口占比。其他模型不受影响。"),
	),
});
