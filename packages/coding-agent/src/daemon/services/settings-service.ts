/**
 * SettingsService — the settings surface as an L2 daemon service.
 *
 * Seam:
 * - Input: `settings.*` routes and the session host's settings registry
 *   (`ensureRegistry`, `settings`, `extensionSettings`, `cwd`).
 * - Output: the effective settings map, the schema the settings UI renders,
 *   project overrides, and write acks after `flush()`.
 * - Lifecycle: stateless; the registry itself is owned by the host.
 */

import { getSupportedEfforts } from "@musepi/pi-catalog/model-thinking";
import { resolveReleaseChannel, VERSION } from "@musepi/pi-utils";
import { isSensitiveSettingPath, type Settings } from "../../config/settings";
import type { SettingPath } from "../../config/settings-schema";
import { managedBrowserBridgeUrl } from "../../tools/browser/managed-bridge";
import type { DaemonConnection, DaemonSessionHost } from "../session-host";
import type { DaemonService } from "./types";

const BUILTIN_MODEL_ROLES = new Set([
	"default",
	"smol",
	"slow",
	"vision",
	"plan",
	"designer",
	"commit",
	"tiny",
	"task",
	"advisor",
]);

/** True for the canonical built-in role ids (priority patterns exist). */
function isBuiltinRole(role: string): boolean {
	return BUILTIN_MODEL_ROLES.has(role);
}

export class SettingsService implements DaemonService {
	readonly key = "settings";
	readonly routes = {
		"settings.shellMinimizerStats": "shellMinimizerStats",
		"settings.get": "get",
		"settings.set": "set",
		"settings.projectOverrides": "projectOverrides",
		"settings.schema": "schema",
	} as const;

	constructor(
		private readonly host: Pick<DaemonSessionHost, "cwd" | "ensureRegistry" | "extensionSettings" | "settings">,
	) {}

	async shellMinimizerStats(params: unknown, conn?: DaemonConnection): Promise<unknown> {
		const { readShellMinimizerStats } = await import("../../session/shell-minimizer-stats");
		return readShellMinimizerStats();
	}

