import * as path from "node:path";
import { getActiveProfile } from "@musepi/pi-utils";
import { ensureModeTemplates, listModeIds, type ModeDefinition, type PresetPluginRow } from "../../../presets/resolve";
import { applyDshProfile, type DshApplication } from "../dsh/dsh-apply";
import type { DshValue } from "../dsh/dsh-patch";
import { profileDirFor, readProfileComposition, resolveBundleDirs, writeProfileBundles } from "./profile-composition";
import { writeRowConfigValue } from "./profile-patch-edit";

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
	return {
		...(typeof row.id === "string" && row.id ? { id: row.id } : {}),
		name: row.name,
		...(row.group === true ? { group: true } : {}),
		...(row.disabled === true ? { enabled: false } : row.disabled === false ? { enabled: true } : {}),
		...(children ? { config: children } : {}),
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
		.map(presetDefinition)
		.filter(row => row !== null);
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
	const modeDir = path.join(home, ".musepi", "modes");
	ensureModeTemplates(modeDir);
	const fileIds = listModeIds(modeDir);
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
