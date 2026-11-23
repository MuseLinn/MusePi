import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";
import { EvalTool } from "../../tools/eval";
import { registerToolProvider } from "../../tools/tool-ownership";

/** The exec package provides `eval`. */
export default function evaluate(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "eval"), "tools-exec:eval");
	ctx.effect!(
		registerToolProvider("eval", session => new EvalTool(session)),
		"tools-exec:provide:eval",
	);
}
