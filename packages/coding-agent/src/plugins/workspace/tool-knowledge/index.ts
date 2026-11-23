/** Project knowledge base. */
import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { KnowledgeTool } from "@musepi/pi-coding-agent/tools/knowledge";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";

/** Provides `knowledge`. */
export function apply(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "knowledge"), "tool-knowledge:knowledge");
	ctx.effect!(
		registerToolProvider("knowledge", session => new KnowledgeTool(session)),
		"tool-knowledge:provide",
	);
}
