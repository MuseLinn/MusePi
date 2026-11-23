import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";
import { MemoryReflectTool } from "../../tools/memory-reflect";
import { registerToolProvider } from "../../tools/tool-ownership";

/** The memory-tools package provides `reflect` (synthesis over memory). */
export default function reflect(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("memory", "reflect"), "memory-tools:reflect");
	ctx.effect!(
		registerToolProvider("reflect", session => MemoryReflectTool.createIf(session)),
		"memory-tools:provide:reflect",
	);
}
