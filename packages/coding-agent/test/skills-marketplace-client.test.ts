import { describe, expect, it } from "bun:test";
import {
	marketEntryMatchesKeyword,
	normalizeSkillHubDetail,
	type SkillMarketEntry,
} from "../src/skills/marketplace-client";

// 市场关键词本地匹配契约：远端搜索接口只索引 id/英文，中文关键词（名/
// 中文描述）在服务端搜不到 —— querySkillMarket 的兜底路径（浏览 + 本地
// 过滤）靠这个谓词把「编程专家」这类词匹配到目录行上。

function entry(partial: Partial<SkillMarketEntry>): SkillMarketEntry {
	return {
		id: "skillhub:dev-expert",
		source: "skillhub",
		slug: "dev-expert",
		name: "dev-expert",
		description: "",
		...partial,
	};
}

describe("marketEntryMatchesKeyword", () => {
	it("matches a Chinese display name", () => {
		expect(marketEntryMatchesKeyword(entry({ name: "编程专家" }), "编程专家")).toBe(true);
	});

	it("matches a Chinese description when the name is English", () => {
		expect(marketEntryMatchesKeyword(entry({ descriptionZh: "资深编程专家，审查代码与架构" }), "编程专家")).toBe(
			true,
		);
	});

	it("matches the slug and English description case-insensitively", () => {
		expect(marketEntryMatchesKeyword(entry({ description: "Senior Dev Expert" }), "DEV-EXPERT")).toBe(true);
	});

	it("matches the author field", () => {
		expect(marketEntryMatchesKeyword(entry({ author: "MusePi Studio" }), "musepi")).toBe(true);
	});

	it("rejects entries that share no field with the keyword", () => {
		expect(marketEntryMatchesKeyword(entry({ name: "pdf-tools", slug: "pdf-tools" }), "编程专家")).toBe(false);
	});

	it("empty/whitespace keyword matches everything (browse pass-through)", () => {
		expect(marketEntryMatchesKeyword(entry({}), "")).toBe(true);
		expect(marketEntryMatchesKeyword(entry({}), "   ")).toBe(true);
	});
});

// SkillHub v1 详情报文归一化契约（用户实机回归 2026-09-27）：说明文本不在
// 顶层 description，而是嵌在 skill 对象里（summary / summary_zh，长正文在
// overviewMd）。归一化必须把 skill.summary* 提升到 detail.description*，
// 否则预览弹窗加载完成后永远拿不到 detail 描述。

describe("normalizeSkillHubDetail", () => {
	it("提升嵌套 skill.summary / summary_zh 到 description / descriptionZh", () => {
		const detail = normalizeSkillHubDetail(
			"dev-expert",
			{
				contentZhAvailable: false,
				latestVersion: { version: "2.0.1" },
				skill: { slug: "dev-expert", summary: "P8 编程助手", summary_zh: "P8 级编程助手", overviewMd: "" },
			},
			{ files: [{ path: "SKILL.md", size: 100 }] },
		);
		expect(detail.description).toBe("P8 编程助手");
		expect(detail.descriptionZh).toBe("P8 级编程助手");
		expect(detail.latestVersion).toBe("2.0.1");
		expect(detail.files).toEqual([{ path: "SKILL.md", size: 100 }]);
	});

	it("summary_zh 缺失时 descriptionZh 回落 summary（不丢描述）", () => {
		const detail = normalizeSkillHubDetail("dev-expert", { skill: { summary: "P8 编程助手" } }, { files: [] });
		expect(detail.description).toBe("P8 编程助手");
		expect(detail.descriptionZh).toBe("P8 编程助手");
	});

	it("顶层 description 存在时优先于嵌套 summary（向前兼容字段搬迁）", () => {
		const detail = normalizeSkillHubDetail(
			"dev-expert",
			{ description: "top-level", skill: { summary: "nested" } },
			{ files: [] },
		);
		expect(detail.description).toBe("top-level");
	});

	it("securityReports 归一化为 security 数组", () => {
		const detail = normalizeSkillHubDetail(
			"dev-expert",
			{
				skill: {},
				securityReports: { keen: { status: "benign", statusText: "安全，无风险", reportUrl: "https://r" } },
			},
			{ files: [] },
		);
		expect(detail.security).toEqual([{ status: "benign", statusText: "安全，无风险", reportUrl: "https://r" }]);
	});
});
