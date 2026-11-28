import * as path from "node:path";
import { getActiveProfile } from "@musepi/pi-utils";
import { presetsDir } from "../../../presets/locations";
import { ensureModeTemplates, listModeIds, type ModeDefinition, type PresetPluginRow } from "../../../presets/resolve";
import { applyDshProfile, type DshApplication } from "../dsh/dsh-apply";
import type { DshValue } from "../dsh/dsh-patch";
import { AGENT_PRESET_ROW_NAME, presetToRowConfig, rowConfigToPreset } from "./preset-row";
import { profileDirFor, readProfileComposition, resolveBundleDirs, writeProfileBundles } from "./profile-composition";
import { removeRow, writeRowConfig, writeRowConfigValue } from "./profile-patch-edit";

const AGENT_PRESET_PACKAGES = new Set(["@deepseek-ai/dsh-agent-preset", "@musepi/agent-preset"]);

function record(value: DshValue | undefined): Record<string, DshValue> | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	if ("kind" in value && value.kind === "js-expr") return undefined;
	const result: Record<string, DshValue> = {};
	Object.assign(result, value);
	return result;
}

function pluginRow(value: DshValue): PresetPluginRow | null {
	const row = record(value);
	if (!row || typeof row.name !== "string" || row.name === "") return null;
	const children = Array.isArray(row.config) ? row.config.map(pluginRow).filter(row => row !== null) : undefined;
	const ownConfig = children ? undefined : record(row.config);
	const isolateValue = record(row.isolate);
	const isolate = isolateValue
		? Object.fromEntries(
				Object.entries(isolateValue).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
			)
		: undefined;
	const inject = Array.isArray(row.inject)
		? row.inject.filter((name): name is string => typeof name === "string")
		: undefined;
	return {
		...(typeof row.id === "string" && row.id ? { id: row.id } : {}),
		name: row.name,
		...(row.group === true ? { group: true } : {}),
		...(row.disabled === true ? { enabled: false } : row.disabled === false ? { enabled: true } : {}),
		...(children ? { config: children } : ownConfig ? { config: ownConfig } : {}),
		...(isolate && Object.keys(isolate).length > 0 ? { isolate } : {}),
		...(inject && inject.length > 0 ? { inject } : {}),
	};
}

function presetDefinition(row: { id: string; name: string; config: DshValue | undefined }): ModeDefinition | null {
	const config = record(row.config);
	if (!config || typeof config.id !== "string" || config.id === "") return null;
	const id = config.id;
	const rows = Array.isArray(config.plugins) ? config.plugins.map(pluginRow).filter(row => row !== null) : [];
	const persona = (Array.isArray(config.plugins) ? config.plugins : []).find(candidate => {
		const nested = record(candidate);
		return nested?.id === "persona";
	});
	const personaConfig = record(record(persona)?.config);
	const prefix = typeof personaConfig?.prefix === "string" ? personaConfig.prefix : undefined;
	return {
		id,
		label: typeof config.name === "string" && config.name ? config.name : id,
		...(typeof config.description === "string" ? { description: config.description } : {}),
		plugins: rows,
		prompt: prefix ? [{ name: `mode:${id}:persona`, order: 0, text: prefix }] : [],
		promptComplete: personaConfig?.complete === true,
		runtimeContext: personaConfig?.includeRuntimeContext !== false,
	};
}

interface ProfileProjection {
	application: DshApplication;
	profilePatchPath?: string;
}

async function projectProfile(cwd: string, home: string, name: string): Promise<ProfileProjection | null> {
	const note = await readProfileComposition(name, home);
	if (note.kind !== "ok") return null;
	const bundles = await resolveBundleDirs(note.composition.bundles, note.composition.dir, home);
	const application = await applyDshProfile(
		{
			name,
			bundleDirs: bundles.map(entry => entry.dir),
			...(note.composition.profilePatchPath ? { profilePatchPath: note.composition.profilePatchPath } : {}),
		},
		cwd,
		home,
	);
	return {
		application,
		...(note.composition.profilePatchPath ? { profilePatchPath: note.composition.profilePatchPath } : {}),
	};
}

