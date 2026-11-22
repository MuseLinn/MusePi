#!/usr/bin/env bun

/**
 * Guard the shape of `CHANGELOG.musepi.md`: the bilingual (Chinese + English)
 * pairing of released entries, and the line structure of `[Unreleased]`.
 *
 * Why this exists: that one file is the single source for the GUI "what's-new"
 * panel, `/changelog`, the OTA `update-manifest.json` notes and the GitHub
 * release page body — every consumer slices the section verbatim. A Chinese
 * bullet without its `- EN:` child therefore ships a half-Chinese release page,
 * which is exactly what happened to 0.4.29 and 0.4.30 before this check.
 *
 * The structure half exists because a deleted bullet *title* is invisible to a
 * bullet-shaped check: the body became an untitled paragraph, the bullet count
 * fell by one, and every surface rendered a bare paragraph in Chinese under an
 * English page. `scripts/render-release-notes.ts` only counts blocks that start
 * with `- `, so the page keeps such a block and the count loses it — the guard
 * runs that same block split rather than a second parser that could drift.
 *
 * Contract (see `.agents/rules/release.md` → "Changelog ownership"):
 *   - every `- ` bullet under a released version gets exactly one nested
 *     `  - EN: ...` child, directly beneath it;
 *   - the child must be the translation of the whole bullet (a multi-line
 *     Chinese bullet still gets a single EN child);
 *   - in `[Unreleased]`, every non-blank line is a category heading, a bullet,
 *     an indented child of one, or a bullet's own continuation. A paragraph
 *     that opens without a bullet is an orphan and fails with its line number.
 *
 * Exit 0 when compliant (or when there is nothing to check), exit 1 with a
 * per-line report otherwise.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isEntryBlock, sectionBlockRanges } from "./render-release-notes.ts";

const CHANGELOG_PATH = "packages/coding-agent/CHANGELOG.musepi.md";

/** A `## [x.y.z] - date` heading (released versions — `[Unreleased]` is judged by structure only). */
const VERSION_HEADING = /^## \[(\d+\.\d+\.\d+)\]/;
/** One `### Category` heading; the only heading `[Unreleased]` may carry. */
const SECTION_HEADING = /^### /;
/** A line indented under the bullet above it: the EN child or a wrapped body. */
const INDENTED = /^\s+\S/;

interface Problem {
	/** 1-based line number of the offending line (or the file header). */
	line: number;
	version: string;
	message: string;
}

export interface CheckResult {
	/** Bullets that were checked: released bullets, plus every `[Unreleased]` bullet. */
	checked: number;
	problems: Problem[];
}

/** `- ` at column 0 opens a bullet; anything more indented is a child line. */
const TOP_BULLET = /^- /;
/** The nested translation child — `  - EN: ` with optional extra indent. */
const EN_CHILD = /^\s+- EN: /;
/** Any `## [` heading — used to tell "mid-cycle, [Unreleased] only" from a malformed file. */
const ANY_RELEASE_HEADING = /^## \[/;
/** `## [Unreleased]` — the section whose line structure is also judged. */
const UNRELEASED_HEADING = /^## \[Unreleased\]/;

