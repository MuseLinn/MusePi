/** List secret names. */
import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { ListSecretsTool } from "@musepi/pi-coding-agent/tools/list-secrets";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";

/** Provides `list_secrets`. */
export function apply(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "list"), "tool-list-secrets:list");
	ctx.effect!(
		registerToolProvider("list_secrets", session => new ListSecretsTool(session)),
		"tool-list-secrets:provide",
	);
}
