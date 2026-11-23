import { activateCapability } from "../../extensibility/capability-activation";
import type { ExtensionAPI } from "../../extensibility/extensions/types";
import { MemoryRecallTool } from "../../tools/memory-recall";
import { registerToolProvider } from "../../tools/tool-ownership";

/** The memory-tools package provides `recall` (read side). */
export default function recall(ctx: ExtensionAPI): void {
	ctx.effect!(activateCapability("memory", "recall"), "memory-tools:recall");
	ctx.effect!(
		registerToolProvider("recall", session => MemoryRecallTool.createIf(session)),
		"memory-tools:provide:recall",
	);
}
