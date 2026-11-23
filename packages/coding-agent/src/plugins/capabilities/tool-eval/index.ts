/** Run Python/JS/Ruby/Julia cells. */
import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { EvalTool } from "@musepi/pi-coding-agent/tools/eval";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";

/** Provides `eval`. */
export function apply(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "eval"), "tool-eval:eval");
	ctx.effect!(
		registerToolProvider("eval", session => new EvalTool(session)),
		"tool-eval:provide",
	);
}
