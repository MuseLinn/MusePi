#!/usr/bin/env bun

/**
 * Render the GitHub release body from `CHANGELOG.musepi.md`.
 *
 * Why this exists: the release workflow used to splice the newest changelog
 * section under the download table verbatim. That repeated the version line
 * the page already shows, dropped the section's own header context, and gave
 * no at-a-glance answer to "what is new, what improved, what was fixed".
 *
 * Contract (see `.agents/rules/release.md` → "Changelog ownership"):
 *   - the newest `## [x.y.z] - date` section is the only source of the body;
 *   - the body keeps the platform download table, replaces the duplicated
 *     version heading with a counts line (`本次发布：N 项新功能 · M 项改进 ·
 *     K 项修复`), then lists the categorized entries unchanged;
 *   - the body ends with links to the full changelog and to the tag-to-tag
 *     comparison against the next older release in the file;
 *   - the OTA `update-manifest.json` notes are the same section with its
 *     version heading and counts line, so the update dialog's first ~200
 *     characters state the release and its category breakdown.
 *
 * Pure functions plus a thin CLI: the workflow passes the version, tag and
 * output paths, and the same functions are unit-tested with changelog text.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";

const CHANGELOG_PATH = "packages/coding-agent/CHANGELOG.musepi.md";
const APP_PACKAGE_PATH = "apps/desktop/package.json";

export const DEFAULT_REPO = "MuseLinn/MusePi";

/** `## [1.2.3] - 2026-11-21` and `## [1.2.3-beta.1] - 2026-11-21`. */
const RELEASE_HEADING = /^## \[([^\]]+)\](?:\s*-\s*(.*))?$/;
/** Released sections only; `[Unreleased]` and prose headings are skipped. */
const RELEASED_VERSION = /^\d+\.\d+\.\d+(?:-beta\.\d+)?$/;
const SUBSECTION_HEADING = /^###\s+(.+?)\s*$/;

/** One released changelog section, heading stripped. */
export interface ReleaseSection {
	version: string;
	/** Date from the heading; "" when the heading carries none. */
	date: string;
	/** Markdown after the `## [version] - date` heading, blank edges trimmed. */
	body: string;
}

export interface ReleaseEntryCounts {
	added: number;
	improved: number;
	fixed: number;
	/** Entries outside a category heading (released flat sections, other headings). */
	uncategorized: number;
	total: number;
}

/** Heading → counts bucket. Chinese headings are canonical; the English names
 *  of older released sections still count so a legacy body renders sensibly. */
const CATEGORY_KIND: Record<string, "added" | "improved" | "fixed"> = {
	新功能: "added",
	Added: "added",
	改进: "improved",
	Changed: "improved",
	Improved: "improved",
	修复: "fixed",
	Fixed: "fixed",
};

function trimBlankLines(lines: readonly string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && (lines[start] ?? "").trim() === "") start++;
	while (end > start && (lines[end - 1] ?? "").trim() === "") end--;
	return lines.slice(start, end);
}

/** Every released section in document order (the file is newest-first). */
export function listReleaseSections(changelog: string): ReleaseSection[] {
	const sections: ReleaseSection[] = [];
	let current: { version: string; date: string; lines: string[] } | null = null;

	const flush = (): void => {
		if (!current) return;
		sections.push({
			version: current.version,
			date: current.date,
			body: trimBlankLines(current.lines).join("\n"),
		});
		current = null;
	};

	for (const line of changelog.split(/\r?\n/)) {
		const heading = RELEASE_HEADING.exec(line);
		if (heading) {
			flush();
			const version = (heading[1] ?? "").trim();
			if (RELEASED_VERSION.test(version)) {
				current = { version, date: (heading[2] ?? "").trim(), lines: [] };
			}
			continue;
		}
		if (current) current.lines.push(line);
	}
	flush();
	return sections;
}

/** The section for one exact version, or undefined when the file has none. */
export function findReleaseSection(changelog: string, version: string): ReleaseSection | undefined {
	return listReleaseSections(changelog).find(section => section.version === version);
}

/** Per-category entry counts for a section body. */
export function countReleaseEntries(body: string): ReleaseEntryCounts {
	const counts: ReleaseEntryCounts = { added: 0, improved: 0, fixed: 0, uncategorized: 0, total: 0 };
	let kind: "added" | "improved" | "fixed" | undefined;

	for (const line of body.split(/\r?\n/)) {
		if (line.startsWith("#")) {
			const title = SUBSECTION_HEADING.exec(line)?.[1] ?? "";
			kind = CATEGORY_KIND[title];
			continue;
		}
		// Top-level bullets only; the indented `- EN:` child is part of its parent.
		if (!line.startsWith("- ")) continue;
		counts.total++;
		counts[kind ?? "uncategorized"]++;
	}

	return counts;
}

