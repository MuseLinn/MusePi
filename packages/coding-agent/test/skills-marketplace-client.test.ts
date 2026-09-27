import { describe, expect, it } from "bun:test";
import { marketEntryMatchesKeyword, type SkillMarketEntry } from "../src/skills/marketplace-client";

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
