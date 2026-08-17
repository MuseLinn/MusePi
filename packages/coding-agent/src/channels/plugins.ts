import { readdir } from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@musepi/pi-utils";
import type { ChannelAdapter, ChannelHost } from "./types";

/**
 * Channel plugin contract — a channel is a pluggable module, discoverable
 * from a directory like game mods. A plugin file exports a default object:
 *
 * ```ts
 * // ~/.musepi/agent/channels/my-bot.ts
 * import type { ChannelAdapter, ChannelHost } from "@musepi/pi-coding-agent";
 * export default {
 *   kind: "my-bot",
 *   label: "My Bot",
 *   description: "…",
 *   create: () => ({ …ChannelAdapter }),
 * } satisfies ChannelPlugin;
 * ```
 *
 * Hot-plug: dropping a file in the directory and calling
 * channels.reloadPlugins registers it without a daemon restart; stop/start
 * toggles each channel live.
 */
export interface ChannelPlugin {
	readonly kind: string;
	readonly label: string;
	readonly description?: string;
	create(registry: { host: ChannelHost }): ChannelAdapter;
}

export interface PluginDescriptor {
	kind: string;
	label: string;
	description?: string;
	/** "builtin" for bundled channels, the file path for directory plugins. */
	origin: string;
}

/** Bundled channel kinds (registered by the daemon at startup). */
export const BUILTIN_PLUGINS: PluginDescriptor[] = [
	{ kind: "wechat", label: "WeChat", description: "iLink bot — QR login, bidirectional media", origin: "builtin" },
	{ kind: "discord", label: "Discord", description: "Gateway bot — text + attachments", origin: "builtin" },
	{ kind: "telegram", label: "Telegram", description: "Bot API — text, photos, documents", origin: "builtin" },
	{ kind: "feishu", label: "Feishu", description: "Long-connection bot — text/images/files", origin: "builtin" },
	{ kind: "lark", label: "Lark", description: "International Feishu (open.larksuite.com)", origin: "builtin" },
	{ kind: "huawei-today", label: "Huawei Today", description: "负一屏 task-result push", origin: "builtin" },
];

/** Scan a plugin directory for channel plugin modules (.ts/.js, default export). */
export async function loadChannelPlugins(dir: string): Promise<{ plugin: ChannelPlugin; origin: string }[]> {
	const out: { plugin: ChannelPlugin; origin: string }[] = [];
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return out; // no plugin directory
	}
	for (const entry of entries) {
		if (!entry.endsWith(".ts") && !entry.endsWith(".js")) continue;
		if (entry.startsWith(".")) continue;
		const file = path.join(dir, entry);
		try {
			const mod = (await import(file)) as { default?: unknown };
			const plugin = mod.default as ChannelPlugin | undefined;
			if (!plugin || typeof plugin.kind !== "string" || typeof plugin.create !== "function") {
				logger.warn(`channel plugin skipped (bad shape): ${entry}`);
				continue;
			}
			out.push({ plugin, origin: file });
		} catch (err) {
			logger.warn(`channel plugin failed to load: ${entry}`, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return out;
}
