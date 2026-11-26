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

export function apply(ctx: PluginAPI, config: { globalScope?: boolean } = {}): void {
	// The setting travels with the backend: the manifest declares the key, the
	// value is stored in the settings store, and the plugin owns how it is read.
	// Without this plugin mounted the key still resolves through the manifest
	// default registered at mount time.
	ctx.settings.register({
		key: "musemem.globalScope",
		type: "boolean",
		default: config.globalScope !== false,
		ui: {
			tab: "memory",
			group: "MuseMem",
			label: "MuseMem Global Scope",
			description:
				"Let learn take scope: global so every project recalls that lesson. Off keeps every lesson project-local.",
			condition: { key: "memory.backend", equals: "musemem" },
		},
	});
	ctx.memory.registerBackendProvider({
		id: "musemem",
		label: "MuseMem",
		description: "Project summaries plus cross-project lessons from the learn tool; no structured search.",
		create: () => musememBackend,
	});
}
