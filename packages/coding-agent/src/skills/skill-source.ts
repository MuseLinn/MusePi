/**
 * Provenance sidecar for an installed skill.
 *
 * `skills.list` can only answer "is this current?" when the install recorded
 * where it came from. The sidecar lives inside the skill directory (the
 * scanner only looks at `SKILL.md`, so it never becomes a skill) and is
 * rewritten on every reinstall. It is deliberately data-only: no executable
 * content, no credentials.
 */
import { readFile, writeFile } from "node:fs/promises";
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
