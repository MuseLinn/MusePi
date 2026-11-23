/** Web search over the configured providers. */
import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";
import { WebSearchTool } from "@musepi/pi-coding-agent/web/search";

/** The web package provides `web_search`. */
export function apply(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "web_search"), "tool-web:search");
	ctx.effect!(
		registerToolProvider("web_search", session => new WebSearchTool(session)),
		"tool-web:provide:web-search",
	);
}
