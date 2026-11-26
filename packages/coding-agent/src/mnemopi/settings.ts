/**
 * Settings rows owned by the memory-mnemopi plugin.
 *
 * The values, types and defaults stay in the core schema (`mnemopi.*`), so the
 * backend keeps working when the plugin is not mounted; this module only owns
 * the presentation and is registered through `ctx.settings.register`.
 */

interface MnemopiSettingCondition {
	key: string;
	equals?: unknown;
	notEquals?: unknown;
	in?: readonly unknown[];
}

const whenMnemopi: MnemopiSettingCondition = { key: "memory.backend", equals: "mnemopi" };

export interface MnemopiSettingRow {
	key: string;
	type: "boolean" | "enum" | "string" | "number";
	default: unknown;
	ui: {
		tab: string;
		group: string;
		label: string;
		description?: string;
		options?: { value: string; label: string; description?: string }[];
		condition?: MnemopiSettingCondition;
	};
}

export const MNEMOPI_SETTING_ROWS: readonly MnemopiSettingRow[] = [
	{
		key: "mnemopi.dbPath",
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi DB Path",
			description: "Optional SQLite DB path. Defaults to the agent memories directory.",
			condition: whenMnemopi,
		},
	},
	{
		key: "mnemopi.bank",
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Bank",
			description: "Optional shared bank base name. Per-project modes derive project-local banks from it.",
			condition: whenMnemopi,
		},
	},
	{
		key: "mnemopi.scoping",
		type: "enum",
		default: "per-project",
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Scoping",
			description:
				"global = one shared bank; per-project = isolated bank per cwd; per-project-tagged = project-local writes plus global recall visibility",
			options: [
				{ value: "global", label: "Global", description: "One shared Mnemopi bank for every project" },
				{
					value: "per-project",
					label: "Per project",
					description: "Project-local Mnemopi bank per cwd basename",
				},
				{
					value: "per-project-tagged",
					label: "Per project (tagged)",
					description: "Write to a project-local bank but merge project + shared recall results",
				},
			],
			condition: whenMnemopi,
		},
	},
	{
		key: "mnemopi.embeddingVariant",
		type: "enum",
		default: "en",
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Embedding variant",
			description:
				"Local embedding model family. en = stronger English model; multilingual = cross-language model. Changing this rebuilds existing memory embeddings on next start.",
			options: [
				{
					value: "en",
					label: "English (bge-base-en-v1.5)",
					description: "BAAI/bge-base-en-v1.5 (768d), English-only",
				},
				{
					value: "multilingual",
					label: "Multilingual (multilingual-e5-large)",
					description: "intfloat/multilingual-e5-large (1024d), cross-language recall",
				},
			],
			condition: whenMnemopi,
		},
	},
	{
		key: "mnemopi.autoRecall",
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Auto Recall",
			description: "Recall local memories into the first turn of each session",
			condition: whenMnemopi,
		},
	},
	{
		key: "mnemopi.autoRetain",
		type: "boolean",
		default: true,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Auto Retain",
			description: "Retain completed conversation turns into local Mnemopi memory",
			condition: whenMnemopi,
		},
	},
	{
		key: "mnemopi.polyphonicRecall",
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Polyphonic Recall",
			description: "Enable 4-voice recall (vector, graph, fact, temporal) fused with reciprocal rank fusion",
			condition: whenMnemopi,
		},
	},
	{
		key: "mnemopi.enhancedRecall",
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Enhanced Recall",
			description: "Enable the tiered query result cache for repeated and similar recall queries",
			condition: whenMnemopi,
		},
	},
	{
		key: "mnemopi.proactiveLinking",
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Proactive Linking",
			description:
				"Ingest new memories into the episodic graph as they are stored, linking them to related entities and memories",
			condition: whenMnemopi,
		},
	},
	{
		key: "mnemopi.noEmbeddings",
		type: "boolean",
		default: false,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Disable Embeddings",
			description: "Force deterministic FTS-only recall instead of vector embeddings",
			condition: whenMnemopi,
		},
	},
	{
		key: "mnemopi.embeddingModel",
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Embedding Model",
			description:
				"Advanced: explicit embedding model id that overrides the variant. Leave empty to use mnemopi.embeddingVariant.",
			condition: whenMnemopi,
		},
	},
	{
		key: "mnemopi.embeddingApiUrl",
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Embedding API URL",
			description: "Optional OpenAI-compatible embedding endpoint passed to Mnemopi",
			condition: whenMnemopi,
		},
	},
	{
		key: "mnemopi.embeddingApiKey",
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi Embedding API Key",
			description: "Optional embedding API key passed to Mnemopi",
			condition: whenMnemopi,
		},
	},
	{
		key: "mnemopi.llmMode",
		type: "enum",
		default: "smol",
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi LLM Mode",
			description:
				"Use no LLM, the online tiny model (the TINY role from /models, else @smol), or a remote OpenAI-compatible endpoint",
			options: [
				{ value: "none", label: "None", description: "Disable Mnemopi LLM-backed extraction" },
				{
					value: "smol",
					label: "Online (tiny)",
					description: "Use the online tiny model (the TINY role from /models, else @smol)",
				},
				{ value: "remote", label: "Remote", description: "Use the Mnemopi remote LLM settings below" },
			],
			condition: whenMnemopi,
		},
	},
	{
		key: "mnemopi.llmBaseUrl",
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi LLM Base URL",
			description: "Optional OpenAI-compatible LLM endpoint for Mnemopi remote mode",
			condition: whenMnemopi,
		},
	},
	{
		key: "mnemopi.llmApiKey",
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi LLM API Key",
			description: "Optional LLM API key for Mnemopi remote mode",
			condition: whenMnemopi,
		},
	},
	{
		key: "mnemopi.llmModel",
		type: "string",
		default: undefined,
		ui: {
			tab: "memory",
			group: "Mnemopi",
			label: "Mnemopi LLM Model",
			description: "Optional LLM model name for Mnemopi remote mode",
			condition: whenMnemopi,
		},
	},
];

