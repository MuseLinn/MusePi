import { activateCapability } from "../../../extensibility/capability-activation";
import type { PluginAPI } from "../../../extensibility/extensions/types";
import { MemoryEditTool } from "../../../tools/memory-edit";
import { registerToolProvider } from "../../../tools/tool-ownership";

/** The memory-tools package provides `memory_edit` (Mnemopi bank editing). */
export default function edit(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("memory", "edit"), "memory-tools:edit");
	ctx.effect!(
		registerToolProvider("memory_edit", session => MemoryEditTool.createIf(session)),
		"memory-tools:provide:edit",
	);
}
