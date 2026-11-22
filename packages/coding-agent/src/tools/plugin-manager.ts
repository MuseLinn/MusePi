/**
 * `plugin_manager` — installed plugin packages for the current profile.
 *
 * The model lists first, then enables/disables, installs or removes by exact
 * name. Installation runs host code and package-manager scripts, so the tool
 * refuses it outside an auto-approved session: the person can install from the
 * extension page instead, and the model must never quietly execute third-party
 * code.
 *
 * The daemon supplies {@link PluginManagementHandle}; without one (standalone
 * TUI/CLI) the tool reports unavailability instead of pretending.
 */
import { type } from "@musepi/musepi-type";
import type { AgentToolResult, CustomTool, CustomToolContext } from "../extensibility/custom-tools/types";

/** One installed package row, as the model needs it. */
export interface PluginListEntry {
	name: string;
	version: string;
	enabled: boolean;
	/** Package directory on this host. */
	path?: string;
}

/** Outcome of an enable/disable/remove. */
export interface PluginChangeResult {
	ok: boolean;
	name?: string;
	/** `applied` = live now; `pending` = takes effect at the next idle boundary. */
	application?: "applied" | "pending";
	applied?: number;
	deferred?: number;
	message?: string;
	nextStep?: string;
}

/** Outcome of an install, including the capability report the GUI shows. */
export interface PluginInstallResult extends PluginChangeResult {
	installId?: string;
	version?: string;
	capability?: unknown;
	pendingBuilds?: string[];
}

/** Daemon bridge to the plugin manager and install service. */
export interface PluginManagementHandle {
	list(): Promise<PluginListEntry[]>;
	setEnabled(name: string, enabled: boolean): Promise<PluginChangeResult>;
	install(spec: string, options?: { approvedBuilds?: string[] }): Promise<PluginInstallResult>;
	remove(name: string): Promise<PluginChangeResult>;
}

const pluginManagerSchema = type({
	action: type("string").describe(
		"list_plugins = installed packages; set_plugin = enable/disable; install_plugin = install a spec; remove_plugin = uninstall by name",
	),
	target: type("string")
		.describe(
			"Package name for set_plugin/remove_plugin; install spec (npm name, git URL, tarball, absolute path) for install_plugin",
		)
		.optional(),
	enabled: type("boolean").describe("Required for set_plugin").optional(),
	approvedBuilds: type("string")
		.describe("install_plugin: package names whose blocked build scripts the user explicitly approved")
		.array()
		.optional(),
});

function textResult(text: string): AgentToolResult<any, any> {
	return { content: [{ type: "text", text }] };
}

function jsonResult(value: unknown): AgentToolResult<any, any> {
	return textResult(JSON.stringify(value, null, 2));
}

export function createPluginManagerTools(
	handleFor: (ctx: CustomToolContext) => PluginManagementHandle | null,
): Array<CustomTool<any, any>> {
	const tool: CustomTool<typeof pluginManagerSchema> = {
		name: "plugin_manager",
		defaultInactive: true, // creation ring only: plugin management is not a default work tool
		label: "插件管理",
		description:
			"List, enable/disable, install or remove installed plugin packages for the current profile. Call list_plugins first and use exact package names. Installing runs host code and may run package build scripts: it requires an auto-approved session; otherwise tell the user to install from the extension page. Every change result carries application (applied = live now) and nextStep when the person must do something (for example restart the daemon).",
		parameters: pluginManagerSchema,
		async execute(
			_toolCallId: string,
			params: typeof pluginManagerSchema.infer,
			_onUpdate,
			ctx: CustomToolContext,
			_signal?: AbortSignal,
		): Promise<AgentToolResult<any, typeof pluginManagerSchema.infer>> {
			const handle = handleFor(ctx);
			if (!handle) return jsonResult({ ok: false, error: "plugin management needs a running daemon" });
			const p = params as { action: string; target?: string; enabled?: boolean; approvedBuilds?: string[] };
			try {
				switch (p.action) {
					case "list_plugins": {
						const entries = await handle.list();
						return jsonResult({ ok: true, entries, total: entries.length });
					}
					case "set_plugin": {
						if (p.target === undefined) return jsonResult({ ok: false, error: "set_plugin needs target" });
						if (p.enabled === undefined) return jsonResult({ ok: false, error: "set_plugin needs enabled" });
						return jsonResult(await handle.setEnabled(p.target, p.enabled));
					}
					case "install_plugin": {
						if (p.target === undefined) return jsonResult({ ok: false, error: "install_plugin needs target" });
						if (ctx.autoApprove !== true) {
							return jsonResult({
								ok: false,
								error: "installing a plugin executes host code; this session is not auto-approved",
								nextStep:
									"Ask the user to install it from the extension page, or enable auto-approval for this session and retry.",
							});
						}
						return jsonResult(
							await handle.install(p.target, {
								...(Array.isArray(p.approvedBuilds) ? { approvedBuilds: p.approvedBuilds } : {}),
							}),
						);
					}
					case "remove_plugin": {
						if (p.target === undefined) return jsonResult({ ok: false, error: "remove_plugin needs target" });
						if (ctx.autoApprove !== true) {
							return jsonResult({
								ok: false,
								error: "removing a plugin changes the profile; this session is not auto-approved",
								nextStep:
									"Ask the user to remove it from the extension page, or enable auto-approval for this session and retry.",
							});
						}
						return jsonResult(await handle.remove(p.target));
					}
					default:
						return jsonResult({ ok: false, error: `unknown plugin_manager action: ${p.action}` });
				}
			} catch (error) {
				return jsonResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
			}
		},
	};
	return [tool];
}
