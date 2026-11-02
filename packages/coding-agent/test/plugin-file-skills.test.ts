import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { loadSkills } from "../src/extensibility/skills";

const DISABLE_THIRD_PARTY_SKILLS = {
	enableCodexUser: false,
	enableClaudeUser: false,
	enableClaudeProject: false,
	enablePiUser: false,
	enablePiProject: false,
	enableAgentsUser: false,
	enableAgentsProject: false,
} as const;

const PRODUCT_SKILLS = [
	"board-design",
	"musepi-contributing",
	"musepi-extension-dev",
	"musepi-help",
	"ui-ux-pro-max",
	"widget-design",
] as const;
const PRODUCT_SKILL_NAMES = new Set<string>(PRODUCT_SKILLS);

describe("MusePi plugin file skills", () => {
	it("loads package resources and removes the package skills when its plugin is disabled", async () => {
		const enabled = await loadSkills({ ...DISABLE_THIRD_PARTY_SKILLS });
		const product = enabled.skills.filter(skill => PRODUCT_SKILL_NAMES.has(skill.name));
		expect(product.map(skill => skill.name).sort()).toEqual([...PRODUCT_SKILLS].sort());

		const design = product.find(skill => skill.name === "ui-ux-pro-max");
		expect(design?.filePath).toBe(
			path.resolve(import.meta.dir, "../src/bundled-plugins/product-skills/skills/ui-ux-pro-max/SKILL.md"),
		);
		expect(await Bun.file(path.join(design?.baseDir ?? "", "scripts/search.py")).exists()).toBe(true);

		const disabled = await loadSkills({
			...DISABLE_THIRD_PARTY_SKILLS,
			disabledExtensions: ["musepi-product-skills"],
		});
		expect(disabled.skills.some(skill => PRODUCT_SKILL_NAMES.has(skill.name))).toBe(false);
		expect(disabled.skills.some(skill => skill.name === "android-emulator")).toBe(true);
	});
});
