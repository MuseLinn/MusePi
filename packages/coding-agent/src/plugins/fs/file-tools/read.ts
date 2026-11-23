import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { ReadTool } from "@musepi/pi-coding-agent/tools/read";
import { registerToolOwner, registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";

/**
 * The file-tools package provides the read family: it owns `read` and supplies
 * its implementation. Sessions without this package mounted keep the core
 * factory, so the CLI and isolated workers are unaffected.
 */
export default function read(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("file", "read"), "file-backend:read");
	ctx.effect!(
		registerToolProvider("read", session => new ReadTool(session)),
		"file-tools:provide:read",
	);
	ctx.effect!(registerToolOwner("read", { domain: "file", id: "read" }), "file-tools:own:read");
}
