/**
 * Skill catalog change record.
 *
 * The reference implementation publishes a context-injection row when the
 * skill catalog changes. Ours keeps the model's view in the rebuilt base
 * prompt and logs a display-only custom message so the user can see what
 * changed without paying tokens for a duplicate reminder.
 */
import type { Skill } from "../extensibility/skills";

export const SKILL_CATALOG_CHANGE_CUSTOM_TYPE = "skill_catalog";

export interface SkillCatalogChangeData {
	added: string[];
	removed: string[];
	/** Same name, different description or version. */
	changed: string[];
}

/** Diff by name; returns null when the catalog is unchanged. */
export function diffSkillCatalog(previous: readonly Skill[], next: readonly Skill[]): SkillCatalogChangeData | null {
	const before = new Map(previous.map(skill => [skill.name, skill]));
	const after = new Map(next.map(skill => [skill.name, skill]));
	const added = [...after.keys()].filter(name => !before.has(name)).sort();
	const removed = [...before.keys()].filter(name => !after.has(name)).sort();
	const changed = [...after.keys()]
		.filter(name => {
			const was = before.get(name);
			const now = after.get(name);
			return (
				was !== undefined &&
				now !== undefined &&
				(was.description !== now.description || was.version !== now.version)
			);
		})
		.sort();
	return added.length > 0 || removed.length > 0 || changed.length > 0 ? { added, removed, changed } : null;
}

/**
 * Model-visible replacement listing (the reference implementation's text).
 *
 * Used when the system prompt is frozen — a live skill change or a host
 * without a prompt builder. The listing is complete because a name alone does
 * not tell the model when to read a newly added skill. Descriptions are
 * bounded like the reference's catalog.
 */
export function formatSkillCatalogReminder(skills: readonly Pick<Skill, "name" | "description" | "hide">[]): string {
	const lines = [
		"<system-reminder>",
		"The skill catalog changed since the system prompt was rendered; the listing below replaces it:",
	];
	const visible = skills.filter(skill => skill.hide !== true);
	if (visible.length === 0) lines.push("- no skills are currently available");
	for (const skill of visible) {
		const description = (skill.description ?? "").trim().slice(0, 500);
		lines.push(`- ${skill.name}${description ? `: ${description}` : ""}`);
	}
	lines.push("</system-reminder>");
	return lines.join("\n");
}
