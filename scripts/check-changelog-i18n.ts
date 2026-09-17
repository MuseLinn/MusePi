#!/usr/bin/env bun

/**
 * Guard the bilingual (Chinese + English) shape of `CHANGELOG.musepi.md`.
 *
 * Why this exists: that one file is the single source for the GUI "what's-new"
 * panel, `/changelog`, the OTA `update-manifest.json` notes and the GitHub
 * release page body — every consumer slices the section verbatim. A Chinese
 * bullet without its `- EN:` child therefore ships a half-Chinese release page,
 * which is exactly what happened to 0.4.29 and 0.4.30 before this check.
 *
 * Contract (see AGENTS.md → Changelog → "Bilingual entries"):
 *   - every `- ` bullet under a released version gets exactly one nested
 *     `  - EN: ...` child, directly beneath it;
 *   - the child must be the translation of the whole bullet (a multi-line
 *     Chinese bullet still gets a single EN child);
 *   - the upstream `CHANGELOG.md` files stay English-only and are not checked.
 *
 * Exit 0 when compliant (or when there is nothing to check), exit 1 with a
 * per-bullet report otherwise.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const CHANGELOG_PATH = "packages/coding-agent/CHANGELOG.musepi.md";

/** A `## [x.y.z] - date` heading (released versions only — `[Unreleased]` is exempt). */
const VERSION_HEADING = /^## \[(\d+\.\d+\.\d+)\]/;
const SECTION_HEADING = /^### /;
const BULLET = /^(\s*)- /;

interface Problem {
	/** 1-based line number of the offending bullet (or the file header). */
	line: number;
	version: string;
	message: string;
}

export interface CheckResult {
	/** Bullets that were checked, i.e. top-level bullets in released sections. */
	checked: number;
	problems: Problem[];
}

/** `- ` at column 0 opens a bullet; anything more indented is a child line. */
const TOP_BULLET = /^- /;
/** The nested translation child — `  - EN: ` with optional extra indent. */
const EN_CHILD = /^\s+- EN: /;
/** Any `## [` heading — used to tell "mid-cycle, [Unreleased] only" from a malformed file. */
const ANY_RELEASE_HEADING = /^## \[/;

/** True when the file actually declares a version section (even an unparseable one). */
function hasReleasedHeading(content: string): boolean {
	return content.split(/\r?\n/).some(line => ANY_RELEASE_HEADING.test(line) && !/^## \[Unreleased\]/.test(line));
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
	console.error('See AGENTS.md → Changelog → "Bilingual entries".');
	return 1;
}

if (import.meta.main) {
	process.exit(main());
}
