/**
 * Session interaction tools as a capability package: asking the user, todos,
 * progress updates and project knowledge.
 *
 * Each is its own component because a deployment can want todos without the
 * ask card, or progress updates without knowledge. The classes stay in
 * `src/tools/` and remain the core fallback.
 */
import type { PluginAPI } from "../../extensibility/extensions/types";

export const name = "musepi-tools-session";
export const inject = [] as const;
export const provide = [] as const;

export function apply(_ctx: PluginAPI): void {
	// Components carry the per-tool registration.
}
