/**
 * Host-half adapter for the MuseMem rollout-summary memory backend.
 *
 * The pipeline (`memories/` → SQLite → memory_summary.md, plus project and
 * cross-project `learned.md`) is unchanged and stays the core fallback.
 * Mounting this package makes "musemem" a registered provider so the settings
 * picker and `memory.status` resolve it through the same seam as every other
 * backend.
 */
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { musememBackend } from "@musepi/pi-coding-agent/memory-backend/musemem-backend";

export const name = "musepi-memory-musemem";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: PluginAPI): void {
	ctx.memory.registerBackendProvider({
		id: "musemem",
		label: "MuseMem",
		description: "Project summaries plus cross-project lessons from the learn tool; no structured search.",
		create: () => musememBackend,
	});
}
