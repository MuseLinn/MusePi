#!/usr/bin/env bun

/**
 * Guard the *voice* of `CHANGELOG.musepi.md` entry titles.
 *
 * Why this exists: that one file is the single source for every user-facing
 * release surface — the GUI what's-new panel (where a bullet's bold span
 * becomes a card title verbatim), `/changelog`, the OTA
 * `update-manifest.json` notes (first 200 chars of the section) and the
 * GitHub release page body. A title written as an engineering decision record
 * ("两处刻意不照抄 openchamber") therefore ships to users as a headline.
 *
 * Scope: **titles of `[Unreleased]` bullets only.** Two deliberate limits:
 *   - Title layer only. A bullet's body may still carry mechanism, rationale
 *     and provenance — the panel truncates it, and the engineering record is
 *     worth keeping. Only the part rendered as a headline is gated.
 *   - `[Unreleased]` only. Released sections are immutable (AGENTS.md →
 *     Changelog), and 0.5.0-0.5.3 predate this rule; re-judging shipped
 *     history in CI would fail every build for no user benefit.
 *
 * Contract (see AGENTS.md → Changelog → "Voice"):
 *   - a title states what changed for the user, in the user's vocabulary;
 *   - provenance ("吸收 X" / "X parity" / internal cut numbers) belongs in
 *     the body or the PR, never in the headline.
 *
 * Exit 0 when compliant (or when `[Unreleased]` has no bulleted titles),
 * exit 1 with a per-bullet report otherwise.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const CHANGELOG_PATH = "packages/coding-agent/CHANGELOG.musepi.md";

/** `- ` at column 0 opens a bullet; anything deeper is a child line. */
const TOP_BULLET = /^- /;
/** `## [Unreleased]` — the only section this gate judges. */
const UNRELEASED_HEADING = /^## \[Unreleased\]/;
/** Any `## [` heading — closes the `[Unreleased]` section. */
const ANY_RELEASE_HEADING = /^## \[/;
/** The bold span that becomes the card title: `- **title**：…`. */
const TITLE_SPAN = /^- \*\*([^*]+)\*\*/;
/** A parenthetical glued to the title span: `**title**（来源）：…`. */
const ADJACENT_PAREN = /^(- \*\*[^*]+\*\*)\s*（([^）]*)）/;

/**
 * Words that mark a title as an engineering note rather than a user-facing
 * change. Kept as separate patterns so the report can name which one fired.
 *
 * Each is deliberately narrow: `吸收` alone would not fire on a title like
 * 「提示缓存预热」, and the reference names are matched as whole tokens so a
 * title containing e.g. "Kd" does not trip the `dsh` pattern.
 */
const TITLE_TELLS: { pattern: RegExp; label: string }[] = [
	{
		pattern: /刻意|有意不|不照抄|没有照抄|并未照搬|不整体搬运/,
		label: "decision narrative",
	},
	{ pattern: /吸收|对标|复刻|搬运/, label: "provenance verb" },
	{ pattern: /parity/i, label: "provenance (parity)" },
	{
		pattern: /openchamber|open-design|workdsh|zcode|kimi|deepseek-harness/,
		label: "reference repo name",
	},
	{ pattern: /\bdsh\b|\bomp\b|\bkimi-code\b/, label: "internal project name" },
	{ pattern: /上游|upstream/i, label: "provenance (upstream)" },
	{
		pattern: /根因|这一刀|本轮|复核|拍板|否决|回滚|里程碑|首刀|第[一二三四五六七八九十\d]+刀/,
		label: "process narration",
	},
	{
		pattern: /\bADR\b|\bM\d+(-\d+)*\b|\bP\d+\b|\bRPC\b/,
		label: "internal identifier",
	},
];

export interface VoiceProblem {
	/** 1-based line number of the offending bullet. */
	line: number;
	/** The title text as written. */
	title: string;
	/** Which rule fired. */
	label: string;
}

export interface VoiceCheckResult {
	/** Bullets in `[Unreleased]` that carried a bold title. */
	checked: number;
	problems: VoiceProblem[];
}

/** The gated region of a bullet line: bold span plus an adjacent parenthetical. */
function titleRegion(line: string): string | null {
	const withParen = ADJACENT_PAREN.exec(line);
	if (withParen) return `${withParen[1]}（${withParen[2]}）`;
	const span = TITLE_SPAN.exec(line);
	return span ? span[0] : null;
}

export function checkChangelogVoice(content: string): VoiceCheckResult {
	const lines = content.split(/\r?\n/);
	const problems: VoiceProblem[] = [];
	let checked = 0;
	let inUnreleased = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (UNRELEASED_HEADING.test(line)) {
			inUnreleased = true;
			continue;
		}
		// Any other release heading closes the section — including the
		// `## [x.y.z]` blocks that sit below `[Unreleased]` in this file.
		if (ANY_RELEASE_HEADING.test(line)) {
			inUnreleased = false;
			continue;
		}
		if (!inUnreleased) continue;
		// Section headings ("### Added") stay inside `[Unreleased]`.
		if (line.startsWith("#")) continue;
		if (!TOP_BULLET.test(line)) continue;

		const region = titleRegion(line);
		if (region === null) continue;
		checked++;
		for (const tell of TITLE_TELLS) {
			if (tell.pattern.test(region)) {
				problems.push({
					line: i + 1,
					title: region.replace(/^- \*\*/, "").replace(/\*\*$/, ""),
					label: tell.label,
				});
				break;
			}
		}
	}

	return { checked, problems };
}

function main(): number {
	const argv = process.argv.slice(2);
	const quiet = argv.includes("--quiet");
	const target = argv.find(a => !a.startsWith("--")) ?? CHANGELOG_PATH;
	const file = path.resolve(target);

	if (!fs.existsSync(file)) {
		console.error(`check-changelog-voice: missing file: ${file}`);
		return 1;
	}

	const result = checkChangelogVoice(fs.readFileSync(file, "utf8"));

	if (result.problems.length === 0) {
		if (!quiet) {
			console.log(
				result.checked > 0
					? `check-changelog-voice: OK — ${result.checked} [Unreleased] title(s) read as user-facing changes.`
					: "check-changelog-voice: OK — no [Unreleased] titles to judge.",
			);
		}
		return 0;
	}

	const rel = path.relative(process.cwd(), file);
	console.error(`check-changelog-voice: ${result.problems.length} problem(s) in ${rel}`);
	for (const p of result.problems) {
		console.error(`  ${rel}:${p.line}  [${p.label}]  ${p.title}`);
	}
	console.error("");
	console.error("A [Unreleased] title is rendered verbatim as a what's-new card headline.");
	console.error("State the user-visible change; move provenance and cut numbers into the body:");
	console.error("  - **翻页按轮次对齐：最老的一轮不再是个碎片**：此前一次翻页是 500 条平铺前置……");
	console.error('See AGENTS.md → Changelog → "Voice".');
	return 1;
}

if (import.meta.main) {
	process.exit(main());
}
