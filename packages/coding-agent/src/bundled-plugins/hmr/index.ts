/**
 * Host-scope HMR plugin: provides `hmr` (dsh's `ctx.hmr`) and owns the single
 * process-wide watcher. Other hosts — the daemon, TUI, ACP, SDK — read the
 * service back from the host service registry and decide what a batch means
 * for their own caches.
 */
import * as fsSync from "node:fs";
import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { resolveExtensionWatchRoots } from "../../extensibility/plugins/hmr/roots";
import { createHmrService, type HmrService } from "../../extensibility/plugins/hmr/service";

export const name = "musepi-hmr";
export const inject = [] as const;
export const provide = ["hmr"] as const;

export async function apply(ctx: ExtensionAPI, config?: Record<string, unknown>): Promise<{ hmr: HmrService }> {
	const roots = (await resolveExtensionWatchRoots(ctx.cwd)).filter(root => {
		try {
			// A root that does not exist yet is not an error: discovery's TTL scan
			// still picks the plugin up once it appears.
			fsSync.statSync(root);
			return true;
		} catch {
			return false;
		}
	});
	const debounceMs = typeof config?.debounceMs === "number" ? config.debounceMs : 120;
	const service = createHmrService(roots, debounceMs);
	ctx.effect(() => service.dispose(), "hmr:watcher");
	return { hmr: service };
}
