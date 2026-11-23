import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { MemoryRetainTool } from "@musepi/pi-coding-agent/tools/memory-retain";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";

/** The memory-tools package provides `retain` (write side). */
export default function retain(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("memory", "retain"), "memory-tools:retain");
	ctx.effect!(
		registerToolProvider("retain", session => MemoryRetainTool.createIf(session)),
		"memory-tools:provide:retain",
	);
}
