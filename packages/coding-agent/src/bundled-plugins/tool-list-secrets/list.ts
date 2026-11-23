import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";
import { ListSecretsTool } from "../../tools/list-secrets";
import { registerToolProvider } from "../../tools/tool-ownership";

/** Provides `list_secrets`. */
export default function list(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "list"), "tool-list-secrets:list");
	ctx.effect!(
		registerToolProvider("list_secrets", session => new ListSecretsTool(session)),
		"tool-list-secrets:provide",
	);
}
