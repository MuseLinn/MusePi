/** Workspace security scanning. */
import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { SecurityScanTool } from "@musepi/pi-coding-agent/tools/security-scan";
import { registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";

/** Provides `security_scan`. */
export function apply(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("tool", "scan"), "tool-security-scan:scan");
	ctx.effect!(
		registerToolProvider("security_scan", session => new SecurityScanTool(session)),
		"tool-security-scan:provide",
	);
}
