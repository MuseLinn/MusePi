/**
 * `plugin_manager` — the model-facing plugin management surface.
 *
 * Two identity levels, matching how the profile actually stacks plugins:
 * - a **bundle** is a package the profile selects (its patch composes rows);
 * - a **plugin** is one composed row inside that bundle, toggled by an
 *   id-targeted override in the profile's own patch.
 *
 * Installing or removing executes host code and package-manager scripts, and
 * granting a version exemption accepts crash/data-loss risk. Both are refused
 * outside an auto-approved session; the person can act from the extension page.
 *
 * The daemon supplies {@link PluginManagementHandle}; without one (standalone
 * TUI/CLI) the tool reports unavailability instead of pretending.
 */
import { type } from "@musepi/musepi-type";
import type { AgentToolResult, CustomTool, CustomToolContext } from "../extensibility/custom-tools/types";

/** One composed plugin row of the active profile. */
export interface PluginEntryRow {
	/** Stable composition id used by set_plugin. */
	id: string;
	/** The npm package the row names. */
	name: string;
	state: "enabled" | "disabled" | "conditional";
	group: boolean;
	/** Bundles/layers that contributed the row. */
	layers: string[];
	pluginPath: string | null;
	mountable: boolean;
}

/** One bundle the profile may stack. */
export interface BundleRow {
	name: string;
	version: string | null;
	enabled: boolean;
	readable: boolean;
}

/** Exact `name@version` exemptions and the runtime versions they allow. */
export interface VersionExemptions {
	runtimeVersion: string;
	exemptions: Record<string, string[]>;
	warnings: string[];
}

/** Outcome of a toggle/removal. */
export interface PluginChangeResult {
	ok: boolean;
	name?: string;
	id?: string;
	application?: "applied" | "pending";
	applied?: number;
	deferred?: number;
	message?: string;
	nextStep?: string;
}

/** Outcome of an install. */
export interface PluginInstallResult extends PluginChangeResult {
	installId?: string;
	version?: string;
	capability?: unknown;
	pendingBuilds?: string[];
}

/** Daemon bridge to the profile composition, plugin manager and install service. */
export interface PluginManagementHandle {
	listPlugins(): Promise<PluginEntryRow[]>;
	setPlugin(id: string, enabled: boolean): Promise<PluginChangeResult>;
	listBundles(): Promise<BundleRow[]>;
	setBundle(name: string, enabled: boolean): Promise<PluginChangeResult>;
	installBundle(spec: string, options?: { approvedBuilds?: string[] }): Promise<PluginInstallResult>;
	removeBundle(name: string): Promise<PluginChangeResult>;
	listVersionExemptions(): Promise<VersionExemptions>;
	setVersionExemption(
		target: string,
		runtimeVersion: string,
		enabled: boolean,
		acceptRisk: boolean,
	): Promise<PluginChangeResult>;
}

const pluginManagerSchema = type({
	action: type("string").describe(
		"list_plugins = composed plugin rows; list_bundles = bundles the profile can stack; set_plugin = toggle one row; set_bundle = select/remove a bundle; install_bundle / remove_bundle = manage packages; list_version_exemptions / set_version_exemption = exact compatibility grants",
	),
	target: type("string")
		.describe("Row id, bundle name, install spec, or name@version for exemptions, per action")
		.optional(),
	enabled: type("boolean")
		.describe("Required for set_plugin / set_bundle; for set_version_exemption true grants, false revokes")
		.optional(),
	runtimeVersion: type("string")
		.describe("set_version_exemption: exact runtime version reported by list_version_exemptions")
		.optional(),
	acceptRisk: type("boolean")
		.describe("set_version_exemption: true only after the user accepts crash and data-loss risk for this exact pair")
		.optional(),
	approvedBuilds: type("string")
		.describe("install_bundle: package names whose blocked build scripts the user explicitly approved")
		.array()
		.optional(),
});

