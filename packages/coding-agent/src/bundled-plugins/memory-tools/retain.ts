import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";
import { MemoryRetainTool } from "../../tools/memory-retain";
import { registerToolProvider } from "../../tools/tool-ownership";

/** The memory-tools package provides `retain` (write side). */
export default function retain(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("memory", "retain"), "memory-tools:retain");
	ctx.effect!(
		registerToolProvider("retain", session => MemoryRetainTool.createIf(session)),
		"memory-tools:provide:retain",
	);
}
