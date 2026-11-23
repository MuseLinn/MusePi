import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { MemoryRecallTool } from "@musepi/pi-coding-agent/tools/memory-recall";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";

/** The memory-tools package provides `recall` (read side). */
export default function recall(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("memory", "recall"), "memory-tools:recall");
	ctx.effect!(
		registerToolProvider("recall", session => MemoryRecallTool.createIf(session)),
		"memory-tools:provide:recall",
	);
}
