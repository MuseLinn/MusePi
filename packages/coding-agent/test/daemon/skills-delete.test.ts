import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { getAgentDir, setAgentDir } from "@musepi/pi-utils/dirs";
import {
	MarketplaceService,
	resolveSkillDeleteTarget,
	type SkillListItem,
	skillDeleteBlockReason,
} from "../../src/daemon/services/marketplace-service";

function skill(partial: Partial<SkillListItem> & Pick<SkillListItem, "name">): SkillListItem {
	return {
		description: "",
		filePath: "/home/u/.musepi/agent/skills/x/SKILL.md",
		source: "native",
		hide: false,
		...partial,
	};
}

describe("skillDeleteBlockReason", () => {
	test("用户安装的技能（native provider + user 级）可卸载", () => {
		// 回归：guard 曾按 provider === "native" 整拒，但 bundled 与用户安装的
		// 技能同目录同 provider，能力中心里点卸载永远报 only user-level。
		const s = skill({
			name: "dev-expert",
			_source: { provider: "native", providerName: "native", path: "", level: "user" },
		});
		expect(skillDeleteBlockReason(s)).toBeNull();
	});

	test("bundled 技能（同名内置清单）拒绝卸载", () => {
		const s = skill({
			name: "musepi-help",
			_source: { provider: "native", providerName: "native", path: "", level: "user" },
		});
		expect(skillDeleteBlockReason(s)).toBe("bundled skills ship with the client and cannot be uninstalled");
	});

	test("项目级 / managed / 扩展虚拟技能拒绝卸载", () => {
		const project = skill({
			name: "proj-skill",
			_source: { provider: "native", providerName: "native", path: "", level: "project" },
		});
		const managed = skill({
			name: "learned",
			_source: { provider: "musepi-managed", providerName: "managed", path: "", level: "user" },
		});
		const virtual = skill({
			name: "ext-skill",
			filePath: "",
			_source: { provider: "extension", providerName: "ext", path: "", level: "user" },
		});
		for (const s of [project, managed, virtual]) {
			expect(skillDeleteBlockReason(s)).toBe("only user-level file skills can be deleted");
		}
	});
});

describe("resolveSkillDeleteTarget", () => {
	const root = path.join("home", "u", ".musepi", "agent", "skills");

	test("直接挂在 user skills 根下的技能整目录删除（连脚本与资源）", () => {
		const fp = path.join(root, "dev-expert", "SKILL.md");
		expect(resolveSkillDeleteTarget(fp, root)).toBe(path.join(root, "dev-expert"));
	});

	test("skills 根本身的 SKILL.md 只删文件——绝不整目录 nuked 根", () => {
		const fp = path.join(root, "SKILL.md");
		expect(resolveSkillDeleteTarget(fp, root)).toBe(fp);
	});

	test("包内技能（非 user skills 根直下）只删 SKILL.md", () => {
		const fp = path.join("cache", "plugins", "pkg", "skills", "foo", "SKILL.md");
		expect(resolveSkillDeleteTarget(fp, root)).toBe(fp);
	});
});

describe("skills.delete 缓存失效", () => {
	const originalAgentDir = getAgentDir();
	afterEach(() => setAgentDir(originalAgentDir));

	test("删除后紧跟的 skills.list 不再返回已删技能（穿透 loadCapability 5s TTL 缓存）", async () => {
		// 回归：deleteSkill 自带的 getSkills 会把 loadCapability 扫描缓存刷到最新，
		// 若删除后不清这层缓存，GUI 确认卸载后的立即重拉拿到的是含已删技能的
		// 陈旧清单——能力中心里"卸载了但卡片还在"。
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-skills-delete-"));
		try {
			setAgentDir(agentDir);
			const skillDir = path.join(agentDir, "skills", "delete-freshness-probe");
			await fs.mkdir(skillDir, { recursive: true });
			await Bun.write(
				path.join(skillDir, "SKILL.md"),
				"---\nname: delete-freshness-probe\ndescription: probe\n---\n\n# probe\n",
			);
			const service = new MarketplaceService({
				cwd: () => agentDir,
				settings: () => Settings.isolated(),
				extensionEntries: async () => [],
				invalidateExtensionsCache: () => {},
				invalidatePluginCaches: () => {},
				onChanged: () => {},
				onInstallState: () => {},
			});

			const before = await service.getSkills();
			expect(before.some(s => s.name === "delete-freshness-probe")).toBe(true);

			await service.deleteSkill({ name: "delete-freshness-probe" });

			const after = await service.getSkills();
			expect(after.some(s => s.name === "delete-freshness-probe")).toBe(false);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});
});
