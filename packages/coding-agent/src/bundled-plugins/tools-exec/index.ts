/**
 * Execution tools as a capability package: shell, code evaluation, AST rewriting.
 *
 * The classes stay in `src/tools/` and remain the core fallback, so a session
 * with nothing mounted behaves exactly as before. Mounting this package makes
 * it the provider for each tool and lets a deployment drop a family by
 * disabling its component.
 */
import type { PluginAPI } from "../../extensibility/extensions/types";

export const name = "musepi-tools-exec";
export const inject = [] as const;
export const provide = [] as const;

export function apply(_ctx: PluginAPI): void {
	// Components carry the per-tool registration.
}
