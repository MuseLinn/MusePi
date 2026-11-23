import { activateCapability } from "../../../extensibility/capability-activation";
import type { PluginAPI } from "../../../extensibility/extensions/types";
import { LearnTool } from "../../../tools/learn";
import { registerToolProvider } from "../../../tools/tool-ownership";

/** The memory-tools package provides `learn` (auto-learn capture + skill). */
export default function learn(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("memory", "learn"), "memory-tools:learn");
	ctx.effect!(
		registerToolProvider("learn", session => LearnTool.createIf(session)),
		"memory-tools:provide:learn",
	);
}
