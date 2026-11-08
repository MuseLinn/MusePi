/**
 * Host-scope HMR plugin: provides `hmr` (dsh's `ctx.hmr`) and owns the single
 * process-wide watcher. Other hosts — the daemon, TUI, ACP, SDK — read the
 * service back from the host service registry and decide what a batch means
 * for their own caches.
 */
import * as fsSync from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { resolveExtensionWatchRoots } from "../../extensibility/plugins/hmr/roots";
import { createHmrService, type HmrService } from "../../extensibility/plugins/hmr/service";

export const name = "musepi-hmr";
export const inject = [] as const;
export const provide = ["hmr"] as const;

/** Split a comma-separated config value into non-empty entries. */
function list(value: unknown): string[] {
	return typeof value === "string"
		? value
				.split(",")
				.map(item => item.trim())
				.filter(item => item.length > 0)
		: [];
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
	const service = createHmrService(roots, debounceMs, list(config?.ignored));
	ctx.effect(() => service.dispose(), "hmr:watcher");
	return { hmr: service };
}
