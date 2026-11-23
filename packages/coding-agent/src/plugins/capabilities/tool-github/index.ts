/** Issues, PRs and search via the gh CLI. */
import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { GithubTool } from "@musepi/pi-coding-agent/tools/gh";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";

/** Provides `github`. */
export function apply(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "github"), "tool-github:github");
	ctx.effect!(
		registerToolProvider("github", session => GithubTool.createIf(session)),
		"tool-github:provide",
	);
}
