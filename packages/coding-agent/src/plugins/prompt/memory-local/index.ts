/**
 * Host-half adapter for the local rollout-summary memory backend.
 *
 * The pipeline (`memories/` → SQLite → memory_summary.md) is unchanged and
 * stays the core fallback. Mounting this package makes "local" a registered
 * provider so the settings picker and `memory.status` resolve it through the
 * same seam as every other backend.
 */
import type { PluginAPI } from "../../../extensibility/extensions/types";
import { localBackend } from "../../../memory-backend/local-backend";

export const name = "musepi-memory-local";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: PluginAPI): void {
	ctx.memory.registerBackendProvider({
		id: "local",
		label: "Local summary",
		description: "Rollout summaries plus lessons from the learn tool; no structured search.",
		create: () => localBackend,
	});
}
