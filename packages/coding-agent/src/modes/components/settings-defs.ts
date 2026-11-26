/**
 * UI adapter over the schema. Reads `ui.options` declared inline in
 * settings-schema.ts and produces typed widget definitions for the
 * settings selector.
 *
 * To add a new setting to the UI: declare it in `settings-schema.ts`
 * with a `ui` block carrying `tab` and `group` (the group must be listed
 * in `TAB_GROUPS[tab]`). If it needs a submenu, include `options: [...]`
 * (or `options: "runtime"` for runtime-injected lists like themes).
 */

import { TERMINAL } from "@musepi/pi-tui";
import { Settings } from "../../config/settings";
import { evaluateSettingCondition, type SettingCondition, settingsRegistry } from "../../config/settings-registry";
import {
	type AnyUiMetadata,
	getDefault,
	getEnumValues,
	getPathsForTab,
	getType,
	getUi,
	isCredential,
	SETTING_TABS,
	type SettingPath,
	type SettingTab,
	type SubmenuOption,
	TAB_GROUPS,
} from "../../config/settings-schema";
import { t } from "../../i18n/index.js";

/** Desktop capabilities, set by the shell that hosts this process. */
export interface UiCapabilities {
	/** The daemon runs under the desktop shell, whose main process applies
	 *  `power.preventLidSleep` (lid-closed sleep prevention). Headless and
	 *  terminal surfaces cannot, so they hide the row instead of offering a
	 *  switch with no effect. */
	lidPower: boolean;
}

let uiCapabilities: UiCapabilities = { lidPower: false };

/** Called by the TUI once it knows the shell it runs under. */
export function setUiCapabilities(next: UiCapabilities): void {
	uiCapabilities = next;
}

