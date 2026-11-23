import { EditTool } from "@musepi/pi-coding-agent/edit";
import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { registerToolOwner, registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";
import { WriteTool } from "@musepi/pi-coding-agent/tools/write";

/**
 * The file-tools package provides the write family: `write` and `edit` (plus
 * the AST edit tool, which writes through the same backend).
 */
export default function write(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("file", "write"), "file-backend:write");
	ctx.effect!(
		registerToolProvider("write", session => new WriteTool(session)),
		"file-tools:provide:write",
	);
	ctx.effect!(
		registerToolProvider("edit", session => new EditTool(session)),
		"file-tools:provide:edit",
	);
	ctx.effect!(registerToolOwner("write", { domain: "file", id: "write" }), "file-tools:own:write");
	ctx.effect!(registerToolOwner("edit", { domain: "file", id: "write" }), "file-tools:own:edit");
}
