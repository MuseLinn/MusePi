import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { LearnTool } from "@musepi/pi-coding-agent/tools/learn";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";

/** The memory-tools package provides `learn` (auto-learn capture + skill). */
export default function learn(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("memory", "learn"), "memory-tools:learn");
	ctx.effect!(
		registerToolProvider("learn", session => LearnTool.createIf(session)),
		"memory-tools:provide:learn",
	);
}
