import { activateCapability } from "../../../extensibility/capability-activation";
import type { PluginAPI } from "../../../extensibility/extensions/types";
import { ReadTool } from "../../../tools/read";
import { registerToolOwner, registerToolProvider } from "../../../tools/tool-ownership";

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
