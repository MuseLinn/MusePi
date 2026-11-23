import { activateCapability } from "../../../extensibility/capability-activation";
import type { PluginAPI } from "../../../extensibility/extensions/types";
import { registerToolProvider } from "../../../tools/tool-ownership";
import { WebSearchTool } from "../../../web/search";

/** The web package provides `web_search`. */
export default function search(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "web_search"), "tool-web:search");
	ctx.effect!(
		registerToolProvider("web_search", session => new WebSearchTool(session)),
		"tool-web:provide:web-search",
	);
}