/**
 * The one-line release summary. Zero categories are omitted so a fix-only
 * release reads "本次发布：3 项修复" rather than three zeroes.
 */
export function formatReleaseSummary(counts: ReleaseEntryCounts): string {
	const parts: string[] = [];
	if (counts.added > 0) parts.push(`${counts.added} 项新功能`);
	if (counts.improved > 0) parts.push(`${counts.improved} 项改进`);
	if (counts.fixed > 0) parts.push(`${counts.fixed} 项修复`);
	if (counts.uncategorized > 0) parts.push(`${counts.uncategorized} 项其他变更`);
	return `本次发布：${parts.length > 0 ? parts.join(" · ") : "无用户可见变更"}`;
}

function assetsBaseUrl(repo: string, assetsTag: string): string {
	return `https://github.com/${repo}/releases/download/${assetsTag}`;
}

/** Platform download table; `assetsTag` is the tag the assets are uploaded under. */
export function buildDownloadTable(version: string, assetsTag: string, repo = DEFAULT_REPO): string {
	const base = assetsBaseUrl(repo, assetsTag);
	const link = (name: string): string => `[${name}](${base}/${name})`;
	return [
		"| Platform | 下载 |",
		"| --- | --- |",
		`| macOS (Apple Silicon) | ${link(`MusePi-${version}-arm64.dmg`)} |`,
		`| Windows | ${link(`MusePi-${version}-setup.exe`)} · ${link(`MusePi-${version}-arm64-setup.exe`)} |`,
		`| Linux x64 | ${link(`MusePi-${version}-x86_64.AppImage`)} · ${link(`MusePi-${version}-amd64.deb`)} |`,
		`| Linux arm64 | ${link(`MusePi-${version}-arm64.AppImage`)} · ${link(`MusePi-${version}-arm64.deb`)} |`,
		`| Android | ${link(`MusePi-${version}-app-debug.apk`)} (debug build, adb 安装) |`,
	].join("\n");
}

/** Full changelog and previous-release comparison footer. */
export function buildReleaseLinks(input: {
	version: string;
	tag: string;
	previousVersion?: string;
	repo?: string;
}): string {
	const repo = input.repo ?? DEFAULT_REPO;
	const changelog = `[完整更新日志](https://github.com/${repo}/blob/main/${CHANGELOG_PATH})`;
	const previous = input.previousVersion;
	const comparison = previous
		? `[对比 v${previous}…v${input.version}](https://github.com/${repo}/compare/v${previous}...${input.tag})`
		: `[全部发布](https://github.com/${repo}/releases)`;
	return `${changelog} · ${comparison}`;
}

/** Derive the released version from a `v<version>` tag. */
function versionFromTag(tag: string): string {
	if (!tag.startsWith("v") || tag.length === 1) {
		throw new Error(`tag "${tag}" must use the release form "v<version>"`);
	}
	return tag.slice(1);
}

/**
 * Resolve the version and tag the body is rendered for. `--tag` alone derives
 * the version, so a tag can never silently render another release's section;
 * when both are given they must agree on `v<version>`.
 */
export function resolveReleaseVersion(input: { version?: string; tag?: string; packageVersion: string }): {
	version: string;
	tag: string;
} {
	const version = input.version ?? (input.tag ? versionFromTag(input.tag) : input.packageVersion);
	const tag = input.tag ?? `v${version}`;
	if (tag !== `v${version}`) {
		throw new Error(`tag "${tag}" does not match version ${version} (expected "v${version}")`);
	}
	return { version, tag };
}

export interface RenderReleaseNotesInput {
	changelog: string;
	/** Version being released; must exist as a `## [version]` section. */
	version: string;
	/** Git tag of this release, used for the comparison link (`v0.7.8`). */
	tag: string;
	/** Tag the assets were uploaded under; defaults to `tag` (`channel-beta` for betas). */
	assetsTag?: string;
	repo?: string;
}

