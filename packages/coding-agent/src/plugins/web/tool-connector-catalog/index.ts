/** Read-only MCP connector catalog. */
import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { ConnectorCatalogTool } from "@musepi/pi-coding-agent/tools/connector-catalog";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";

/** Provides `connector_catalog`. */
export function apply(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "catalog"), "tool-connector-catalog:catalog");
	ctx.effect!(
		registerToolProvider("connector_catalog", () => new ConnectorCatalogTool()),
		"tool-connector-catalog:provide",
	);
}
