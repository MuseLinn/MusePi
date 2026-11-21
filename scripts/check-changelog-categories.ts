#!/usr/bin/env bun

/**
 * Guard the category structure of the `[Unreleased]` changelog section.
 *
 * Why this exists: the GitHub release page and the OTA update notes present
 * the newest changelog section as their only structure. A flat list leaves a
 * reader unable to tell a new feature from a fix, which is the report that
 * produced this guard. Every unreleased entry therefore files under exactly
 * one of `### 新功能`, `### 改进` and `### 修复`, and the heading must come
 * before its entries.
 *
 * Scope: `[Unreleased]` only. Released sections are immutable, so judging
 * shipped history here would fail every build for no benefit; the gate stops
 * the next release from shipping a flat section instead. `release.ts` renames
 * the section in place, so a compliant `[Unreleased]` becomes a compliant
 * release section with its categories intact.
 *
 * Titles are unique inside the section: a merge can leave the same entry
 * under two categories, and every release surface renders each bullet, so
 * the reader would see the change twice. Only top-level bullets participate;
 * the nested `- EN:` line and continuation lines belong to their parent.
 *
 * Exit 0 when compliant (or when `[Unreleased]` has no entries), exit 1 with
 * a per-bullet report otherwise.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const CHANGELOG_PATH = "packages/coding-agent/CHANGELOG.musepi.md";

/** The only category headings `[Unreleased]` accepts, in documentation order. */
export const CHANGELOG_CATEGORIES = ["新功能", "改进", "修复"] as const;
export type ChangelogCategory = (typeof CHANGELOG_CATEGORIES)[number];

/** `## [Unreleased]` — the only section this gate judges. */
const UNRELEASED_HEADING = /^## \[Unreleased\]/;
/** Any `## [` heading — closes the `[Unreleased]` section. */
const ANY_RELEASE_HEADING = /^## \[/;
const SECTION_HEADING = /^###\s+(.+?)\s*$/;
/** `- ` at column 0 opens a bullet; the indented `- EN:` child never matches. */
const TOP_BULLET = /^- /;
/** The bold span that becomes the release-notes card title: `- **title**：…`. */
const BOLD_TITLE = /^\*\*([^*]+)\*\*/;

export interface CategoryProblem {
	/** 1-based line number of the offending bullet or heading. */
	line: number;
	message: string;
}

export interface CategoryCheckResult {
	/** Top-level bullets in `[Unreleased]`. */
	checked: number;
	/** Entries filed under each category. */
	counts: Record<ChangelogCategory, number>;
	problems: CategoryProblem[];
}

function isCategory(title: string): title is ChangelogCategory {
	return (CHANGELOG_CATEGORIES as readonly string[]).includes(title);
}

function emptyCounts(): Record<ChangelogCategory, number> {
	return { 新功能: 0, 改进: 0, 修复: 0 };
}

/** The bullet's title: its bold span, or the whole line when it has none. */
function entryTitle(line: string): string {
	const text = line.slice(TOP_BULLET.exec(line)?.[0].length ?? 2).trim();
	return (BOLD_TITLE.exec(text)?.[1] ?? text).trim();
}

/** Case- and spacing-insensitive identity, so a reflowed or re-cased copy
 *  still counts as the same title. */
function titleKey(title: string): string {
	return title
		.replace(/[\s\u3000]+/g, " ")
		.replace(/[：:]$/, "")
		.trim()
		.toLowerCase();
}

export function checkChangelogCategories(content: string): CategoryCheckResult {
	const lines = content.split(/\r?\n/);
	const problems: CategoryProblem[] = [];
	const counts = emptyCounts();
	let checked = 0;
	let inUnreleased = false;
	let category: ChangelogCategory | null = null;
	/** First sighting of each title inside `[Unreleased]`, keyed by its normalized form. */
	const seenTitles = new Map<string, { line: number }>();

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (UNRELEASED_HEADING.test(line)) {
			inUnreleased = true;
			category = null;
			continue;
		}
		// Any other release heading closes the section.
		if (ANY_RELEASE_HEADING.test(line)) {
			inUnreleased = false;
			continue;
		}
		if (!inUnreleased) continue;

		const heading = SECTION_HEADING.exec(line);
		if (heading) {
			const title = heading[1] ?? "";
			if (isCategory(title)) {
				category = title;
			} else {
				problems.push({
					line: i + 1,
					message: `unknown category \`### ${title}\` — use ${CHANGELOG_CATEGORIES.map(c => `\`### ${c}\``).join(" / ")}`,
				});
				category = null;
			}
			continue;
		}

		if (!TOP_BULLET.test(line)) continue;
		checked++;
		const title = entryTitle(line);
		const key = titleKey(title);
		if (key !== "") {
			const first = seenTitles.get(key);
			if (first) {
				problems.push({
					line: i + 1,
					message: `duplicate entry title \`${title}\` — already listed at line ${first.line}`,
				});
			} else {
				seenTitles.set(key, { line: i + 1 });
			}
		}
		if (category === null) {
			problems.push({
				line: i + 1,
				message: `entry is not under ${CHANGELOG_CATEGORIES.map(c => `\`### ${c}\``).join(" / ")}`,
			});
			continue;
		}
		counts[category]++;
	}

	return { checked, counts, problems };
}

function main(): number {
	const argv = process.argv.slice(2);
	const quiet = argv.includes("--quiet");
	const target = argv.find(a => !a.startsWith("--")) ?? CHANGELOG_PATH;
	const file = path.resolve(target);

	if (!fs.existsSync(file)) {
		console.error(`check-changelog-categories: missing file: ${file}`);
		return 1;
	}

	const result = checkChangelogCategories(fs.readFileSync(file, "utf8"));

	if (result.problems.length === 0) {
		if (!quiet) {
			const breakdown = CHANGELOG_CATEGORIES.map(c => `${c} ${result.counts[c]}`).join(" · ");
			console.log(
				result.checked > 0
					? `check-changelog-categories: OK — ${result.checked} [Unreleased] entr${result.checked === 1 ? "y" : "ies"} categorized (${breakdown}).`
					: "check-changelog-categories: OK — [Unreleased] has no entries to categorize.",
			);
		}
		return 0;
	}

	const rel = path.relative(process.cwd(), file);
	console.error(`check-changelog-categories: ${result.problems.length} problem(s) in ${rel}`);
	for (const p of result.problems) {
		console.error(`  ${rel}:${p.line}  ${p.message}`);
	}
	console.error("");
	console.error("Every [Unreleased] title appears once, under one category, with the heading above it:");
	console.error("  ### 新功能");
	console.error("  ### 改进");
	console.error("  ### 修复");
	console.error('See .agents/rules/release.md → "Changelog ownership".');
	return 1;
}

if (import.meta.main) {
	process.exit(main());
}
