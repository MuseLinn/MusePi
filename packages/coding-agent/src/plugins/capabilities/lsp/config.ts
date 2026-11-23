import { z } from "@musepi/pi-coding-agent/plugin-config";

/**
 * The plugin's declared config (the declared config): the host validates the
 * effective values through this schema, fills defaults, and derives the
 * management form from `toJsonSchema()`. The manifest no longer carries a
 * parallel field table.
 */
export interface Config {
	"lsp.lazy": boolean;
	"lsp.shared": boolean;
}

export const Config = z.object({
	"lsp.lazy": z.boolean().default(true).describe("首次调用语言功能时再启动语言服务器。"),
	"lsp.shared": z.boolean().default(true).describe("在会话之间复用兼容的语言服务器实例。"),
});
