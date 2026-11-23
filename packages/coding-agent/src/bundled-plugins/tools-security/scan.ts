import { activateCapability } from "../../extensibility/capability-activation";
import type { PluginAPI } from "../../extensibility/extensions/types";
import { SecurityScanTool } from "../../tools/security-scan";
import { registerToolProvider } from "../../tools/tool-ownership";

/** The security package provides `security_scan`. */
export default function scan(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "scan"), "tools-security:scan");
	ctx.effect!(
		registerToolProvider("security_scan", session => new SecurityScanTool(session)),
		"tools-security:provide:scan",
	);
}
