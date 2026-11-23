/**
 * Web tools as a capability package: web search over the configured providers.
 *
 * The search implementation stays in `src/web/search/` and remains the core
 * fallback; mounting this package makes it the provider.
 */
import type { PluginAPI } from "../../extensibility/extensions/types";

export const name = "musepi-tool-web";
export const inject = [] as const;
export const provide = [] as const;

export function apply(_ctx: PluginAPI): void {
	// Components carry the per-tool registration.
}