/** Project Agent preset declarations from the active profile's bundle composition. */
export async function collectProfilePresetDefinitions(
	cwd: string,
	home: string,
	profileName?: string,
): Promise<ModeDefinition[]> {
	const projection = await projectProfile(cwd, home, profileName ?? getActiveProfile() ?? "");
	if (!projection) return [];
	return projection.application.composition.rows
		.filter(row => AGENT_PRESET_PACKAGES.has(row.name) && row.disabled !== true)
		.map(row => rowConfigToPreset(row.config))
		.filter((def): def is ModeDefinition => def !== null);
}

/** The patch a write lands in: the profile's own patch file, created when the
 *  profile has none yet. */
async function presetPatchPath(cwd: string, home: string, profileName?: string): Promise<string> {
	const name = profileName ?? getActiveProfile() ?? "";
	let projection = await projectProfile(cwd, home, name);
	if (!projection) {
		await writeProfileBundles(name, [], home);
		projection = await projectProfile(cwd, home, name);
	}
	if (!projection) throw new Error("No profile composition is available");
	return projection.profilePatchPath ?? path.join(profileDirFor(name, home), "cordis.patch.yml");
}

/**
 * Persist a preset as one declaration row in the profile patch — the same place
 * any Cordis plugin declaration lives, rather than a directory of its own.
 *
 * Writing the whole `config` block (not key by key) is what keeps a save from
 * leaving a stale field behind when the definition drops one.
 */
export async function writeProfilePreset(
	cwd: string,
	home: string,
	def: ModeDefinition,
	order: number,
	profileName?: string,
): Promise<void> {
	const patchPath = await presetPatchPath(cwd, home, profileName);
	await writeRowConfig(patchPath, `preset-${def.id}`, AGENT_PRESET_ROW_NAME, presetToRowConfig(def, order));
}

/** Remove a preset's declaration rows from the profile patch. */
export async function removeProfilePreset(cwd: string, home: string, id: string, profileName?: string): Promise<void> {
	const patchPath = await presetPatchPath(cwd, home, profileName);
	await removeRow(patchPath, `preset-${id}`);
}

/** Default preset for a subsequently created session. */
export async function readDefaultPresetId(cwd: string, home: string, profileName?: string): Promise<string> {
	const projection = await projectProfile(cwd, home, profileName ?? getActiveProfile() ?? "");
	if (!projection) return "work";
	const registry = projection.application.composition.rows.find(row => row.id === "agent-preset-registry");
	const config = record(registry?.config);
	const selected = config?.selectedDefault ?? config?.default;
	return typeof selected === "string" && selected ? selected : "work";
}

/** Persist a new-session default in the profile's agent-preset registry row. */
export async function writeDefaultPresetId(
	cwd: string,
	home: string,
	id: string,
	profileName?: string,
): Promise<string> {
	const name = profileName ?? getActiveProfile() ?? "";
	let projection = await projectProfile(cwd, home, name);
	if (!projection) {
		await writeProfileBundles(name, [], home);
		projection = await projectProfile(cwd, home, name);
	}
	if (!projection) throw new Error("No profile composition is available");
	const definitions = projection.application.composition.rows
		.filter(row => AGENT_PRESET_PACKAGES.has(row.name) && row.disabled !== true)
		.map(presetDefinition)
		.filter(row => row !== null);
	ensureModeTemplates(presetsDir(home));
	const fileIds = listModeIds(presetsDir(home));
	if (!fileIds.includes(id) && !definitions.some(definition => definition.id === id)) {
		throw new Error(`Unknown agent preset: ${id}`);
	}
	const patchPath = projection.profilePatchPath ?? path.join(profileDirFor(name, home), "cordis.patch.yml");
	await writeRowConfigValue(
		patchPath,
		"agent-preset-registry",
		"@musepi/agent-preset-registry",
		"selectedDefault",
		id,
	);
	return readDefaultPresetId(cwd, home, name);
}
