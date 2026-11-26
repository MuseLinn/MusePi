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
