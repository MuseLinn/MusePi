import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";
import { RequestSecretTool } from "../../tools/request-secret";
import { registerToolProvider } from "../../tools/tool-ownership";

/** Provides `request_secret`. */
export default function request(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "request"), "tool-request-secret:request");
	ctx.effect!(
		registerToolProvider("request_secret", session => new RequestSecretTool(session)),
		"tool-request-secret:provide",
	);
}
