/**
 * Host-half adapter for the Hindsight remote memory backend.
 *
 * The engine stays in `hindsight/` and remains the core fallback. Mounting this
 * package makes "hindsight" a registered provider, so the settings picker and
 * `memory.status` resolve it through the same seam as every other backend.
 */
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { hindsightBackend } from "@musepi/pi-coding-agent/hindsight/backend";
import { HINDSIGHT_SETTING_ROWS } from "@musepi/pi-coding-agent/hindsight/settings";

export const name = "musepi-memory-hindsight";
export const inject = [] as const;
export const provide = [] as const;

export function apply(ctx: PluginAPI): void {
	for (const row of HINDSIGHT_SETTING_ROWS) {
		ctx.settings.register({
			key: row.key,
			type: row.type,
			default: row.default,
			ui: row.ui,
		});
	}
	ctx.memory.registerBackendProvider({
		id: "hindsight",
		label: "Hindsight",
		description: "Remote vectorized memory with structured recall and reflection.",
		create: () => hindsightBackend,
	});
}
