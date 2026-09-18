import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	installSkillFromGit,
	normalizeSkillSource,
	parseSkillName,
	resolveSkillDir,
	skillTargetName,
} from "../src/skills/install";

let repoDir: string;
let destRoot: string;

beforeAll(() => {
	// A local git repo doubles as the clone source — keeps every case offline.
	repoDir = join(tmpdir(), `musepi-skill-src-${Date.now()}`);
	destRoot = join(tmpdir(), `musepi-skill-dest-${Date.now()}`);
	mkdirSync(join(repoDir, "my-skill"), { recursive: true });
	writeFileSync(join(repoDir, "my-skill", "SKILL.md"), "---\nname: my-skill\ndescription: demo\n---\n\n# My skill\n");
	writeFileSync(join(repoDir, "README.md"), "# repo\n");
	execSync(
		`git init -q "${repoDir}" && git -C "${repoDir}" add -A && git -C "${repoDir}" -c user.email=t@t -c user.name=t commit -qm init`,
	);
	mkdirSync(destRoot, { recursive: true });
});

afterAll(() => {
	rmSync(repoDir, { recursive: true, force: true });
	rmSync(destRoot, { recursive: true, force: true });
});

describe("normalizeSkillSource", () => {
	test("expands GitHub slugs, keeps URLs", () => {
		expect(normalizeSkillSource("owner/repo")).toBe("https://github.com/owner/repo.git");
		expect(normalizeSkillSource("https://github.com/owner/repo.git")).toBe("https://github.com/owner/repo.git");
	});
});

describe("resolveSkillDir", () => {
	test("explicit subdir → root SKILL.md → unique recursive match → null", () => {
		expect(resolveSkillDir(repoDir, "my-skill")?.endsWith("my-skill")).toBe(true);
		// no root SKILL.md — the unique recursive match wins
		expect(resolveSkillDir(repoDir)?.endsWith("my-skill")).toBe(true);
	});
});

describe("parseSkillName", () => {
	test("reads the frontmatter name, null without frontmatter", () => {
		expect(parseSkillName("---\nname: foo\n---\nbody")).toBe("foo");
		expect(parseSkillName('---\nname: "quoted"\n---\n')).toBe("quoted");
		expect(parseSkillName("no frontmatter")).toBe(null);
	});
});

describe("skillTargetName", () => {
	test("explicit > frontmatter > folder name", () => {
		expect(skillTargetName(join(repoDir, "my-skill"), "custom")).toBe("custom");
		expect(skillTargetName(join(repoDir, "my-skill"))).toBe("my-skill");
	});
});

describe("installSkillFromGit (local path clone, offline)", () => {
	test("installs the skill folder into destRoot under its frontmatter name", async () => {
		const result = await installSkillFromGit({ url: repoDir, subdir: "my-skill", destRoot, allowLocalPath: true });
		expect(result.name).toBe("my-skill");
		expect(existsSync(join(result.dir, "SKILL.md"))).toBe(true);
	});

	test("refuses overwrite without the flag, replaces with it", async () => {
		await expect(
			installSkillFromGit({ url: repoDir, subdir: "my-skill", destRoot, allowLocalPath: true }),
		).rejects.toThrow(/already exists/);
		await installSkillFromGit({ url: repoDir, subdir: "my-skill", destRoot, overwrite: true, allowLocalPath: true });
	});

	test("unknown subdir errors clearly", async () => {
		await expect(
			installSkillFromGit({ url: repoDir, subdir: "nope", destRoot, overwrite: true, allowLocalPath: true }),
		).rejects.toThrow(/no SKILL.md under subdir/);
	});
});
