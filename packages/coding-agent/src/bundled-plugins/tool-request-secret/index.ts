/** Ask the user for a secret. */
import type { PluginAPI } from "../../extensibility/extensions/types";

export const name = "musepi-tool-request-secret";
export const inject = [] as const;
export const provide = [] as const;

export function apply(_ctx: PluginAPI): void {
	// The component carries the tool registration.
}
