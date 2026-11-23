/** Workspace security scanning. */
import type { PluginAPI } from "../../extensibility/extensions/types";

export const name = "musepi-tools-security";
export const inject = [] as const;
export const provide = [] as const;

export function apply(_ctx: PluginAPI): void {
	// Components carry the per-tool registration.
}
