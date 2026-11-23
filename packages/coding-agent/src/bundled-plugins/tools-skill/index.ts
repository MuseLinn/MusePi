/** Skill tools as a capability package: `manage_skill`. */
import type { PluginAPI } from "../../extensibility/extensions/types";

export const name = "musepi-tools-skill";
export const inject = [] as const;
export const provide = [] as const;

export function apply(_ctx: PluginAPI): void {
	// The component carries the tool registration.
}
