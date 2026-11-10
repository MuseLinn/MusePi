/**
 * Host-scope HMR plugin: provides `hmr` (dsh's `ctx.hmr`) and owns the single
 * process-wide watcher. Other hosts — the daemon, TUI, ACP, SDK — read the
 * service back from the host service registry and decide what a batch means
 * for their own caches.
 */
import * as fsSync from "node:fs";
import * as path from "node:path";
import { getPluginsDir } from "@musepi/pi-utils";
import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { resolveExtensionWatchRoots } from "../../extensibility/plugins/hmr/roots";
import { createHmrService, type HmrService } from "../../extensibility/plugins/hmr/service";

export const name = "musepi-hmr";
export const inject = [] as const;
export const provide = ["hmr"] as const;

/** `<pluginsDir>/cache` holds the generated marketplace clones and the
 *  version-keyed install copies. Watching it buys nothing, and on Windows it
 *  actively breaks installs: chokidar attaches a watch to every new staging
 *  directory inside the cache, and Windows cannot rename a directory that has
 *  an open handle — `marketplace.install` then fails with EPERM after copying
 *  the plugin. */
function installCacheIgnore(): RegExp {
	// chokidar matches `ignored` against slash-normalized paths, so build the
	// pattern in that form and accept either separator afterwards.
	const cacheDir = path.join(getPluginsDir(), "cache").replace(/\\/g, "/");
	const escaped = cacheDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped}(?:[/\\\\]|$)`, process.platform === "win32" ? "i" : "");
}

/** Normalize a list-typed config value (array, or comma-separated string). */
function list(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	if (typeof value === "string") {
		return value
			.split(",")
			.map(item => item.trim())
			.filter(item => item.length > 0);
	}
	return [];
}

export async function apply(ctx: ExtensionAPI, config?: Record<string, unknown>): Promise<{ hmr: HmrService }> {
	// `base` anchors relative `root` entries; without a configured root the
	// native roots stand, because a hand-written list had drifted from what
	// discovery actually loads before.
	const base = typeof config?.base === "string" && config.base.trim() ? path.resolve(config.base) : ctx.cwd;
	const configuredRoots = list(config?.root).map(root => path.resolve(base, root));
	const candidates = configuredRoots.length > 0 ? configuredRoots : await resolveExtensionWatchRoots(ctx.cwd);
	const roots = candidates.filter(root => {
		try {
			// A root that does not exist yet is not an error: discovery's TTL scan
			// still picks the plugin up once it appears.
			fsSync.statSync(root);
			return true;
		} catch {
			return false;
		}
	});
	const debounce = config?.debounce;
	const debounceMs = typeof debounce === "number" ? debounce : 120;
	const service = createHmrService(roots, debounceMs, [...list(config?.ignored), installCacheIgnore()]);
	ctx.effect(() => service.dispose(), "hmr:watcher");
	return { hmr: service };
}
