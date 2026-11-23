/**
 * Host-half adapter for the Hindsight remote memory backend.
 *
 * The engine stays in `hindsight/` and remains the core fallback. Mounting this
 * package makes "hindsight" a registered provider, so the settings picker and
 * `memory.status` resolve it through the same seam as every other backend.
 */
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { hindsightBackend } from "@musepi/pi-coding-agent/hindsight/backend";

export const name = "musepi-memory-hindsight";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: PluginAPI): void {
	ctx.memory.registerBackendProvider({
		id: "hindsight",
		label: "Hindsight",
		description: "Remote vectorized memory with structured recall and reflection.",
		create: () => hindsightBackend,
	});
}
