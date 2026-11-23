import { activateCapability } from "@musepi/pi-coding-agent/extensibility/capability-activation";
import type { PluginAPI } from "@musepi/pi-coding-agent/extensibility/extensions/types";
import { GlobTool } from "@musepi/pi-coding-agent/tools/glob";
import { GrepTool } from "@musepi/pi-coding-agent/tools/grep";
import { registerToolOwner, registerToolProvider } from "@musepi/pi-coding-agent/tools/tool-ownership";

/** The file-tools package provides the search family: `glob` and `grep`. */
export default function search(ctx: PluginAPI): void {
	ctx.effect!(activateCapability("file", "search"), "file-backend:search");
	ctx.effect!(
		registerToolProvider("glob", session => new GlobTool(session, { rootPathAlias: true })),
		"file-tools:provide:glob",
	);
	ctx.effect!(
		registerToolProvider("grep", session => new GrepTool(session)),
		"file-tools:provide:grep",
	);
	ctx.effect!(registerToolOwner("glob", { domain: "file", id: "search" }), "file-tools:own:glob");
	ctx.effect!(registerToolOwner("grep", { domain: "file", id: "search" }), "file-tools:own:grep");
}
