import { z } from "@musepi/pi-coding-agent/plugin-config";

/**
 * The plugin's declared config (dsh's `Config`): the host validates the
 * effective values through this schema, fills defaults, and derives the
 * management form from `toJsonSchema()`. The manifest no longer carries a
 * parallel field table.
 */
export interface Config {
	"browser.headless": boolean;
	"browser.cdpUrl": string;
}

export const Config = z.object({
	"browser.headless": z.boolean().default(true).describe("无桌面内置浏览器时以无头 Chromium 兜底。"),
	"browser.cdpUrl": z.string().default("").describe("连接已有 Chromium 调试端点；留空时使用默认启动方式。"),
});