	async get(params: unknown, conn?: DaemonConnection): Promise<unknown> {
		// Global settings snapshot (session-less): the GUI reads
		// defaults/roles here instead of per-session state.
		const p = (params ?? {}) as { keys?: string[] };
		// Lazy bootstrap like models.listAvailable: the first call boots
		// a minimal session to extract the shared settings instance.
		let settings = this.host.settings();
		if (!settings) {
			await this.host.ensureRegistry();
			settings = this.host.settings();
		}
		if (!settings) throw new Error("settings unavailable");
		const keys = p.keys && p.keys.length > 0 ? p.keys : ["modelRoles", "cycleOrder", "knownRoleIds"];
		const { SETTINGS_SCHEMA, hasUi, isCredential } = await import("../../config/settings-schema");
		// Extension-contributed settings (registerSetting) are also
		// readable — they're not in SETTINGS_SCHEMA, so hasUi() would
		// otherwise skip them.
		const extKeys = new Set(this.host.extensionSettings().keys());
		const out: Record<string, unknown> = {};
		for (const key of keys) {
			// Anything the TUI settings panel exposes (hasUi) plus the
			// model-panel keys is readable. Credentials are NEVER
			// echoed back — the GUI renders a masked placeholder and
			// only writes a non-empty replacement. The computed
			// knownRoleIds/resolvedRoleModels are served below, not
			// schema-backed (hasUi would throw on them).
			const computed = key === "knownRoleIds" || key === "resolvedRoleModels";
			const hasUiMeta = computed ? false : hasUi(key as Parameters<typeof hasUi>[0]);
			const legacy =
				key === "modelRoles" ||
				key === "cycleOrder" ||
				key === "modelTags" ||
				key === "modelProviderOrder" ||
				key === "sideChannelModel" ||
				key === "busyEnter";
			if (!legacy && !hasUiMeta && !extKeys.has(key)) continue;
			if (key in SETTINGS_SCHEMA && isCredential(key as Parameters<typeof isCredential>[0])) {
				out[key] = undefined;
				continue;
			}
			// Only surface explicitly-configured values for keys the GUI
			// treats as user intent: an unset settings.locale would echo
			// the schema default (en-US) and flip the desktop UI off the
			// OS-detected locale; an unset defaultThinkingLevel would
			// override the composer's neutral preselect; an unset
			// stt.enabled would echo the schema default (false, TUI
			// opt-in semantics) and disable the desktop mic that shipped
			// enabled. The GUI falls back to its own defaults for these.
			if (
				(key === "settings.locale" || key === "defaultThinkingLevel" || key === "stt.enabled") &&
				!(settings as Settings).isConfigured(key as Parameters<Settings["isConfigured"]>[0])
			) {
				continue;
			}
			// browser.gui has an effective default that is NOT a stored
			// value: while the desktop app's managed-browser bridge is
			// registered, an unconfigured setting resolves to ON (the
			// agent's pages are visible in the panel). Echo that, so the
			// settings page shows what the agent will actually use —
			// otherwise the toggle reads OFF while the channel is live,
			// and flipping it "on" would only write the redundant true.
			if (key === "browser.gui" && !settings.isConfigured("browser.gui") && managedBrowserBridgeUrl() !== null) {
				out[key] = true;
				continue;
			}
			// A beta build always follows the beta channel — its version is
			// newer than the stable line, so a configured "stable" would be
			// ignored by the updater. Echo what it actually follows.
			if (key === "update.channel") {
				out[key] = resolveReleaseChannel(
					process.env.MUSEPI_VERSION ?? VERSION,
					String(settings.get("update.channel") ?? "stable"),
				);
				continue;
			}
			out[key] = extKeys.has(key)
				? settings.getRaw(key)
				: (settings as Settings).get(key as Parameters<Settings["get"]>[0]);
		}
		if (keys.includes("knownRoleIds")) {
			// TUI /model parity: canonical role list = built-ins +
			// configured cycleOrder/modelRoles/modelTags extras.
			const builtins = [
				"default",
				"smol",
				"slow",
				"vision",
				"plan",
				"designer",
				"commit",
				"tiny",
				"task",
				"advisor",
			];
			const roles = (settings.get("modelRoles") as Record<string, string> | undefined) ?? {};
			const cycle = (settings.get("cycleOrder") as string[] | undefined) ?? [];
			const known = [...builtins];
			for (const role of [...cycle, ...Object.keys(roles)]) {
				if (!known.includes(role)) known.push(role);
			}
			out.knownRoleIds = known;
		}
		if (keys.includes("resolvedRoleModels")) {
			// TUI model-hub parity: for every known role, the model that
			// WOULD be selected (explicit assignment, or the auto-derived
			// default/priority resolution when unset). The GUI shows
			// "auto → <model>" on unassigned roles that resolve.
			const { resolveModelRoleValue } = await import("../../config/model-resolver");
			const registry = await this.host.ensureRegistry();
			const roles = (settings.get("modelRoles") as Record<string, string> | undefined) ?? {};
			const known =
				(out.knownRoleIds as string[] | undefined) ??
				(() => {
					const builtins = [
						"default",
						"smol",
						"slow",
						"vision",
						"plan",
						"designer",
						"commit",
						"tiny",
						"task",
						"advisor",
					];
					const cycle = (settings.get("cycleOrder") as string[] | undefined) ?? [];
					const k = [...builtins];
					for (const role of [...cycle, ...Object.keys(roles)]) {
						if (!k.includes(role)) k.push(role);
					}
					return k;
				})();
			const available = registry?.getAvailable() ?? [];
			const resolved: Record<string, { id: string; name: string; efforts: string[] } | null> = {};
			for (const role of known) {
				const value = roles[role];
				// TUI model-hub parity: unconfigured roles fall back to
				// their `pi/<role>` priority pattern (which carries the
				// default-role inheritance for smol/slow/designer) —
				// displayed as "auto selection: <model>".
				const r = resolveModelRoleValue(value ?? (isBuiltinRole(role) ? `pi/${role}` : undefined), available, {
					settings: settings as never,
				});
				// The role model's exact thinking ladder (TUI model-hub
				// parity): the role row's level select offers inherit/off
				// plus these rungs — NOT a fixed seven-rung list, since
				// different models support different efforts.
				resolved[role] = r.model
					? {
							id: r.model.id,
							name: r.model.name,
							efforts: r.model.thinking ? getSupportedEfforts(r.model as never).map(e => String(e)) : [],
						}
					: null;
			}
			out.resolvedRoleModels = resolved;
		}
		if (keys.includes("modelRoleSources")) {
			// Provenance echo: which layer actually
			// supplies each role (full merge precedence: runtime →
			// overlay → project → global → default). The GUI badges the
			// role cards' scope toggle with it so a write never lands in
			// an unexpected layer.
			const roleNames = new Set([
				...Object.keys((settings.get("modelRoles") as Record<string, string> | undefined) ?? {}),
				...((out.knownRoleIds as string[] | undefined) ?? []),
			]);
			const sources: Record<string, string> = {};
			for (const role of roleNames) {
				sources[role] = settings.getModelRoleProvenance(role);
			}
			out.modelRoleSources = sources;
		}
		return out;
	}

