import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";
import { KnowledgeTool } from "../../tools/knowledge";
import { registerToolProvider } from "../../tools/tool-ownership";

/** The session package provides `knowledge`. */
export default function knowledge(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "knowledge"), "tools-session:knowledge");
	ctx.effect!(
		registerToolProvider("knowledge", session => new KnowledgeTool(session)),
		"tools-session:provide:knowledge",
	);
}
