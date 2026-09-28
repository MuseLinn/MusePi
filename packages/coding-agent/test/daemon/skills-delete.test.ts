import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
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