	async set(params: unknown, conn?: DaemonConnection): Promise<unknown> {
		// Write one global setting (GUI settings panel scope).
		const p = (params ?? {}) as { key: string; value: unknown };
		let settings = this.host.settings();
		if (!settings) {
			await this.host.ensureRegistry();
			settings = this.host.settings();
		}
		if (!settings) throw new Error("settings unavailable");
		const { SETTINGS_SCHEMA, hasUi, isCredential } = await import("../../config/settings-schema");
		const legacy =
			["modelRoles", "cycleOrder", "modelTags", "modelProviderOrder", "sideChannelModel", "busyEnter"].includes(
				p.key,
			) ||
			p.key.startsWith("lsp.") ||
			p.key === "read.toolResultPreview";
		const extKeys = new Set(this.host.extensionSettings().keys());
		if (
			!legacy &&
			!(p.key in SETTINGS_SCHEMA && hasUi(p.key as Parameters<typeof hasUi>[0])) &&
			!extKeys.has(p.key)
		) {
			throw new Error(`read-only setting: ${p.key}`);
		}
		// Credentials: an empty/absent value keeps the stored one
		// (settings.get never echoes credentials back).
		if (p.key in SETTINGS_SCHEMA && isCredential(p.key as Parameters<typeof isCredential>[0])) {
			if (p.value === "" || p.value === null || p.value === undefined) {
				return { ok: true };
			}
		}
		// Extension-owned keys: honor the extension's write-time guard
		// (ExtensionSetting.validate,
		// analogue) — a refused write surfaces as an RPC error so the
		// GUI/TUI shows the reason instead of persisting bad input.
		if (extKeys.has(p.key)) {
			const error = this.host.extensionSettings().get(p.key)?.setting.validate?.(p.value);
			if (error) throw new Error(`invalid value for ${p.key}: ${error}`);
		}
		// Scope-aware role writes (TUI model-hub parity): when
		// modelRoleStorage=project, the roles panel can target the
		// project layer (.musepi/config.yml). `modelRoles` honors
		// scope; cycleOrder and everything else stay global (the
		// TUI persists the cycle order globally too).
		const scope = (p as { scope?: "global" | "project" }).scope;
		if (scope === "project" && p.key === "modelRoles") {
			if (!this.host.cwd()) throw new Error("no project open — project-scope roles need a workspace");
			for (const [role, value] of Object.entries(p.value as Record<string, string>)) {
				settings.setProjectModelRole(role, value);
			}
		} else {
			(settings as Settings).set(p.key as Parameters<Settings["set"]>[0], p.value as never);
		}
		await settings.flush();
		return { ok: true };
	}

	async projectOverrides(params: unknown, conn?: DaemonConnection): Promise<unknown> {
		// Project-override ledger (GUI "项目覆盖" section): every key
		// the current project layer actually owns, with its raw
		// project value, the effective merged value and the global
		// fallback — plus a delete action so one click reverts a key
		// to the inherited layer. Read-only when no workspace is open.
		const p = (params ?? {}) as { action?: "list" | "delete"; path?: string };
		let settings = this.host.settings();
		if (!settings) {
			await this.host.ensureRegistry();
			settings = this.host.settings();
		}
		if (!settings) throw new Error("settings unavailable");
		if (!this.host.cwd()) return { overrides: [] };

		if (p.action === "delete" && p.path) {
			const segments = p.path.split(".");
			// Currently only modelRoles.<role> leaves are writable in
			// the project layer (setProjectModelRole is the sole
			// project-write API); anything else is read-only here.
			if (segments.length === 2 && segments[0] === "modelRoles") {
				settings.clearProjectModelRole(segments[1]);
				await settings.flush();
			} else {
				throw new Error(`project override ${p.path} is not deletable from the panel`);
			}
			return { ok: true };
		}

		// Redact at the source: capability discovery (e.g.
		// .claude/settings.json) and hand-edited project config.yml can
		// carry secrets the schema never sees, so path-shape filtering
		// is the only guard — never echo those values to any client.
		// The count only covers REAL overrides (project value differs
		// from the inherited global value).
		const globalFlat = settings.getGlobalLayerFlat();
		const overrides = settings
			.getProjectOverrideEntries()
			.filter(e => !isSensitiveSettingPath(e.path))
			.map(entry => ({
				path: entry.path,
				projectValue: entry.value,
				effectiveValue: entry.effective,
				globalValue: globalFlat[entry.path],
			}));
		return { cwd: this.host.cwd(), overrides };
	}

