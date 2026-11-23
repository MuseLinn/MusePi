/**
 * Host-half adapter for the local Mnemopi SQLite memory backend.
 *
 * The engine stays in `mnemopi/` and remains the core fallback. Mounting this
 * package makes "mnemopi" a registered provider, so the settings picker and
 * `memory.status` resolve it through the same seam as every other backend.
 */
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { mnemopiBackend } from "@musepi/pi-coding-agent/mnemopi/backend";

export const name = "musepi-memory-mnemopi";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: PluginAPI): void {
	ctx.memory.registerBackendProvider({
		id: "mnemopi",
		label: "Mnemopi",
		description: "Local SQLite memory with optional embeddings, banks and structured recall.",
		create: () => mnemopiBackend,
	});
}
