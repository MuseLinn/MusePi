/** Ask the user for a secret without seeing its value. */
import type { PluginAPI } from "../../extensibility/extensions/types";

export const name = "musepi-tools-secrets";
export const inject = [] as const;
export const provide = [] as const;

export function apply(_ctx: PluginAPI): void {
	// Components carry the per-tool registration.
}
