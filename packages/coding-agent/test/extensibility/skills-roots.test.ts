import { describe, expect, it } from "bun:test";
import { type LoadSkillsResult, mergeSkillResults, type Skill } from "@musepi/pi-coding-agent/extensibility/skills";

function skill(name: string, filePath = `/primary/${name}/SKILL.md`): Skill {
	return { name, description: `${name} skill`, filePath, baseDir: `/primary/${name}`, source: "native:project" };
}

function result(skills: Skill[], warnings: LoadSkillsResult["warnings"] = []): LoadSkillsResult {
	return { skills, warnings };
}

describe("mergeSkillResults", () => {
	it("keeps the primary root when a related directory reuses a skill name", () => {
		const primary = result([skill("review")], [{ skillPath: "/primary", message: "primary warning" }]);
		const extra = result(
			[skill("review", "/references/review/SKILL.md"), skill("docs", "/references/docs/SKILL.md")],
			[{ skillPath: "/references", message: "extra warning" }],
		);

		const merged = mergeSkillResults(primary, [extra]);

		expect(merged.skills.map(entry => entry.name)).toEqual(["review", "docs"]);
		expect(merged.skills[0]!.filePath).toBe("/primary/review/SKILL.md");
		expect(merged.warnings.map(warning => warning.message)).toEqual(["primary warning", "extra warning"]);
	});

	it("preserves primary order and appends new roots' skills", () => {
		const merged = mergeSkillResults(result([skill("a"), skill("b")]), [
			result([skill("c"), skill("a", "/other/a/SKILL.md")]),
		]);

		expect(merged.skills.map(entry => entry.name)).toEqual(["a", "b", "c"]);
	});

	it("returns the primary result unchanged when there are no extra roots", () => {
		const primary = result([skill("only")]);

		expect(mergeSkillResults(primary, [])).toEqual(primary);
	});
});
