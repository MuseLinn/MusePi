/**
 * Provenance sidecar for an installed skill.
 *
 * `skills.list` can only answer "is this current?" when the install recorded
 * where it came from. The sidecar lives inside the skill directory (the
 * scanner only looks at `SKILL.md`, so it never becomes a skill) and is
 * rewritten on every reinstall. It is deliberately data-only: no executable
 * content, no credentials.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

export const SKILL_SOURCE_FILE = ".musepi-skill.json";

export type SkillSourceKind = "skillhub" | "skills.sh" | "git";

export interface SkillSourceRecord {
	schemaVersion: 1;
	source: SkillSourceKind;
	/** Catalog slug (SkillHub / skills.sh). */
	slug?: string;
	/** Publisher repo for skills.sh (`owner/repo`). */
	repo?: string;
	/** Git URL for `skills.install` installs. */
	url?: string;
	/** Repo-relative skill folder for skills.sh / git installs. */
	subdir?: string;
	/** Catalog version when the source publishes one (SkillHub). */
	version?: string;
	/** Commit the install was taken from (skills.sh / git). */
	commit?: string;
	/** Content digest of the installed folder (sidecar excluded), so an update
	 *  can tell "same as installed" from "edited locally". */
	contentHash?: string;
	installedAt: string;
}

export function skillSourcePath(skillDir: string): string {
	return path.join(skillDir, SKILL_SOURCE_FILE);
}

export async function writeSkillSource(skillDir: string, record: SkillSourceRecord): Promise<void> {
	await writeFile(skillSourcePath(skillDir), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

/** Read and validate the sidecar; null when absent or not a record we wrote. */
export async function readSkillSource(skillDir: string): Promise<SkillSourceRecord | null> {
	try {
		const parsed = JSON.parse(await readFile(skillSourcePath(skillDir), "utf8")) as Partial<SkillSourceRecord>;
		if (parsed.schemaVersion !== 1) return null;
		if (parsed.source !== "skillhub" && parsed.source !== "skills.sh" && parsed.source !== "git") return null;
		return parsed as SkillSourceRecord;
	} catch {
		return null;
	}
}

/** Digest of the skill directory: relative path + bytes, sorted, sidecar out. */
export async function hashSkillDirectory(root: string): Promise<string | null> {
	const MAX_FILES = 4000;
	const MAX_BYTES = 32 * 1024 * 1024;
	const hash = createHash("sha256");
	let files = 0;
	let bytes = 0;
	const walk = async (dir: string, relative: string): Promise<boolean> => {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return false;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const rel = relative ? `${relative}/${entry.name}` : entry.name;
			if (rel === SKILL_SOURCE_FILE) continue;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				hash.update(`d:${rel}
`);
				if (!(await walk(full, rel))) return false;
				continue;
			}
			if (!entry.isFile()) continue;
			files += 1;
			if (files > MAX_FILES) return false;
			const info = await stat(full);
			if (bytes + info.size > MAX_BYTES) return false;
			bytes += info.size;
			hash.update(`f:${rel}:${info.size}
`);
			hash.update(await readFile(full));
		}
		return true;
	};
	try {
		if (!(await walk(root, ""))) return null;
		return hash.digest("hex");
	} catch {
		return null;
	}
}
