import type { ModeDefinition, PresetPluginRow } from "../../../presets/resolve";
import type { DshValue } from "../dsh/dsh-patch";

/**
 * A preset as a Cordis declaration row's `config`.
 *
 * A preset lives in the profile patch the same way any other Cordis plugin
 * declaration does — one `- insert:` entry whose `config` describes it — rather
 * than in a directory of its own. The shape below is what that `config` holds:
 * `id`/`name`/`description`/`order`/`plugins` are the declaration every Cordis
 * consumer understands, and the remaining fields are this host's preset
 * capabilities (`extends`, `settings`, model/extensions/tool selection, prompt
 * blocks) carried alongside them.
 *
 * Keeping the extra fields here rather than folding them into `plugins` is
 * deliberate: a preset's settings overrides and inheritance chain are not
 * plugin rows, and pretending they were would put host policy inside the
 * plugin composition.
 */

/** Row name every preset declaration carries. */
export const AGENT_PRESET_ROW_NAME = "@musepi/agent-preset";

/** Field names this host adds beside the Cordis declaration fields. */
const HOST_FIELDS = [
	"extends",
	"settings",
	"modelRole",
	"extensions",
	"topLevelTools",
	"prompt",
	"promptComplete",
	"runtimeContext",
	"builtinRevision",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Drop `undefined` so a round trip cannot invent a key. */
function defined(source: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined));
}

/** Encode one plugin row: `enabled` is the row's `disabled` on the wire, so an
 *  override that turns a parent's row off survives the trip. */
function pluginRowToWire(row: PresetPluginRow): Record<string, unknown> {
	return defined({
		name: row.name,
		id: row.id,
		group: row.group === true ? true : undefined,
		disabled: row.enabled === false ? true : row.enabled === true ? false : undefined,
		config: row.config,
		isolate: row.isolate,
		inject: row.inject && row.inject.length > 0 ? [...row.inject] : undefined,
	});
}

/** Encode a preset into the `config` block of its declaration row. */
export function presetToRowConfig(def: ModeDefinition, order: number): Record<string, unknown> {
	return defined({
		// Cordis declaration fields.
		id: def.id,
		name: def.label ?? def.id,
		order,
		...(def.description !== undefined ? { description: def.description } : {}),
		plugins: (def.plugins ?? []).map(pluginRowToWire),
		// Host capability fields, carried verbatim.
		...(def.extends !== undefined ? { extends: def.extends } : {}),
		...(def.settings !== undefined ? { settings: def.settings } : {}),
		...(def.modelRole !== undefined ? { modelRole: def.modelRole } : {}),
		...(def.extensions !== undefined ? { extensions: def.extensions } : {}),
		...(def.topLevelTools !== undefined ? { topLevelTools: def.topLevelTools } : {}),
		...(def.prompt !== undefined ? { prompt: def.prompt } : {}),
		...(def.promptComplete !== undefined ? { promptComplete: def.promptComplete } : {}),
		...(def.runtimeContext !== undefined ? { runtimeContext: def.runtimeContext } : {}),
		...(def.builtinRevision !== undefined ? { builtinRevision: def.builtinRevision } : {}),
	});
}

function pluginRows(value: DshValue | undefined): PresetPluginRow[] {
	if (!Array.isArray(value)) return [];
	const out: PresetPluginRow[] = [];
	for (const entry of value) {
		if (!isPlainObject(entry)) continue;
		const row: Record<string, unknown> = entry;
		const children = Array.isArray(row.config) ? pluginRows(row.config as DshValue) : undefined;
		const isolate = isPlainObject(row.isolate)
			? Object.fromEntries(
					Object.entries(row.isolate).filter((item): item is [string, boolean] => typeof item[1] === "boolean"),
				)
			: undefined;
		const inject = Array.isArray(row.inject)
			? row.inject.filter((name): name is string => typeof name === "string")
			: undefined;
		out.push(
			defined({
				name: typeof row.name === "string" ? row.name : "",
				id: typeof row.id === "string" && row.id ? row.id : undefined,
				group: row.group === true ? true : undefined,
				enabled: row.disabled === true ? false : row.disabled === false ? true : undefined,
				config: children ?? (isPlainObject(row.config) ? row.config : undefined),
				isolate: isolate && Object.keys(isolate).length > 0 ? isolate : undefined,
				inject: inject && inject.length > 0 ? inject : undefined,
			}) as unknown as PresetPluginRow,
		);
	}
	return out;
}