/** True when the file actually declares a version section (even an unparseable one). */
function hasReleasedHeading(content: string): boolean {
	return content.split(/\r?\n/).some(line => ANY_RELEASE_HEADING.test(line) && !/^## \[Unreleased\]/.test(line));
}

/**
 * The `[Unreleased]` section's lines, with the 1-based file line of the first
 * one. Null when the file has no such section.
 */
function unreleasedLines(lines: readonly string[]): { firstLine: number; lines: string[] } | null {
	const start = lines.findIndex(line => UNRELEASED_HEADING.test(line));
	if (start < 0) return null;
	const rest = lines.slice(start + 1);
	const end = rest.findIndex(line => ANY_RELEASE_HEADING.test(line));
	return { firstLine: start + 2, lines: end < 0 ? rest : rest.slice(0, end) };
}

/**
 * Judge `[Unreleased]` by the release renderer's own rule: a blank-line-
 * separated block is either a category heading or an entry, and inside an entry
 * every line is the bullet, a heading, or an indented continuation of it.
 */
function checkUnreleasedStructure(section: { firstLine: number; lines: string[] }, problems: Problem[]): number {
	let bullets = 0;
	for (const block of sectionBlockRanges(section.lines.join("\n"))) {
		const line = section.firstLine + block.line - 1;
		const head = block.lines[0] ?? "";
		if (!SECTION_HEADING.test(head) && !isEntryBlock(head)) {
			problems.push({
				line,
				version: "Unreleased",
				message:
					`orphan paragraph — an entry starts with \`- \`, so this block renders as an untitled paragraph ` +
					`and drops out of the entry count`,
			});
			continue;
		}
		let inBullet = false;
		for (const [offset, text] of block.lines.entries()) {
			if (TOP_BULLET.test(text)) {
				inBullet = true;
				bullets++;
				continue;
			}
			if (SECTION_HEADING.test(text)) {
				inBullet = false;
				continue;
			}
			if (inBullet && INDENTED.test(text)) continue;
			problems.push({
				line: line + offset,
				version: "Unreleased",
				message: `orphan line — not a category heading, a \`- \` bullet, or an indented child of one`,
			});
		}
	}
	return bullets;
}

export function checkChangelogI18n(content: string): CheckResult {
	const lines = content.split(/\r?\n/);
	const problems: Problem[] = [];
	let checked = 0;

	let version: string | null = null;
	let sawVersion = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const heading = VERSION_HEADING.exec(line);
		if (heading) {
			version = heading[1] ?? null;
			sawVersion = true;
			continue;
		}
		if (!version) continue;
		// A section heading ("### Added") stays inside the same version.
		if (SECTION_HEADING.test(line)) continue;
		if (!TOP_BULLET.test(line)) continue;

		// Top-level bullet: scan its indented continuation lines (a bullet may
		// wrap, and so may its EN child) for the translation marker.
		checked++;
		const enHits: number[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			const next = lines[j] ?? "";
			// End of this bullet: a new top-level bullet or any heading.
			if (TOP_BULLET.test(next) || next.startsWith("#")) break;
			if (EN_CHILD.test(next)) enHits.push(j);
		}

		if (enHits.length === 0) {
			problems.push({ line: i + 1, version, message: "no `- EN:` child" });
		} else if (enHits.length > 1) {
			problems.push({ line: i + 1, version, message: `${enHits.length} \`- EN:\` children (expected 1)` });
		}
	}

	const unreleased = unreleasedLines(lines);
	if (unreleased) checked += checkUnreleasedStructure(unreleased, problems);

	if (!sawVersion && hasReleasedHeading(content)) {
		// A version heading exists but carried no parseable x.y.z prefix.
		problems.push({ line: 1, version: "-", message: "no parseable `## [x.y.z]` version section found" });
	}

	return { checked, problems };
}

function main(): number {
	const argv = process.argv.slice(2);
	const quiet = argv.includes("--quiet");
	const target = argv.find(a => !a.startsWith("--")) ?? CHANGELOG_PATH;
	const file = path.resolve(target);

	if (!fs.existsSync(file)) {
		console.error(`check-changelog-i18n: missing file: ${file}`);
		return 1;
	}

	const result = checkChangelogI18n(fs.readFileSync(file, "utf8"));

	if (result.problems.length === 0) {
		if (!quiet) {
			console.log(`check-changelog-i18n: OK — ${result.checked} bullet(s) carry a nested EN translation.`);
		}
		return 0;
	}

	console.error(`check-changelog-i18n: ${result.problems.length} problem(s) in ${path.relative(process.cwd(), file)}`);
	for (const p of result.problems) {
		console.error(`  ${path.relative(process.cwd(), file)}:${p.line}  [${p.version}]  ${p.message}`);
	}
	console.error("");
	console.error("Every bullet in a released section needs its translation as a nested child line:");
	console.error("  - 中文条目。");
	console.error("    - EN: The same entry in English.");
	console.error(
		"In [Unreleased], every line is a `###` category heading, a `- ` bullet, or an indented child of one.",
	);
	console.error('See .agents/rules/release.md → "Changelog ownership".');
	return 1;
}

if (import.meta.main) {
	process.exit(main());
}