function pluginSettingsVisible(packageName: string): boolean {
	try {
		const disabled = Settings.instance.get("disabledExtensions") ?? [];
		return !disabled.includes(packageName);
	} catch {
		return true;
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// UI Definition Types
// ═══════════════════════════════════════════════════════════════════════════

export type SettingValue = boolean | string;

interface BaseSettingDef {
	path: SettingPath;
	label: string;
	description: string;
	tab: SettingTab;
	/** Section within the tab; items are ordered by TAB_GROUPS[tab] and rendered under a heading row. */
	group?: string;
	/**
	 * Optional visibility predicate. When supplied and returning false, the
	 * setting is hidden from the UI. Applies to every variant — booleans,
	 * enums, submenus, and text inputs.
	 */
	condition?: () => boolean;
}

export interface BooleanSettingDef extends BaseSettingDef {
	type: "boolean";
}

export interface EnumSettingDef extends BaseSettingDef {
	type: "enum";
	values: readonly string[];
}

type OptionList = ReadonlyArray<SubmenuOption>;

export interface SubmenuSettingDef extends BaseSettingDef {
	type: "submenu";
	options: OptionList;
	onPreview?: (value: string) => void;
	onPreviewCancel?: (originalValue: string) => void;
}

export interface TextInputSettingDef extends BaseSettingDef {
	type: "text";
	secret: boolean;
}

export interface ProviderLimitsSettingDef extends BaseSettingDef {
	type: "providerLimits";
}

/** Array-of-enum setting edited as a toggle list; `ordered` lists render positions and support reordering. */
export interface MultiSelectSettingDef extends BaseSettingDef {
	type: "multiselect";
	options: OptionList;
	ordered: boolean;
}

export type SettingDef =
	| BooleanSettingDef
	| EnumSettingDef
	| SubmenuSettingDef
	| TextInputSettingDef
	| ProviderLimitsSettingDef
	| MultiSelectSettingDef;

// ═══════════════════════════════════════════════════════════════════════════
// Condition Functions
// ═══════════════════════════════════════════════════════════════════════════

const CONDITIONS: Record<string, () => boolean> = {
	macOS: () => process.platform === "darwin",
	// Lid-closed prevention is applied by the desktop shell's main process, so
	// only a shell that declares the capability shows the switch.
	lidPower: () => uiCapabilities.lidPower,
	hasImageProtocol: () => !!TERMINAL.imageProtocol,
	advisorEnabled: () => {
		try {
			return Settings.instance.get("advisor.enabled") === true;
		} catch {
			return false;
		}
	},
	hindsightActive: () => {
		try {
			return Settings.instance.get("memory.backend") === "hindsight";
		} catch {
			return false;
		}
	},
	mnemopiActive: () => {
		try {
			return Settings.instance.get("memory.backend") === "mnemopi";
		} catch {
			return false;
		}
	},
	musememActive: () => {
		try {
			return Settings.instance.get("memory.backend") === "musemem";
		} catch {
			return false;
		}
	},
	autolearnActive: () => {
		try {
			return Settings.instance.get("autolearn.enabled") === true;
		} catch {
			return false;
		}
	},
	autoThinkingActive: () => {
		try {
			return Settings.instance.get("defaultThinkingLevel") === "auto";
		} catch {
			return false;
		}
	},
	usageAwareFallbackEnabled: () => {
		try {
			return Settings.instance.get("retry.usageAwareFallback") === true;
		} catch {
			return false;
		}
	},
	planModeEnabled: () => {
		try {
			return Settings.instance.get("plan.enabled");
		} catch {
			return false;
		}
	},
	lspActive: () => {
		try {
			return Settings.instance.get("lsp.enabled") === true;
		} catch {
			return false;
		}
	},
	sttPluginEnabled: () => pluginSettingsVisible("stt"),
	ttsPluginEnabled: () => pluginSettingsVisible("tts"),
	browserPluginEnabled: () => pluginSettingsVisible("browser"),
	computerPluginEnabled: () => pluginSettingsVisible("computer"),
	summarizeActive: () => {
		try {
			return Settings.instance.get("read.summarize.enabled") === true;
		} catch {
			return false;
		}
	},
	unexpectedStopSmart: () => {
		try {
			return Settings.instance.get("features.unexpectedStopDetection") === "smart";
		} catch {
			return false;
		}
	},
	// Compaction dependencies: a fixed token cap replaces the percentage, and
	// the method-specific rows only matter while that method is in the order.
	compactionNoTokenCap: () => {
		try {
			const tokens = Settings.instance.get("compaction.thresholdTokens");
			return !(typeof tokens === "number" && tokens > 0);
		} catch {
			return true;
		}
	},
	compactionRemoteMethod: () => {
		try {
			const order = Settings.instance.get("compaction.methodOrder");
			return Array.isArray(order) && order.includes("remote");
		} catch {
			return true;
		}
	},
	compactionHandoffMethod: () => {
		try {
			const order = Settings.instance.get("compaction.methodOrder");
			return Array.isArray(order) && order.includes("handoff");
		} catch {
			return true;
		}
	},
	compactionIdleEnabled: () => {
		try {
			return Settings.instance.get("compaction.idleEnabled") === true;
		} catch {
			return false;
		}
	},
	memoryIdleEnqueueEnabled: () => {
		try {
			return Settings.instance.get("memory.idleEnqueueEnabled") === true;
		} catch {
			return false;
		}
	},
	compactionModelOverrides: () => {
		try {
			return Settings.instance.get("compaction.modelThresholdsEnabled") !== false;
		} catch {
			return true;
		}
	},
};

// ═══════════════════════════════════════════════════════════════════════════
// Schema to UI Conversion
// ═══════════════════════════════════════════════════════════════════════════

function resolveOptions(ui: AnyUiMetadata): OptionList | "runtime" | undefined {
	if (!ui.options) return undefined;
	if (ui.options === "runtime") return "runtime";
	return ui.options;
}

function resolveCondition(condition: SettingCondition | undefined): (() => boolean) | undefined {
	if (!condition) return undefined;
	if (typeof condition === "string") return CONDITIONS[condition];
	return () => {
		try {
			return evaluateSettingCondition(condition, key => Settings.instance.getSettingValue(key));
		} catch {
			return true;
		}
	};
}

function pathToSettingDef(path: SettingPath): SettingDef | null {
	const ui = getUi(path);
	if (!ui) return null;
	// Dead/placeholder keys (ui.hidden) are not listed in the panel; the key
	// itself stays readable and writable via config.yml / `config` CLI.
	if (ui.hidden) return null;

	const schemaType = getType(path);
	const condition = resolveCondition(ui.condition);
	const base = { path, label: t(ui.label), description: t(ui.description), tab: ui.tab, group: ui.group, condition };

	if (schemaType === "boolean") {
		return { ...base, type: "boolean" };
	}

	const options = resolveOptions(ui);

	if (schemaType === "enum") {
		if (options === undefined) {
			return { ...base, type: "enum", values: getEnumValues(path) ?? [] };
		}
		// "runtime" is not a valid sentinel for enums — schema types prevent this,
		// but treat defensively as an empty submenu.
		return { ...base, type: "submenu", options: options === "runtime" ? [] : options };
	}

	if (schemaType === "number") {
		// Numbers without options are intentionally hidden from the UI.
		if (!options || options === "runtime") return null;
		return { ...base, type: "submenu", options };
	}

	if (schemaType === "string") {
		if (options === "runtime") {
			// Empty list now; the selector layer (theme handling, etc.) injects choices.
			return { ...base, type: "submenu", options: [] };
		}
		if (options) {
			return { ...base, type: "submenu", options };
		}
		// One classification drives both surfaces: a setting marked `credential`
		// masks here too, so the panel cannot display one that only the CLI knows
		// to redact.
		return { ...base, type: "text", secret: isCredential(path) };
	}

	if (schemaType === "array") {
		// Arrays without declared options stay config-file only (free-form lists
		// like extension paths have no finite choice set to toggle).
		if (!options || options === "runtime") return null;
		return { ...base, type: "multiselect", options, ordered: ui.ordered === true };
	}

	if (schemaType === "record") {
		return path === "providers.maxInFlightRequests"
			? { ...base, type: "providerLimits" }
			: { ...base, type: "text", secret: false };
	}

	return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/** Cache of generated definitions */
let cachedDefs: SettingDef[] | null = null;

// A provider/extension descriptor registered after first render (plugin mount,
// reload) must rebuild the menu instead of serving the pre-plugin list.
settingsRegistry.onDidChange(() => {
	cachedDefs = null;
});

/** Invalidate the cache (call after locale changes so defs rebuild with fresh translations). */
export function invalidateSettingDefsCache(): void {
	cachedDefs = null;
}

/** Get all setting definitions with UI */
export function getAllSettingDefs(): SettingDef[] {
	if (cachedDefs) return cachedDefs;

	const defs: SettingDef[] = [];
	for (const tab of SETTING_TABS) {
		for (const path of getPathsForTab(tab)) {
			const def = pathToSettingDef(path);
			if (def) defs.push(def);
		}
	}
	cachedDefs = defs;
	return defs;
}

/**
 * Get settings for a specific tab, ordered by the tab's group layout
 * (TAB_GROUPS). Ungrouped settings sort first; within a group, schema
 * declaration order is preserved.
 */
export function getSettingsForTab(tab: SettingTab): SettingDef[] {
	const defs = getAllSettingDefs().filter(def => def.tab === tab);
	const order = TAB_GROUPS[tab];
	const rank = (def: SettingDef): number => {
		if (!def.group) return -1;
		const index = order.indexOf(def.group);
		return index >= 0 ? index : order.length;
	};
	return defs.sort((a, b) => rank(a) - rank(b));
}

/** Get a setting definition by path */
export function getSettingDef(path: SettingPath): SettingDef | undefined {
	return getAllSettingDefs().find(def => def.path === path);
}

/** Get default value for display */
export function getDisplayDefault(path: SettingPath): string {
	const value = getDefault(path);
	if (value === undefined) return "";
	if (typeof value === "boolean") return value ? "true" : "false";
	return String(value);
}