/**
 * Defaults owned by this package: the key, its type and its default live here,
 * not in the core schema. Readers go through {@link readMnemopiSetting} so the
 * backend works when the plugin is not mounted.
 */
export const MNEMOPI_SETTING_DEFAULTS: Record<string, unknown> = {
	"mnemopi.dbPath": undefined,
	"mnemopi.bank": undefined,
	"mnemopi.scoping": "per-project",
	"mnemopi.embeddingVariant": "en",
	"mnemopi.autoRecall": true,
	"mnemopi.autoRetain": true,
	"mnemopi.polyphonicRecall": false,
	"mnemopi.enhancedRecall": false,
	"mnemopi.proactiveLinking": false,
	"mnemopi.noEmbeddings": false,
	"mnemopi.embeddingModel": undefined,
	"mnemopi.embeddingApiUrl": undefined,
	"mnemopi.embeddingApiKey": undefined,
	"mnemopi.llmMode": "smol",
	"mnemopi.llmBaseUrl": undefined,
	"mnemopi.llmApiKey": undefined,
	"mnemopi.llmModel": undefined,
	"mnemopi.retainEveryNTurns": 4,
	"mnemopi.recallLimit": 8,
	"mnemopi.recallContextTurns": 3,
	"mnemopi.recallMaxQueryChars": 4000,
	"mnemopi.injectionTokenLimit": 5000,
	"mnemopi.debug": false,
};

/** Keys this package stores as credentials; the plugin registers them masked. */
export const MNEMOPI_SETTING_CREDENTIALS: readonly string[] = ["mnemopi.embeddingApiKey", "mnemopi.llmApiKey"];

/** Read one `mnemopi.*` value: stored value, else the package default. */
export function readMnemopiSetting(settings: { getExtension(path: string): unknown }, key: string): unknown {
	const stored = settings.getExtension(key);
	return stored === undefined ? MNEMOPI_SETTING_DEFAULTS[key] : stored;
}

/** Typed reads for the config loader. */
export function readMnemopiString(settings: { getExtension(path: string): unknown }, key: string): string | undefined {
	const value = readMnemopiSetting(settings, key);
	return typeof value === "string" ? value : undefined;
}
export function readMnemopiBool(settings: { getExtension(path: string): unknown }, key: string): boolean {
	return readMnemopiSetting(settings, key) === true;
}
export function readMnemopiNumber(settings: { getExtension(path: string): unknown }, key: string): number {
	const value = readMnemopiSetting(settings, key);
	return typeof value === "number" ? value : 0;
}
