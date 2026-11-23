import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";
import { EvalTool } from "../../tools/eval";
import { registerToolProvider } from "../../tools/tool-ownership";

/** Provides `eval`. */
export default function run(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "eval"), "tool-eval:eval");
	ctx.effect!(
		registerToolProvider("eval", session => new EvalTool(session)),
		"tool-eval:provide",
	);
}
