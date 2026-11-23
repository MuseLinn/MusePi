/**
 * Delegation tools as a capability package: subagent dispatch and the
 * agent-coordination hub.
 *
 * The classes stay in `src/task/` and `src/tools/hub/`, remaining the core
 * fallback; mounting this package makes it their provider.
 */
import type { PluginAPI } from "../../extensibility/extensions/types";

export const name = "musepi-tools-delegation";
export const inject = [] as const;
export const provide = [] as const;

export function apply(_ctx: PluginAPI): void {
	// Components carry the per-tool registration.
}
