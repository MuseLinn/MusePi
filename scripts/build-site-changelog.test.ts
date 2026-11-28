import { describe, expect, test } from "bun:test";
import { renderSiteChangelog, renderSiteChangelogSection } from "./build-site-changelog.ts";
import { countReleaseEntries, listReleaseSections } from "./render-release-notes.ts";

const CHANGELOG = [
	"# MusePi Changelog",
	"",
	"## [Unreleased]",
	"",
	"- 不发布的条目。",
	"  - EN: Unreleased entry.",
	"",
	"## [1.2.0] - 2026-11-28",
	"",
	"### 新功能",
	"",
	"- **透明 <输入框>**：使用 `details`，并查看 [发布页](https://github.com/MuseLinn/MusePi/releases/tag/v1.2.0)。",
	"  - EN: **Transparent <composer>** with `details` and a [release](https://github.com/MuseLinn/MusePi/releases/tag/v1.2.0).",
	"",
	"## [1.1.0] - 2026-10-01",
	"",
	"### Fixed",
	"",
	"- 旧版本修复。",
	"  - EN: Older release fix.",
	"",
].join("\n");

describe("renderSiteChangelog", () => {
	test("opens only the latest release and keeps every release independently expandable", () => {
		const html = renderSiteChangelog(CHANGELOG);
		expect((html.match(/<details class="mp-changelog-release"/g) ?? []).length).toBe(2);
		expect(html).toContain('<details class="mp-changelog-release" id="v1-2-0" open>');
		expect(html).toContain('<details class="mp-changelog-release" id="v1-1-0">');
		expect(html).not.toContain("不发布的条目");
		expect(html).toContain('id="changelog-toggle-all"');
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain('aria-controls="changelog-releases"');
	});

	test("renders trusted Markdown formatting without interpreting source HTML", () => {
		const html = renderSiteChangelog(CHANGELOG);
		expect(html).toContain("<strong>透明 &lt;输入框&gt;</strong>");
		expect(html).toContain("<code>details</code>");
		expect(html).toContain(
			'<a href="https://github.com/MuseLinn/MusePi/releases/tag/v1.2.0" target="_blank" rel="noopener">发布页</a>',
		);
		expect(html).not.toContain("<输入框>");
		expect(html).toContain('<span class="mp-changelog-translation" lang="en">');
		expect(html).not.toContain("<h3><summary>");
	});

	test("summarizes one release from the shared release parser", () => {
		const section = listReleaseSections(CHANGELOG)[0]!;
		const html = renderSiteChangelogSection(section, true);
		expect(html).toContain("<summary>");
		expect(html).toContain("v1.2.0");
		expect(html).toContain('<time datetime="2026-11-28">2026-11-28</time>');
		expect(html).toContain("1 项新功能");
		expect(html).toContain("1 new feature");
	});

	test("splits adjacent entries and keeps wrapped English out of the Chinese text", () => {
		const html = renderSiteChangelogSection(
			{
				version: "1.2.0",
				date: "2026-11-28",
				body: "- 第一条。\n  - EN: First entry\n    continued in English.\n- 第二条。\n  - EN: Second entry.",
			},
			true,
		);
		expect((html.match(/<li>/g) ?? []).length).toBe(2);
		expect(html).toContain("First entry<br>continued in English.");
		expect(html).toContain('<span class="mp-changelog-zh">第一条。</span>');
		expect(html).toContain('<span class="mp-changelog-zh">第二条。</span>');
	});

	test("renders the real changelog without dropping released sections", async () => {
		const changelog = await Bun.file("packages/coding-agent/CHANGELOG.musepi.md").text();
		const sections = listReleaseSections(changelog);
		const html = renderSiteChangelog(changelog);
		expect(sections.length).toBeGreaterThan(1);
		expect((html.match(/<details class="mp-changelog-release"/g) ?? []).length).toBe(sections.length);
		const expectedEntries = sections.reduce((total, section) => total + countReleaseEntries(section.body).total, 0);
		expect((html.match(/<li>/g) ?? []).length).toBe(expectedEntries);
		expect(html).toContain(`id="v${sections[0]!.version.replaceAll(".", "-")}" open`);
	});

	test("builds the changelog during Pages deployment and links it from the landing page", async () => {
		const workflow = await Bun.file(".github/workflows/pages.yml").text();
		const landing = await Bun.file("web/index.html").text();
		const sitemap = await Bun.file("scripts/build-site-sitemap.ts").text();
		expect(workflow).toContain("bun scripts/build-site-changelog.ts");
		expect(landing).not.toContain(
			'href="https://github.com/MuseLinn/MusePi/blob/main/packages/coding-agent/CHANGELOG.musepi.md"',
		);
		expect(landing).toContain('href="./changelog.html"');
		expect(sitemap).toContain("/changelog.html");
	});
});