function jsonResult(value: unknown): AgentToolResult<any, any> {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function createPluginManagerTools(
	handleFor: (ctx: CustomToolContext) => PluginManagementHandle | null,
): Array<CustomTool<any, any>> {
	const tool: CustomTool<typeof pluginManagerSchema> = {
		name: "plugin_manager",
		defaultInactive: true, // creation ring only: plugin management is not a default work tool
		label: "插件管理",
		description:
			"Manage the active profile's plugins. List first and use exact ids/names. list_plugins returns composed rows (set_plugin toggles one by id); list_bundles returns stackable bundles (set_bundle selects one); install_bundle/remove_bundle manage packages. Installing runs host code and may run build scripts, so it needs an auto-approved session; otherwise the person installs from the extension page. A change result carries application (applied = live now) and nextStep when the person must act. Version exemptions accept crash/data-loss risk: grant only with the user's explicit acceptance of this exact plugin and runtime version.",
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
			const p = params as {
				action: string;
				target?: string;
				enabled?: boolean;
				runtimeVersion?: string;
				acceptRisk?: boolean;
				approvedBuilds?: string[];
			};
			const requiresAutoApprove = (what: string, action: string): AgentToolResult<any, any> =>
				jsonResult({
					ok: false,
					error: `${what} changes host code and needs an auto-approved session`,
					nextStep: `Ask the user to ${action} from the extension page, or enable auto-approval for this session and retry.`,
				});
			try {
				switch (p.action) {
					case "list_plugins": {
						const entries = await handle.listPlugins();
						return jsonResult({ ok: true, entries, total: entries.length });
					}
					case "list_bundles": {
						const bundles = await handle.listBundles();
						return jsonResult({ ok: true, bundles, total: bundles.length });
					}
					case "set_plugin": {
						if (p.target === undefined)
							return jsonResult({ ok: false, error: "set_plugin needs target (row id)" });
						if (p.enabled === undefined) return jsonResult({ ok: false, error: "set_plugin needs enabled" });
						return jsonResult(await handle.setPlugin(p.target, p.enabled));
					}
					case "set_bundle": {
						if (p.target === undefined)
							return jsonResult({ ok: false, error: "set_bundle needs target (bundle name)" });
						if (p.enabled === undefined) return jsonResult({ ok: false, error: "set_bundle needs enabled" });
						return jsonResult(await handle.setBundle(p.target, p.enabled));
					}
					case "install_bundle": {
						if (p.target === undefined)
							return jsonResult({ ok: false, error: "install_bundle needs target (spec)" });
						if (ctx.autoApprove !== true) return requiresAutoApprove("installing a bundle", "install it");
						return jsonResult(
							await handle.installBundle(p.target, {
								...(Array.isArray(p.approvedBuilds) ? { approvedBuilds: p.approvedBuilds } : {}),
							}),
						);
					}
					case "remove_bundle": {
						if (p.target === undefined)
							return jsonResult({ ok: false, error: "remove_bundle needs target (bundle name)" });
						if (ctx.autoApprove !== true) return requiresAutoApprove("removing a bundle", "remove it");
						return jsonResult(await handle.removeBundle(p.target));
					}
					case "list_version_exemptions": {
						return jsonResult({ ok: true, ...(await handle.listVersionExemptions()) });
					}
					case "set_version_exemption": {
						if (p.target === undefined)
							return jsonResult({ ok: false, error: "set_version_exemption needs target (name@version)" });
						if (p.runtimeVersion === undefined) {
							return jsonResult({ ok: false, error: "set_version_exemption needs runtimeVersion" });
						}
						if (p.enabled === undefined)
							return jsonResult({ ok: false, error: "set_version_exemption needs enabled" });
						if (p.enabled && (p.acceptRisk !== true || ctx.autoApprove !== true)) {
							return jsonResult({
								ok: false,
								error: "granting a version exemption accepts crash and data-loss risk",
								nextStep:
									"Warn the user about this exact plugin/runtime pair and obtain explicit permission; then retry with acceptRisk true in an auto-approved session.",
							});
						}
						return jsonResult(
							await handle.setVersionExemption(p.target, p.runtimeVersion, p.enabled, p.acceptRisk === true),
						);
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
