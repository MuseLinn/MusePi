import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { MemoryEditTool } from "@musepi/pi-coding-agent/tools/memory-edit";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";

/** The memory-tools package provides `memory_edit` (Mnemopi bank editing). */
export default function edit(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("memory", "edit"), "memory-tools:edit");
	ctx.effect!(
		registerToolProvider("memory_edit", session => MemoryEditTool.createIf(session)),
		"memory-tools:provide:edit",
	);
}
