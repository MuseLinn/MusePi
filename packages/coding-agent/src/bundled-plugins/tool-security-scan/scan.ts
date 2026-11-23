import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";
import { SecurityScanTool } from "../../tools/security-scan";
import { registerToolProvider } from "../../tools/tool-ownership";

/** Provides `security_scan`. */
export default function scan(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "scan"), "tool-security-scan:scan");
	ctx.effect!(
		registerToolProvider("security_scan", session => new SecurityScanTool(session)),
		"tool-security-scan:provide",
	);
}
