#!/usr/bin/env bun

import * as fs from "node:fs";
import * as path from "node:path";
import {
	countReleaseEntries,
	formatReleaseSummary,
	listReleaseSections,
	type ReleaseSection,
	sectionBlockRanges,
} from "./render-release-notes.ts";

const CHANGELOG_PATH = "packages/coding-agent/CHANGELOG.musepi.md";
const OUTPUT_PATH = "web/changelog.html";

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, character => {
		const entities: Record<string, string> = {
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			'"': "&quot;",
			"'": "&#39;",
		};
		return entities[character]!;
	});
}

function renderInline(text: string): string {
	const token = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\(https:\/\/[^)\s]+\))/g;
	let html = "";
	let offset = 0;
	for (const match of text.matchAll(token)) {
		const index = match.index;
		const value = match[0];
		html += escapeHtml(text.slice(offset, index));
		if (value.startsWith("`")) {
			html += `<code>${escapeHtml(value.slice(1, -1))}</code>`;
		} else if (value.startsWith("**")) {
			html += `<strong>${renderInline(value.slice(2, -2))}</strong>`;
		} else {
			const link = /^\[([^\]]+)\]\((https:\/\/[^)\s]+)\)$/.exec(value)!;
			html += `<a href="${escapeHtml(link[2]!)}" target="_blank" rel="noopener">${renderInline(link[1]!)}</a>`;
		}
		offset = index + value.length;
	}
	return html + escapeHtml(text.slice(offset));
}

function renderLanguages(chinese: string[], english: string[]): string {
	const zh =
		chinese.length > 0 ? `<span class="mp-changelog-zh">${chinese.map(renderInline).join("<br>")}</span>` : "";
	const en =
		english.length > 0
			? `<span class="mp-changelog-translation" lang="en">${english.map(renderInline).join("<br>")}</span>`
			: "";
	return zh + en;
}

function renderEntry(block: string): string {
	const chinese: string[] = [];
	const english: string[] = [];
	block.split(/\r?\n/).forEach((line, index) => {
		const translation = /^\s+- EN:\s*(.*)$/.exec(line);
		if (translation) english.push(translation[1]!);
		else if (english.length > 0 && /^\s+/.test(line)) english.push(line.trim());
		else chinese.push((index === 0 ? line.replace(/^- /, "") : line).trim());
	});
	return renderLanguages(chinese.filter(Boolean), english.filter(Boolean));
}

const CATEGORY_NAMES: Record<string, { zh: string; en: string }> = {
	新功能: { zh: "新功能", en: "Added" },
	Added: { zh: "新功能", en: "Added" },
	改进: { zh: "改进", en: "Improved" },
	Changed: { zh: "改进", en: "Improved" },
	Improved: { zh: "改进", en: "Improved" },
	修复: { zh: "修复", en: "Fixed" },
	Fixed: { zh: "修复", en: "Fixed" },
};

function englishSummary(section: ReleaseSection): string {
	const counts = countReleaseEntries(section.body);
	const parts: string[] = [];
	if (counts.added > 0) parts.push(`${counts.added} new feature${counts.added === 1 ? "" : "s"}`);
	if (counts.improved > 0) parts.push(`${counts.improved} improvement${counts.improved === 1 ? "" : "s"}`);
	if (counts.fixed > 0) parts.push(`${counts.fixed} fix${counts.fixed === 1 ? "" : "es"}`);
	if (counts.uncategorized > 0)
		parts.push(`${counts.uncategorized} other change${counts.uncategorized === 1 ? "" : "s"}`);
	return parts.join(" · ") || "No user-visible changes";
}

