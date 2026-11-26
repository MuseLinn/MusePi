/**
 * Settings rows owned by the memory-hindsight plugin.
 *
 * Values, types and defaults stay in the core schema (`hindsight.*`), so the
 * backend keeps working when the plugin is not mounted; this module owns only
 * the presentation and is registered through `ctx.settings.register`.
 */

interface HindsightSettingCondition {
	key: string;
	equals?: unknown;
	notEquals?: unknown;
	in?: readonly unknown[];
}

const whenHindsight: HindsightSettingCondition = { key: "memory.backend", equals: "hindsight" };

/**
 * Defaults owned by this package: the key, its type and its default live here,
 * not in the core schema. `loadHindsightConfig` reads the stored value and falls
 * back to this table, so the backend works when the plugin is not mounted.
 */
export const HINDSIGHT_SETTING_DEFAULTS = {
	"hindsight.apiUrl": "http://localhost:8888",
	"hindsight.apiToken": undefined,
	"hindsight.bankId": undefined,
	"hindsight.bankIdPrefix": undefined,
	"hindsight.scoping": "per-project-tagged",
	"hindsight.globalScope": false,
	"hindsight.bankMission": undefined,
	"hindsight.retainMission": undefined,
	"hindsight.autoRecall": true,
	"hindsight.autoRetain": true,
	"hindsight.retainMode": "full-session",
	"hindsight.retainEveryNTurns": 3,
	"hindsight.retainOverlapTurns": 2,
	"hindsight.retainContext": "musepi",
	"hindsight.recallBudget": "mid",
	"hindsight.recallMaxTokens": 1024,
	"hindsight.recallContextTurns": 1,
	"hindsight.recallMaxQueryChars": 800,
	"hindsight.recallTypes": ["world", "experience"],
	"hindsight.debug": false,
	"hindsight.requestTimeoutMs": 30_000,
	"hindsight.reflectTimeoutMs": 120_000,
	"hindsight.recallTimeoutMs": 30_000,
	"hindsight.retainTimeoutMs": 60_000,
	"hindsight.mentalModelsEnabled": true,
	"hindsight.mentalModelAutoSeed": true,
	"hindsight.mentalModelRefreshIntervalMs": 5 * 60 * 1000,
	"hindsight.mentalModelMaxRenderChars": 16_000,
} as const satisfies Record<string, unknown>;

export type HindsightSettingKey = keyof typeof HINDSIGHT_SETTING_DEFAULTS;

/** Keys this package stores as credentials; the plugin registers them masked. */
export const HINDSIGHT_SETTING_CREDENTIALS: readonly string[] = ["hindsight.apiToken"];

/** Read one `hindsight.*` value: stored value, else the package default. */
export function readHindsightSetting<K extends HindsightSettingKey>(
	settings: { getExtension(path: string): unknown },
	key: K,
): (typeof HINDSIGHT_SETTING_DEFAULTS)[K] {
	const stored = settings.getExtension(key);
	return (stored === undefined ? HINDSIGHT_SETTING_DEFAULTS[key] : stored) as (typeof HINDSIGHT_SETTING_DEFAULTS)[K];
}

export interface HindsightSettingRow {
	key: string;
	type: "boolean" | "enum" | "string" | "number";
	default: unknown;
	ui: {
		tab: string;
		group: string;
		label: string;
		description?: string;
		options?: { value: string; label: string; description?: string }[];
		condition?: HindsightSettingCondition;
	};
}

export const HINDSIGHT_SETTING_ROWS: readonly HindsightSettingRow[] = [
	{
		key: "hindsight.apiUrl",
		type: "string",
		default: "http://localhost:8888",
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight API URL",
			description: "Hindsight server URL (Cloud or self-hosted)",
			condition: whenHindsight,
		},
	},
	{
		key: "hindsight.apiToken",
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight API Token",
			description: "Bearer token for authenticated Hindsight servers",
			condition: whenHindsight,
		},
	},
	{
		key: "hindsight.bankId",
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight Bank ID",
			description: "Memory bank identifier (default: project name)",
			condition: whenHindsight,
		},
	},
	{
		key: "hindsight.scoping",
		type: "enum",
		default: "per-project-tagged",
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight Scoping",
			description:
				"global = one shared bank; per-project = isolated bank per cwd; per-project-tagged = shared bank with project tags so global + project memories merge on recall",
			options: [
				{ value: "global", label: "Global", description: "One shared bank — every project sees the same memories" },
				{
					value: "per-project",
					label: "Per project",
					description: "Isolated bank per cwd basename — projects cannot see each other's memories",
				},
				{
					value: "per-project-tagged",
					label: "Per project (tagged)",
					description:
						"Shared bank, retains tagged with project:<cwd>. Recall surfaces project + untagged global memories together",
				},
			],
			condition: whenHindsight,
		},
	},
	{
		key: "hindsight.globalScope",
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight Global Scope",
			description:
				"Let retain and learn take scope: global, which stores a memory without the project tag so every project recalls it. Needs global or per-project-tagged scoping",
			condition: whenHindsight,
		},
	},
	{
		key: "hindsight.autoRecall",
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight Auto Recall",
			description: "Recall memories on the first turn of each session",
			condition: whenHindsight,
		},
	},
	{
		key: "hindsight.autoRetain",
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight Auto Retain",
			description: "Retain transcript every N turns and at session boundaries",
			condition: whenHindsight,
		},
	},
	{
		key: "hindsight.retainMode",
		type: "enum",
		default: "full-session",
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight Retain Mode",
			description: "full-session = upsert one document per session, last-turn = chunked",
			options: [
				{
					value: "full-session",
					label: "Full session",
					description: "Upsert one document per session (recommended)",
				},
				{ value: "last-turn", label: "Last turn", description: "Chunked retention sliced by turn boundaries" },
			],
			condition: whenHindsight,
		},
	},
	{
		key: "hindsight.mentalModelsEnabled",
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight Mental Models",
			description:
				"Read curated reflect summaries (mental models) into developer instructions at boot. Loads existing models on the bank — does not write. Pair with hindsight.mentalModelAutoSeed to also auto-create the built-in seed set.",
			condition: whenHindsight,
		},
	},
	{
		key: "hindsight.mentalModelAutoSeed",
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: "Hindsight",
			label: "Hindsight Mental Model Auto-Seed",
			description:
				"At session start, create any built-in mental models (project-conventions, project-decisions, user-preferences) that do not yet exist on the bank.",
			condition: whenHindsight,
		},
	},
];