	async schema(params: unknown, conn?: DaemonConnection): Promise<unknown> {
		// UI metadata for the settings panel (TUI parity): every
		// setting with ui metadata on the requested tabs, so the GUI
		// renders from the single source of truth instead of a
		// hardcoded copy that drifts.
		const p = (params ?? {}) as { tabs?: string[]; all?: boolean };
		const { getEnumValues, SETTINGS_SCHEMA, SETTING_TABS } = await import("../../config/settings-schema");
		// Extension-contributed settings (registerSetting, e.g. the
		// swarm style extension's display.taskCardStyle) live in the
		// host-level cache — merged so the panel shows them without
		// requiring a live session.
		const extSettings = this.host.extensionSettings();
		// P1 设置 tab 开放:白名单 = SETTING_TABS ∪ 扩展声明 tab
		// (registerSetting 的 ui.tab)。扩展 tab 名仍受"客户端不能
		// 发明任意 tab"约束——只有真实注册过的 tab 才返回,typo 丢弃。
		// 扩展设置走各自声明的 ui.tab(插入现有 tab,不设聚合 tab)。
		const extTabs = new Set<string>();
		for (const { setting } of extSettings.values()) extTabs.add(setting.ui.tab);
		// `all` serves the GUI's cross-page settings search index in one
		// round trip; per-tab requests stay the default for page loads.
		const requested = p.all
			? [...SETTING_TABS, ...extTabs]
			: p.tabs && p.tabs.length > 0
				? p.tabs
				: ["memory", "files"];
		const tabs = [...new Set(requested)].filter(
			tab => (SETTING_TABS as readonly string[]).includes(tab) || extTabs.has(tab),
		);
		const out: Record<string, unknown[]> = {};
		for (const tab of tabs) {
			const items: unknown[] = [];
			for (const [key, def] of Object.entries(SETTINGS_SCHEMA)) {
				const ui = (def as { ui?: { tab?: string; options?: unknown } }).ui;
				if (!ui || ui.tab !== tab) continue;
				const item: Record<string, unknown> = { key, type: def.type, default: def.default, ui };
				// Enums whose options live in the schema's `values`
				// field (edit.mode: EDIT_MODES) get synthesized
				// ui.options — without them the GUI would render a
				// text input instead of a select.
				if (def.type === "enum" && !ui.options) {
					const values = getEnumValues(key as SettingPath);
					if (values && values.length > 0) {
						item.ui = { ...ui, options: values.map(v => ({ value: v, label: v })) };
					}
				}
				// Contributed memory backends are choices too: append the
				// provider's own label/description so a plugin backend is
				// selectable without a host change.
				if (key === "memory.backend") {
					const { listMemoryBackendProviders } = await import("../../memory-backend/providers");
					const declared = (ui.options as Array<{ value: string }> | undefined) ?? [];
					const known = new Set(declared.map(option => option.value));
					const contributed = listMemoryBackendProviders()
						.filter(provider => !known.has(provider.id))
						.map(provider => ({
							value: provider.id,
							label: provider.label ?? provider.id,
							...(provider.description ? { description: provider.description } : {}),
						}));
					if (contributed.length > 0) {
						item.ui = { ...ui, options: [...declared, ...contributed] };
					}
				}
				// `options: "runtime"` (theme.dark/theme.light) — resolve the
				// runtime list daemon-side so the GUI renders a real select
				// instead of the TUI's runtime-populated submenu. The TUI
				// theme registry is fs-backed (builtins + ~/.musepi/themes),
				// so it enumerates without a terminal.
				if ((ui as { options?: unknown }).options === "runtime") {
					const { getAvailableThemes } = await import("../../modes/theme/loader");
					item.runtimeOptions = await getAvailableThemes();
				}
				items.push(item);
			}
			// Merge extension-contributed settings for this tab (they
			// win over nothing — keys are extension-owned namespaces).
			for (const [key, { setting, extensionPath }] of extSettings) {
				if (setting.ui.tab !== tab) continue;
				if (items.some(item => (item as { key: string }).key === key)) continue;
				items.push({
					key,
					type: setting.type,
					default: setting.default,
					ui: setting.ui,
					extensionId: extensionPath,
				});
			}
			out[tab] = items;
		}
		return out;
	}
}
