import { afterEach, describe, expect, it } from "bun:test";
import {
	clearSkillMarketIcons,
	lookupSkillMarketIcon,
	marketEntryInstalled,
	rememberSkillMarketIcons,
} from "../src/lib/skill-market";

// 技能市场跨面板纯逻辑契约：
// - 已安装判定必须同时认市场条目的显示名与 slug（市场卡 name 是发布者填的
//   中文名，skills.list 落盘名来自 SKILL.md frontmatter，两者可能完全不同）；
// - 市场图标缓存必须按 name 与 slug 双键记录、按技能名回查，让「我安装的」
//   卡片沿用市场图标而不是灰色首字母块。

afterEach(() => {
	clearSkillMarketIcons();
});

describe("marketEntryInstalled", () => {
	it("matches by display name", () => {
		expect(marketEntryInstalled({ name: "Dev Expert", slug: "dev-expert" }, new Set(["dev expert"]))).toBe(true);
	});

	it("matches by slug when the display name is Chinese but the installed name is the slug", () => {
		// 用户实机案例：市场卡「编程专家」装完后 skills.list 里叫 dev-expert。
		expect(marketEntryInstalled({ name: "编程专家", slug: "dev-expert" }, new Set(["dev-expert"]))).toBe(true);
	});

	it("normalizes entry-side casing against the pre-lowered installed set", () => {
		// installedNames 在组装时已全小写（refreshInstalled），条目侧大小写不敏感。
		expect(marketEntryInstalled({ name: "Dev Expert", slug: "Dev-Expert" }, new Set(["dev-expert"]))).toBe(true);
	});

	it("does not match an unrelated entry", () => {
		expect(marketEntryInstalled({ name: "编程专家", slug: "dev-expert" }, new Set(["other-skill"]))).toBe(false);
	});

	it("ignores empty installed-name noise", () => {
		expect(marketEntryInstalled({ name: "x", slug: "x" }, new Set([""]))).toBe(false);
	});
});

describe("skill market icon cache", () => {
	it("records iconUrl under both name and slug, retrievable by installed skill name", () => {
		rememberSkillMarketIcons([{ name: "编程专家", slug: "dev-expert", iconUrl: "https://cdn.example/icon.png" }]);
		expect(lookupSkillMarketIcon("dev-expert")).toBe("https://cdn.example/icon.png");
	});

	it("is case-insensitive on lookup", () => {
		rememberSkillMarketIcons([{ name: "Dev Expert", slug: "dev-expert", iconUrl: "https://cdn.example/i.png" }]);
		expect(lookupSkillMarketIcon("Dev-Expert")).toBe("https://cdn.example/i.png");
	});

	it("skips entries without an iconUrl", () => {
		rememberSkillMarketIcons([{ name: "no-icon", slug: "no-icon" }]);
		expect(lookupSkillMarketIcon("no-icon")).toBeUndefined();
	});

	it("later remembers overwrite earlier icons for the same key", () => {
		rememberSkillMarketIcons([{ name: "a", slug: "a", iconUrl: "https://cdn.example/old.png" }]);
		rememberSkillMarketIcons([{ name: "a", slug: "a", iconUrl: "https://cdn.example/new.png" }]);
		expect(lookupSkillMarketIcon("a")).toBe("https://cdn.example/new.png");
	});
});