/** Prompt blocks, tolerating the `string` shorthand the file format allows. */
function promptBlocks(value: DshValue | undefined): ModeDefinition["prompt"] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: NonNullable<ModeDefinition["prompt"]> = [];
	for (const entry of value) {
		if (typeof entry === "string") out.push({ name: `mode:block:${out.length}`, order: 25, text: entry });
		else if (isPlainObject(entry) && typeof entry.text === "string") {
			out.push({
				name: typeof entry.name === "string" ? entry.name : `mode:block:${out.length}`,
				order: typeof entry.order === "number" ? entry.order : 25,
				text: entry.text,
			});
		}
	}
	return out;
}

/**
 * Decode a declaration row's `config` back into a preset.
 *
 * `id` is required — a row without one is not a preset declaration, and
 * returning a half-built preset for it would make a malformed row look like an
 * empty preset.
 */
export function rowConfigToPreset(config: DshValue | undefined): ModeDefinition | null {
	if (!isPlainObject(config) || typeof config.id !== "string" || config.id === "") return null;
	// A declaration written by another Cordis host carries its prompt as the
	// persona row's `prefix` rather than as prompt blocks, so read that form too;
	// an explicit `prompt` still wins because it is this host's own field.
	const rows = pluginRows(config.plugins as DshValue | undefined);
	const prompt = promptBlocks(config.prompt) ?? personaPrompt(rows, config.id);
	const strings = (value: unknown): string[] | undefined =>
		Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
	return defined({
		id: config.id,
		label: typeof config.name === "string" && config.name ? config.name : config.id,
		description: typeof config.description === "string" ? config.description : undefined,
		plugins: rows,
		extends: strings(config.extends),
		settings: isPlainObject(config.settings) ? config.settings : undefined,
		modelRole: typeof config.modelRole === "string" ? config.modelRole : undefined,
		extensions: strings(config.extensions),
		topLevelTools: strings(config.topLevelTools),
		prompt,
		promptComplete:
			typeof config.promptComplete === "boolean" ? config.promptComplete : personaFlag(rows, "complete"),
		runtimeContext:
			typeof config.runtimeContext === "boolean"
				? config.runtimeContext
				: personaFlag(rows, "includeRuntimeContext"),
		builtinRevision: typeof config.builtinRevision === "number" ? config.builtinRevision : undefined,
	}) as unknown as ModeDefinition;
}

/** The persona row's config, the form a declaration from another host uses. */
function personaConfig(rows: readonly PresetPluginRow[]): Record<string, unknown> | undefined {
	const persona = rows.find(row => row.id === "persona");
	return isPlainObject(persona?.config) ? persona.config : undefined;
}

/** Prompt blocks equivalent to a persona row's `prefix`, when one is present. */
function personaPrompt(rows: readonly PresetPluginRow[], id: string): ModeDefinition["prompt"] {
	const prefix = personaConfig(rows)?.prefix;
	return typeof prefix === "string" && prefix ? [{ name: `mode:${id}:persona`, order: 0, text: prefix }] : undefined;
}

/** A boolean the persona row carries (`complete`, `includeRuntimeContext`). */
function personaFlag(rows: readonly PresetPluginRow[], key: string): boolean | undefined {
	const value = personaConfig(rows)?.[key];
	return typeof value === "boolean" ? value : undefined;
}

/** The host field names this codec owns; exported for the round-trip test. */
export const PRESET_HOST_FIELDS: readonly string[] = HOST_FIELDS;