function renderCategoryHeading(heading: string): string {
	const title = heading.replace(/^###\s+/, "").trim();
	const names = CATEGORY_NAMES[title] ?? { zh: title, en: title };
	return `<h3><span class="mp-changelog-zh">${renderInline(names.zh)}</span><span class="mp-changelog-en" lang="en">${renderInline(names.en)}</span></h3>`;
}

function renderSectionBody(body: string): string {
	const html: string[] = [];
	let listOpen = false;
	const closeList = (): void => {
		if (listOpen) html.push("</ul>");
		listOpen = false;
	};
	for (const block of sectionBlockRanges(body)) {
		const text = block.lines.join("\n");
		if (text.startsWith("### ")) {
			closeList();
			html.push(renderCategoryHeading(text));
		} else if (text.startsWith("- ")) {
			if (!listOpen) html.push('<ul class="mp-changelog-entries">');
			listOpen = true;
			for (const entry of text.split(/\r?\n(?=- )/)) html.push(`<li>${renderEntry(entry)}</li>`);
		} else {
			closeList();
			html.push(`<p>${renderEntry(text)}</p>`);
		}
	}
	closeList();
	return html.join("\n");
}

export function renderSiteChangelogSection(section: ReleaseSection, open: boolean): string {
	const id = `v${section.version.replaceAll(".", "-")}`;
	const date = section.date ? `<time datetime="${escapeHtml(section.date)}">${escapeHtml(section.date)}</time>` : "";
	return `<details class="mp-changelog-release" id="${id}"${open ? " open" : ""}>
  <summary>
    <span class="mp-changelog-version">v${escapeHtml(section.version)}</span>
    ${date}
    <span class="mp-changelog-count mp-changelog-zh">${escapeHtml(formatReleaseSummary(countReleaseEntries(section.body)))}</span>
    <span class="mp-changelog-count mp-changelog-en" lang="en">${escapeHtml(englishSummary(section))}</span>
  </summary>
  <div class="mp-changelog-body">
    ${renderSectionBody(section.body)}
    <a class="mp-arrow-link" href="https://github.com/MuseLinn/MusePi/releases/tag/v${escapeHtml(section.version)}" target="_blank" rel="noopener">
      <span class="mp-changelog-zh">查看此版本的发布与下载</span><span class="mp-changelog-en" lang="en">View this release and its downloads</span><span aria-hidden="true"> →</span>
    </a>
  </div>
</details>`;
}

export function renderSiteChangelog(changelog: string): string {
	const sections = listReleaseSections(changelog);
	const latest = sections[0]?.version ?? "";
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MusePi 更新日志</title>
  <meta name="description" content="MusePi 各版本的更新日志，按版本折叠，支持中英文阅读。">
  <meta name="theme-color" content="#0d0d0f">
  <meta name="color-scheme" content="dark">
  <link rel="icon" type="image/svg+xml" href="./assets/musepi-mark.svg">
  <link rel="stylesheet" href="./styles.css">
  <link rel="stylesheet" href="./changelog.css">
</head>
<body>
  <a class="mp-skip" href="#changelog-releases"><span class="mp-changelog-zh">跳到更新日志</span><span class="mp-changelog-en" lang="en">Skip to the changelog</span></a>
  <header class="mp-topbar is-scrolled">
    <div class="mp-topbar-inner">
      <a class="mp-brand" href="./index.html" aria-label="MusePi">
        <img class="mp-brand-mark" src="./assets/musepi-mark.svg" alt="" width="26" height="26">
        <span class="mp-brand-word">MusePi</span>
        <span class="mp-brand-ver">v${escapeHtml(latest)}</span>
      </a>
      <div class="mp-topbar-actions">
        <div class="mp-lang" role="group" aria-label="语言 / Language">
          <button class="mp-lang-opt is-active" type="button" data-lang="zh" lang="zh-CN" aria-pressed="true">中</button>
          <span class="mp-lang-sep" aria-hidden="true"></span>
          <button class="mp-lang-opt" type="button" data-lang="en" lang="en" aria-pressed="false">EN</button>
        </div>
        <a class="mp-btn mp-btn--soft mp-btn--sm" href="./index.html"><span class="mp-changelog-zh">返回首页</span><span class="mp-changelog-en" lang="en">Home</span></a>
      </div>
    </div>
  </header>
  <main class="mp-changelog-page" id="main">
    <div class="mp-container mp-container--narrow">
      <header class="mp-changelog-head">
        <p class="mp-kicker">MusePi · Releases</p>
        <h1><span class="mp-changelog-zh">更新日志</span><span class="mp-changelog-en" lang="en">Changelog</span></h1>
        <p><span class="mp-changelog-zh">最新版本默认展开，旧版本按需展开。所有正文仍可通过浏览器页内查找搜索。</span><span class="mp-changelog-en" lang="en">The latest release is open by default. Expand older releases as needed, or find their content with your browser's find-in-page search.</span></p>
        <div class="mp-changelog-toolbar">
          <button class="mp-btn mp-btn--soft mp-btn--sm" id="changelog-toggle-all" type="button" aria-expanded="false" aria-controls="changelog-releases" hidden>
            <span class="mp-changelog-expand"><span class="mp-changelog-zh">全部展开</span><span class="mp-changelog-en" lang="en">Expand all</span></span>
            <span class="mp-changelog-collapse"><span class="mp-changelog-zh">全部收起</span><span class="mp-changelog-en" lang="en">Collapse all</span></span>
          </button>
          <a class="mp-arrow-link" href="https://github.com/MuseLinn/MusePi/releases" target="_blank" rel="noopener"><span class="mp-changelog-zh">GitHub 发布与下载</span><span class="mp-changelog-en" lang="en">GitHub releases and downloads</span><span aria-hidden="true"> →</span></a>
        </div>
      </header>
      <section class="mp-changelog-releases" id="changelog-releases" aria-label="MusePi releases">
        ${sections.map(section => renderSiteChangelogSection(section, section === sections[0])).join("\n")}
      </section>
    </div>
  </main>
  <footer class="mp-changelog-footer">
    <span>© <span data-year>2026</span> MusePi · Apache-2.0</span>
    <a href="./index.html#download"><span class="mp-changelog-zh">下载 MusePi</span><span class="mp-changelog-en" lang="en">Download MusePi</span></a>
  </footer>
  <script src="./changelog.js" defer></script>
</body>
</html>
`;
}

if (import.meta.main) {
	const changelog = await Bun.file(CHANGELOG_PATH).text();
	const html = renderSiteChangelog(changelog);
	fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
	fs.writeFileSync(OUTPUT_PATH, html, "utf8");
	console.log(`[changelog] ${listReleaseSections(changelog).length} releases -> ${OUTPUT_PATH}`);
}
