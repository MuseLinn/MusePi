/** Image tools as a capability package: `inspect_image`. */
import type { PluginAPI } from "../../extensibility/extensions/types";

export const name = "musepi-tools-image";
export const inject = [] as const;
export const provide = [] as const;

export function apply(_ctx: PluginAPI): void {
	// The component carries the tool registration.
}
