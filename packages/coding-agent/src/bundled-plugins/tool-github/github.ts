import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";
import { GithubTool } from "../../tools/gh";
import { registerToolProvider } from "../../tools/tool-ownership";

/** Provides `github`. */
export default function github(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "github"), "tool-github:github");
	ctx.effect!(
		registerToolProvider("github", session => GithubTool.createIf(session)),
		"tool-github:provide",
	);
}
