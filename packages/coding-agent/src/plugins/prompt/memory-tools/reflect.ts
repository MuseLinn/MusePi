import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { MemoryReflectTool } from "@musepi/pi-coding-agent/tools/memory-reflect";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";

/** The memory-tools package provides `reflect` (synthesis over memory). */
export default function reflect(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("memory", "reflect"), "memory-tools:reflect");
	ctx.effect!(
		registerToolProvider("reflect", session => MemoryReflectTool.createIf(session)),
		"memory-tools:provide:reflect",
	);
}
