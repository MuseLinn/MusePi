import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";
import { ListSecretsTool } from "../../tools/list-secrets";
import { registerToolProvider } from "../../tools/tool-ownership";

/** The secrets package provides `list_secrets`. */
export default function list(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "list"), "tools-secrets:list");
	ctx.effect!(
		registerToolProvider("list_secrets", session => new ListSecretsTool(session)),
		"tools-secrets:provide:list",
	);
}
