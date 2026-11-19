import { describe, expect, it } from "bun:test";
import type { Skill } from "../src/extensibility/skills";
import { diffSkillCatalog, formatSkillCatalogReminder } from "../src/session/skill-catalog";

function skill(name: string, description = "", version?: string): Skill {
	return { name, description, filePath: `${name}/SKILL.md`, baseDir: name, source: "native:user", version } as Skill;
}

describe("diffSkillCatalog", () => {
	it("returns null for an unchanged catalog", () => {
		expect(diffSkillCatalog([skill("a", "x")], [skill("a", "x")])).toBeNull();
	});

	it("reports additions, removals, and description/version changes by name", () => {
		const change = diffSkillCatalog(
			[skill("keep"), skill("gone"), skill("edited", "old")],
			[skill("keep"), skill("edited", "new"), skill("fresh", "", "1.0.0")],
		);
		expect(change).toEqual({ added: ["fresh"], removed: ["gone"], changed: ["edited"] });
	});

	it("treats a version bump with the same description as a change", () => {
		expect(diffSkillCatalog([skill("demo", "d", "1.0.0")], [skill("demo", "d", "1.1.0")])).toEqual({
			added: [],
			removed: [],
			changed: ["demo"],
		});
	});
});

describe("formatSkillCatalogReminder", () => {
	it("renders a replacement listing with descriptions for a frozen prompt", () => {
		const text = formatSkillCatalogReminder([
			skill("alpha", "first skill"),
			{ ...skill("hidden", "not listed"), hide: true },
		]);
		expect(text.startsWith("<system-reminder>")).toBe(true);
		expect(text).toContain("- alpha: first skill");
		expect(text).not.toContain("not listed");
		expect(text.endsWith("</system-reminder>")).toBe(true);
	});

	it("states an explicitly empty catalog", () => {
		expect(formatSkillCatalogReminder([])).toContain("no skills are currently available");
	});
});
