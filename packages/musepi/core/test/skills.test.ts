// MusePi core — skills 七 scope scanner 测试。
// 覆盖：scope 布局（.musepi host 覆盖，不用 .pi）、优先级顺序、
// listCompatSkillDirs（pi 自身不扫的目录）、kimiCodeCompat 开关、
// loadSkillsForCwd 跨 scope 去重（project 胜 user，首个 loader 胜出）。
import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	clearSkillsCache,
	listCompatSkillDirs,
	listSkillRootDirs,
	loadSkillsForCwd,
	type SkillScope,
} from "../src/skills/index.ts";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "musepi-skills-"));
	dirs.push(dir);
	return dir;
}
after(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Fork host layout: .musepi dirs, explicit home/agent/kimi roots. */
function forkScope(root: string): { scope: SkillScope; home: string; projectRoot: string; agentDir: string; kimiHome: string } {
	const home = join(root, "home");
	const projectRoot = join(root, "project");
	const agentDir = join(home, ".musepi", "agent");
	const kimiHome = join(home, ".kimi-code");
	mkdirSync(projectRoot, { recursive: true });
	return {
		scope: { projectRoot, homeDir: home, agentDir, hostDirName: ".musepi", kimiHome },
		home,
		projectRoot,
		agentDir,
		kimiHome,
	};
}

function writeSkill(dir: string, name: string, description = `${name} skill`): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "SKILL.md");
	writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
	clearSkillsCache();
	return file;
}

describe("skills scanner — seven-scope layout", () => {
	it("lists all seven scopes in priority order under the fork host layout", () => {
		const root = tempDir();
		const { scope, home, projectRoot, agentDir, kimiHome } = forkScope(root);
		const dirs = listSkillRootDirs(projectRoot, scope).map((r) => r.dir);
		assert.deepEqual(dirs, [
			join(projectRoot, ".musepi", "skills"),
			join(projectRoot, ".kimi-code", "skills"),
			join(projectRoot, ".agents", "skills"),
			join(agentDir, "skills"),
			join(home, ".musepi", "skills"),
			join(kimiHome, "skills"),
			join(home, ".agents", "skills"),
		]);
		// .musepi 独立 home：任何 scope 都不得落在 .pi 下
		assert.ok(dirs.every((d) => !d.includes(`${join("", ".pi")}`)), "no .pi segments");
	});

	it("defaults to pi conventions when no scope is given", () => {
		const home = tempDir();
		const prevHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const dirs = listSkillRootDirs(tempDir()).map((r) => r.dir);
			assert.ok(dirs.some((d) => d.includes(".pi")), "pi-native default kept for other hosts");
		} finally {
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
		}
	});
});

describe("skills scanner — listCompatSkillDirs", () => {
	it("returns exactly the dirs pi's package-manager does not scan", () => {
		const root = tempDir();
		const { scope, home, projectRoot, kimiHome } = forkScope(root);
		const compat = listCompatSkillDirs(projectRoot, scope);
		assert.deepEqual(
			compat.map((d) => ({ dir: d.dir, source: d.source })),
			[
				{ dir: join(projectRoot, ".kimi-code", "skills"), source: "project" },
				{ dir: join(home, ".musepi", "skills"), source: "user" },
				{ dir: join(kimiHome, "skills"), source: "user" },
			],
		);
	});

	it("kimiCodeCompat=false keeps only the host top-level user dir", () => {
		const root = tempDir();
		const { scope, home, projectRoot } = forkScope(root);
		const compat = listCompatSkillDirs(projectRoot, scope, { kimiCodeCompat: false });
		assert.deepEqual(
			compat.map((d) => d.dir),
			[join(home, ".musepi", "skills")],
		);
	});
});

describe("skills scanner — loadSkillsForCwd", () => {
	it("dedupes by name across scopes: project wins over user, first loader wins", () => {
		const root = tempDir();
		const { scope, home, projectRoot, agentDir } = forkScope(root);
		writeSkill(join(projectRoot, ".musepi", "skills", "shared"), "shared", "project version");
		writeSkill(join(agentDir, "skills", "shared"), "shared", "user version");
		writeSkill(join(home, ".musepi", "skills", "host-top"), "host-top");

		const result = loadSkillsForCwd(projectRoot, { scope });
		const shared = result.skills.filter((s) => s.name === "shared");
		assert.equal(shared.length, 1);
		assert.equal(shared[0].description, "project version");
		assert.equal(shared[0].sourceInfo.source, "project");
		assert.ok(result.skills.some((s) => s.name === "host-top"));
		assert.ok(
			result.diagnostics.some((d) => d.type === "collision" && d.collision?.name === "shared"),
			"loser surfaces a collision diagnostic",
		);
	});

	it("loads flat .md skills and directory-form skills", () => {
		const root = tempDir();
		const { scope, projectRoot } = forkScope(root);
		const flatDir = join(projectRoot, ".musepi", "skills");
		mkdirSync(flatDir, { recursive: true });
		writeFileSync(join(flatDir, "flat-one.md"), "---\ndescription: flat\n---\n");
		writeSkill(join(flatDir, "dir-form"), "dir-form");
		clearSkillsCache();

		const result = loadSkillsForCwd(projectRoot, { scope });
		assert.ok(result.skills.some((s) => s.name === "flat-one"));
		assert.ok(result.skills.some((s) => s.name === "dir-form"));
	});

	it("kimiCodeCompat=false excludes both Kimi Code compat dirs", () => {
		const root = tempDir();
		const { scope, home, projectRoot, kimiHome } = forkScope(root);
		writeSkill(join(projectRoot, ".kimi-code", "skills", "kimi-project"), "kimi-project");
		writeSkill(join(kimiHome, "skills", "kimi-user"), "kimi-user");
		writeSkill(join(home, ".musepi", "skills", "host-top"), "host-top");

		const on = loadSkillsForCwd(projectRoot, { scope });
		assert.ok(on.skills.some((s) => s.name === "kimi-project"));
		assert.ok(on.skills.some((s) => s.name === "kimi-user"));

		const off = loadSkillsForCwd(projectRoot, { scope, kimiCodeCompat: false });
		assert.ok(!off.skills.some((s) => s.name === "kimi-project"));
		assert.ok(!off.skills.some((s) => s.name === "kimi-user"));
		assert.ok(off.skills.some((s) => s.name === "host-top"), "host top-level dir is not kimi compat");
	});

	it("falls back to pi defaults without a scope (subagent back-compat)", () => {
		const home = tempDir();
		const prevHome = process.env.HOME;
		process.env.HOME = home;
		try {
			writeSkill(join(home, ".pi", "agent", "skills", "legacy"), "legacy");
			const result = loadSkillsForCwd(tempDir());
			assert.ok(result.skills.some((s) => s.name === "legacy"));
		} finally {
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
		}
	});
});