/** The GitHub release body: download table, counts line, entries, links. */
export function renderReleaseNotes(input: RenderReleaseNotesInput): string {
	if (input.tag !== `v${input.version}`) {
		throw new Error(`tag "${input.tag}" does not match version ${input.version} (expected "v${input.version}")`);
	}
	const sections = listReleaseSections(input.changelog);
	const index = sections.findIndex(section => section.version === input.version);
	if (index < 0) {
		const latest = sections[0]?.version;
		throw new Error(
			`no \`## [${input.version}]\` section in the changelog` +
				(latest ? ` (newest released section is \`## [${latest}]\`)` : ""),
		);
	}
	const section = sections[index];
	const previousVersion = sections[index + 1]?.version;
	const counts = countReleaseEntries(section.body);

	const blocks = [
		`# MusePi ${input.version}`,
		buildDownloadTable(input.version, input.assetsTag ?? input.tag, input.repo),
		formatReleaseSummary(counts),
	];
	if (section.body !== "") blocks.push(section.body);
	blocks.push("---", buildReleaseLinks({ version: input.version, tag: input.tag, previousVersion, repo: input.repo }));

	return `${blocks.join("\n\n")}\n`;
}

/**
 * OTA `update-manifest.json` notes: the version heading, the counts line and
 * the categorized entries. The update dialog clamps to ~200 characters, so the
 * heading and the category breakdown must come first.
 */
export function buildUpdateNotes(section: ReleaseSection): string {
	const heading = section.date ? `## [${section.version}] - ${section.date}` : `## [${section.version}]`;
	const counts = countReleaseEntries(section.body);
	const blocks = [heading, formatReleaseSummary(counts)];
	if (section.body !== "") blocks.push(section.body);
	return `${blocks.join("\n\n")}\n`;
}

// --------------------------------------------------------------------------
// CLI

interface CliOptions {
	changelogPath: string;
	appPackagePath: string;
	version?: string;
	tag?: string;
	assetsTag?: string;
	repo: string;
	out: string;
	otaOut?: string;
}

function parseOptions(argv: string[]): CliOptions {
	const { values } = parseArgs({
		args: argv,
		options: {
			changelog: { type: "string" },
			"app-package": { type: "string" },
			version: { type: "string" },
			tag: { type: "string" },
			"assets-tag": { type: "string" },
			repo: { type: "string" },
			out: { type: "string" },
			"ota-out": { type: "string" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		console.log(
			[
				"Usage: bun scripts/render-release-notes.ts [options]",
				"  --changelog <path>     CHANGELOG.musepi.md to read",
				"  --app-package <path>   package.json carrying the app version",
				"  --version <x.y.z>      released version (default: --tag without its leading v, else the app package version)",
				"  --tag <tag>            release tag; must equal v<version> (default: v<version>)",
				"  --assets-tag <tag>     tag the assets are published under (default: --tag)",
				"  --repo <owner/name>    repository (default: MuseLinn/MusePi)",
				"  --out <path>           release body output (default: dist/RELEASE_NOTES.md)",
				"  --ota-out <path>       also write the update-manifest notes",
			].join("\n"),
		);
		process.exit(0);
	}
	return {
		changelogPath: values.changelog ?? CHANGELOG_PATH,
		appPackagePath: values["app-package"] ?? APP_PACKAGE_PATH,
		version: values.version,
		tag: values.tag,
		assetsTag: values["assets-tag"],
		repo: values.repo ?? DEFAULT_REPO,
		out: values.out ?? "dist/RELEASE_NOTES.md",
		otaOut: values["ota-out"],
	};
}

async function readAppVersion(packagePath: string): Promise<string> {
	const pkg = (await Bun.file(packagePath).json()) as { version?: unknown };
	if (typeof pkg.version !== "string" || pkg.version.trim() === "") {
		throw new Error(`no version in ${packagePath}`);
	}
	return pkg.version.trim();
}

async function main(): Promise<number> {
	try {
		const options = parseOptions(process.argv.slice(2));
		const { version, tag } = resolveReleaseVersion({
			version: options.version,
			tag: options.tag,
			packageVersion: await readAppVersion(options.appPackagePath),
		});
		const changelog = await Bun.file(options.changelogPath).text();
		const section = findReleaseSection(changelog, version);
		if (!section) throw new Error(`no \`## [${version}]\` section in the changelog`);
		const body = renderReleaseNotes({
			changelog,
			version,
			tag,
			assetsTag: options.assetsTag,
			repo: options.repo,
		});

		fs.mkdirSync(path.dirname(options.out), { recursive: true });
		fs.writeFileSync(options.out, body);
		console.log(
			`release-notes: ${version} → ${options.out} (${formatReleaseSummary(countReleaseEntries(section.body))})`,
		);

		if (options.otaOut) {
			fs.mkdirSync(path.dirname(options.otaOut), { recursive: true });
			fs.writeFileSync(options.otaOut, buildUpdateNotes(section));
			console.log(`release-notes: OTA notes → ${options.otaOut}`);
		}
		return 0;
	} catch (error) {
		console.error(`render-release-notes: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

if (import.meta.main) {
	process.exit(await main());
}
