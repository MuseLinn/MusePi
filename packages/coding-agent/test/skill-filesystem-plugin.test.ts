import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@musepi/pi-utils";
import { rootsFromConfig, scanSkillRoot, skillFromMarkdown } from "../src/bundled-plugins/skill-filesystem/index";

describe("musepi-skill-filesystem", () => {
	it("parses roots as a JSON array and treats an empty field as no roots", () => {
		expect(rootsFromConfig("")).toEqual([]);
		expect(rootsFromConfig('["a","~/pack"]')).toEqual(["a", "~/pack"]);
		expect(() => rootsFromConfig("nope")).toThrow("roots is not valid JSON");
		expect(() => rootsFromConfig('[""]')).toThrow("non-empty strings");
	});

	it("reads SKILL.md bundles and flat .md files, skipping skills without a description", async () => {
		const tempDir = TempDir.createSync("@skill-filesystem-");
		try {
			fs.mkdirSync(path.join(tempDir.path(), "bundle"), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir.path(), "bundle", "SKILL.md"),
				"---\nname: bundle-skill\ndescription: A bundled skill\n---\n\nBody text\n",
			);
			fs.writeFileSync(path.join(tempDir.path(), "flat.md"), "---\ndescription: A flat skill\n---\n\nFlat body\n");
			fs.writeFileSync(path.join(tempDir.path(), "invalid.md"), "---\nname: no-description\n---\n\nBody\n");

			const skills = await scanSkillRoot(tempDir.path());
			expect(skills).toEqual([
				{ name: "bundle-skill", description: "A bundled skill", content: "Body text" },
				{ name: "flat", description: "A flat skill", content: "Flat body" },
			]);
		} finally {
			tempDir.removeSync();
		}
	});

	it("derives the skill name from the file when frontmatter omits it", () => {
		expect(skillFromMarkdown("stem", "---\ndescription: d\n---\nbody")).toEqual({
			name: "stem",
			description: "d",
			content: "body",
		});
		expect(skillFromMarkdown("stem", "---\nname: x\n---\n")).toBeNull();
	});
});
