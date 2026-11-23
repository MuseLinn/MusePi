import { activateCapability } from "../../../extensibility/capability-activation";
import type { PluginAPI } from "../../../extensibility/extensions/types";
import { ConnectorCatalogTool } from "../../../tools/connector-catalog";
import { registerToolProvider } from "../../../tools/tool-ownership";

/** Provides `connector_catalog`. */
export default function catalog(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "catalog"), "tool-connector-catalog:catalog");
	ctx.effect!(
		registerToolProvider("connector_catalog", () => new ConnectorCatalogTool()),
		"tool-connector-catalog:provide",
	);
}
