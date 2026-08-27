import * as path from "node:path";
import { getLastChangelogVersionPath, isEnoent, logger } from "@musepi/pi-utils";
import bundledChangelogPath from "../../CHANGELOG.md" with { type: "file" };
import bundledMusepiChangelogPath from "../../CHANGELOG.musepi.md" with { type: "file" };
import { getMusepiChangelogPath } from "../config";
import type { SettingValue } from "../config/settings";

export interface ChangelogEntry {
	major: number;
	minor: number;
	patch: number;
	content: string;
}

/** Number of changelog releases shown by automatic and default recent views. */
export const RECENT_CHANGELOG_ENTRY_LIMIT = 3;
/** Maximum Markdown source bytes allowed in automatic startup release notes. */
export const STARTUP_CHANGELOG_MAX_BYTES = 64 * 1024;
/** Hint appended when automatic startup release notes are truncated. */
export const STARTUP_CHANGELOG_FULL_HINT = "Use `/changelog full` to view the complete changelog.";

/** Markdown generated from selected changelog entries and whether it hit a size cap. */
export interface RenderedChangelog {
	markdown: string;
	truncated: boolean;
}

/** Automatic startup changelog decision, including whether the marker should advance. */
export interface StartupChangelogSelection {
	markdown: string | undefined;
	persistCurrentVersion: boolean;
	truncated: boolean;
	selectedEntries: number;
	totalUnseenEntries: number;
	latestVersion: string | undefined;
	changeCount: number;
	categoryCounts: Record<string, number>;
}

const CHANGELOG_CATEGORY_ORDER = [
	"Breaking Changes",
	"Added",
	"Changed",
	"Deprecated",
	"Removed",
	"Fixed",
	"Security",
] as const;

function emptyStartupSelection(persistCurrentVersion: boolean): StartupChangelogSelection {
	return {
		markdown: undefined,
		persistCurrentVersion,
		truncated: false,
		selectedEntries: 0,
		totalUnseenEntries: 0,
		latestVersion: undefined,
		changeCount: 0,
		categoryCounts: {},
	};
}

function summarizeChangelogEntries(entries: readonly ChangelogEntry[]): {
	changeCount: number;
	categoryCounts: Record<string, number>;
} {
	const categoryCounts: Record<string, number> = {};
	let changeCount = 0;

	for (const entry of entries) {
		let category: string | undefined;
		for (const line of entry.content.split("\n")) {
			const heading = line.match(/^###\s+(.+?)\s*$/);
			if (heading) {
				category = heading[1];
				continue;
			}
			if (!category || !/^-\s+\S/.test(line)) continue;
			categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
			changeCount++;
		}
	}

	return { changeCount, categoryCounts };
}

function categoryLabel(category: string, count: number): string {
	if (category === "Breaking Changes") {
		return count === 1 ? "breaking change" : "breaking changes";
	}
	return category.toLowerCase();
}

/** Format the compact, deterministic startup update notice. */
export function formatStartupChangelogSummary(selection: StartupChangelogSelection): string {
	const latestVersion = selection.latestVersion;
	if (!latestVersion || selection.selectedEntries === 0) {
		return "Updated omp. Use /changelog for recent changes.";
	}

	const releaseCount = selection.selectedEntries;
	const changeCount = selection.changeCount;
	const releaseWord = releaseCount === 1 ? "release" : "releases";
	const changeWord = changeCount === 1 ? "change" : "changes";
	const firstLine =
		releaseCount === 1
			? `Updated to v${latestVersion} · ${changeCount} ${changeWord} in 1 release`
			: `Updated to v${latestVersion} · ${changeCount} ${changeWord} across ${releaseCount} ${releaseWord}`;

	const orderedCategories = [
		...CHANGELOG_CATEGORY_ORDER.filter(category => selection.categoryCounts[category]),
		...Object.keys(selection.categoryCounts)
			.filter(category => !(CHANGELOG_CATEGORY_ORDER as readonly string[]).includes(category))
			.sort(),
	];
	const breakdown = orderedCategories
		.map(
			category =>
				`${selection.categoryCounts[category]} ${categoryLabel(category, selection.categoryCounts[category])}`,
		)
		.join(" · ");
	const omittedReleases = selection.totalUnseenEntries - selection.selectedEntries;
	const detailHint =
		omittedReleases > 0
			? `+${omittedReleases} earlier ${omittedReleases === 1 ? "release" : "releases"} · Use /changelog full for history.`
			: "Use /changelog for details.";

	return breakdown ? `${firstLine}\n${breakdown} · ${detailHint}` : `${firstLine}\n${detailHint}`;
}

/**
 * Parse changelog entries from omp's package asset when available, falling back
 * to the copy embedded in compiled binaries.
 *
 * The embedded fallback keeps standalone binaries self-contained without
 * resolving relative to the host project's cwd, which caused issue #1423.
 */
export function resolveBundledChangelogPath(assetPath: string, moduleUrl: string | URL): string | URL {
	if (path.isAbsolute(assetPath) || path.win32.isAbsolute(assetPath)) return assetPath;
	return new URL(assetPath, moduleUrl);
}

export async function parseChangelog(changelogPath: string | undefined): Promise<ChangelogEntry[]> {
	let content: string | undefined;
	// MusePi's own release notes win when present — the what's-new panel
	// must show MusePi changes, not upstream OMP's (which still parse as
	// the fallback for `/changelog full` parity on stock builds).
	const musepiPath = getMusepiChangelogPath();
	if (musepiPath) {
		try {
			content = await Bun.file(musepiPath).text();
		} catch {
			// absent in stock/build contexts — fall through to the fallbacks
		}
	}
	if (content === undefined && changelogPath) {
		try {
			content = await Bun.file(changelogPath).text();
		} catch (error) {
			if (!isEnoent(error)) {
				logger.error(`Warning: Could not parse changelog: ${error}`);
			}
		}
	}
	// Compiled binaries can't resolve package assets (import.meta.dir points
	// into bunfs), so try the embedded MusePi changelog before falling back
	// to the upstream OMP changelog.
	if (content === undefined) {
		try {
			content = await Bun.file(resolveBundledChangelogPath(bundledMusepiChangelogPath, import.meta.url)).text();
		} catch {
			// absent in non-compiled builds — fall through to the upstream fallback
		}
	}
	content ??= await Bun.file(resolveBundledChangelogPath(bundledChangelogPath, import.meta.url)).text();

	return parseChangelogContent(content);
}

function parseChangelogContent(content: string): ChangelogEntry[] {
	const lines = content.split("\n");
	const entries: ChangelogEntry[] = [];

	let currentLines: string[] = [];
	let currentVersion: { major: number; minor: number; patch: number } | null = null;

	for (const line of lines) {
		if (line.startsWith("## ")) {
			if (currentVersion && currentLines.length > 0) {
				entries.push({
					...currentVersion,
					content: currentLines.join("\n").trim(),
				});
			}

			const versionMatch = line.match(/##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/);
			if (versionMatch) {
				currentVersion = {
					major: Number.parseInt(versionMatch[1], 10),
					minor: Number.parseInt(versionMatch[2], 10),
					patch: Number.parseInt(versionMatch[3], 10),
				};
				currentLines = [line];
			} else {
				currentVersion = null;
				currentLines = [];
			}
		} else if (currentVersion) {
			currentLines.push(line);
		}
	}

	if (currentVersion && currentLines.length > 0) {
		entries.push({
			...currentVersion,
			content: currentLines.join("\n").trim(),
		});
	}

	return entries;
}

/**
 * Compare changelog entries by their parsed version parts.
 * Returns: -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
 */
function compareChangelogEntries(v1: ChangelogEntry, v2: ChangelogEntry): number {
	if (v1.major !== v2.major) return v1.major - v2.major;
	if (v1.minor !== v2.minor) return v1.minor - v2.minor;
	return v1.patch - v2.patch;
}

/**
 * Parse an musepi changelog marker version into comparable parts.
 */
export function parseChangelogVersion(version: string | undefined): ChangelogEntry | undefined {
	const match = version?.match(/^(\d+)\.(\d+)\.(\d+)$/);
	if (!match) {
		return undefined;
	}

	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		patch: Number.parseInt(match[3], 10),
		content: "",
	};
}

/**
 * Get entries newer than lastVersion.
 */
export function getNewEntries(entries: ChangelogEntry[], lastVersion: string): ChangelogEntry[] {
	const parsedLastVersion = parseChangelogVersion(lastVersion);
	if (!parsedLastVersion) {
		return [];
	}

	return entries.filter(entry => compareChangelogEntries(entry, parsedLastVersion) > 0);
}

/**
 * Locale for bilingual changelog content. Bilingual entries are written as a
 * Chinese line followed by an indented `  - EN: English` sub-line (see
 * CHANGELOG.musepi.md). Rendering picks one language per entry:
 *
 * - `"zh-CN"` (default): keep the Chinese line, drop the `- EN:` sub-line.
 * - `"en-US"`: swap the Chinese line for the `- EN:` content.
 *
 * Entries without a bilingual sub-line pass through unchanged (older
 * single-language notes stay as authored).
 */
export type ChangelogLocale = "zh-CN" | "en-US";

/** Default locale for changelog rendering (MusePi is Chinese-first). */
export const CHANGELOG_DEFAULT_LOCALE: ChangelogLocale = "zh-CN";

function localizeChangelogContent(content: string, locale: ChangelogLocale): string {
	const lines = content.split("\n");
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const enSub = line.match(/^\s*- EN: (.*)$/);
		if (enSub) {
			// `- EN:` sub-line: dropped in zh, consumed by the parent in en.
			continue;
		}
		if (locale === "en-US" && /^-\s+\S/.test(line)) {
			// Multi-line entries put the `- EN:` sub-line after their
			// continuation block — scan forward until the next bullet.
			let j = i + 1;
			let enLine: string | undefined;
			while (j < lines.length && !/^-\s/.test(lines[j])) {
				const m = lines[j].match(/^\s*- EN: (.*)$/);
				if (m) {
					enLine = m[1];
					break;
				}
				j++;
			}
			if (enLine) {
				out.push(`- ${enLine}`);
				i = j;
				continue;
			}
		}
		out.push(line);
	}
	return out.join("\n");
}

/**
 * Render changelog entries oldest-first by default and optionally cap the Markdown source size.
 */
export function renderChangelogEntries(
	entries: ChangelogEntry[],
	options: { maxBytes?: number; truncationHint?: string; oldestFirst?: boolean; locale?: ChangelogLocale } = {},
): RenderedChangelog {
	const locale = options.locale ?? CHANGELOG_DEFAULT_LOCALE;
	const orderedEntries = options.oldestFirst === false ? entries : [...entries].reverse();
	const markdown = orderedEntries.map(entry => localizeChangelogContent(entry.content, locale)).join("\n\n");
	if (options.maxBytes === undefined || Buffer.byteLength(markdown) <= options.maxBytes) {
		return { markdown, truncated: false };
	}

	const suffix = `\n\n…\n\n${options.truncationHint ?? STARTUP_CHANGELOG_FULL_HINT}`;
	let low = 0;
	let high = markdown.length;
	while (low < high) {
		const middle = Math.floor((low + high + 1) / 2);
		if (Buffer.byteLength(markdown.slice(0, middle) + suffix) <= options.maxBytes) {
			low = middle;
		} else {
			high = middle - 1;
		}
	}

	return { markdown: markdown.slice(0, low) + suffix, truncated: true };
}

/**
 * Select bounded release notes for interactive startup.
 */
export function selectStartupChangelog(
	entries: ChangelogEntry[],
	lastVersion: string | undefined,
	currentVersion: string,
	locale: ChangelogLocale = CHANGELOG_DEFAULT_LOCALE,
): StartupChangelogSelection {
	const parsedLastVersion = parseChangelogVersion(lastVersion);
	if (!parsedLastVersion) {
		return emptyStartupSelection(true);
	}
	const markerVersion = lastVersion ?? "";
	if (markerVersion === currentVersion) {
		return emptyStartupSelection(false);
	}
	// Version-system switch or downgrade: a marker NEWER than the current
	// version would filter out every entry below it (MusePi 0.4.x notes
	// vs an upstream 17.x marker from the pre-split era) and the what's-new
	// panel would go silent forever. Treat the marker as first-seen on the
	// current series so the MusePi notes surface; the marker re-persists to
	// the current version via persistCurrentVersion below.
	const parsedCurrentVersion = parseChangelogVersion(currentVersion);
	if (parsedCurrentVersion && compareChangelogEntries(parsedCurrentVersion, parsedLastVersion) < 0) {
		return selectStartupChangelog(entries, "0.0.0", currentVersion, locale);
	}

	const allNewEntries = getNewEntries(entries, markerVersion);
	const newEntries = allNewEntries.slice(0, RECENT_CHANGELOG_ENTRY_LIMIT);
	if (newEntries.length === 0) {
		return emptyStartupSelection(false);
	}

	const rendered = renderChangelogEntries(newEntries, {
		maxBytes: STARTUP_CHANGELOG_MAX_BYTES,
		truncationHint: STARTUP_CHANGELOG_FULL_HINT,
		oldestFirst: false,
		locale,
	});
	const summary = summarizeChangelogEntries(newEntries);
	const latestEntry = newEntries[newEntries.length - 1] ?? newEntries[0];
	return {
		markdown: rendered.markdown,
		persistCurrentVersion: true,
		truncated: rendered.truncated,
		selectedEntries: newEntries.length,
		totalUnseenEntries: allNewEntries.length,
		latestVersion: latestEntry ? `${latestEntry.major}.${latestEntry.minor}.${latestEntry.patch}` : undefined,
		...summary,
	};
}

/**
 * Resolve and persist the automatic startup changelog decision.
 *
 * Hidden mode advances the marker only for an upgrade, so downgrades do not
 * erase knowledge of a newer version the user has already seen.
 */
export async function resolveStartupChangelogForDisplay(options: {
	mode: SettingValue<"startup.changelogMode">;
	currentVersion: string;
	changelogPath?: string;
	agentDir?: string;
	locale?: ChangelogLocale;
}): Promise<StartupChangelogSelection | undefined> {
	const lastVersion = await readLastChangelogVersion(options.agentDir);
	const parsedLastVersion = parseChangelogVersion(lastVersion);
	if (!parsedLastVersion) {
		await writeLastChangelogVersion(options.currentVersion, options.agentDir);
		return undefined;
	}
	if (lastVersion === options.currentVersion) {
		// Steady state: skip the changelog file read and parse.
		return undefined;
	}
	if (options.mode === "hidden") {
		const currentVersion = parseChangelogVersion(options.currentVersion);
		if (currentVersion && compareChangelogEntries(currentVersion, parsedLastVersion) > 0) {
			await writeLastChangelogVersion(options.currentVersion, options.agentDir);
		}
		return undefined;
	}

	const entries = await parseChangelog(options.changelogPath);
	const startupChangelog = selectStartupChangelog(
		entries,
		lastVersion,
		options.currentVersion,
		options.locale ?? CHANGELOG_DEFAULT_LOCALE,
	);
	if (startupChangelog.persistCurrentVersion) {
		await writeLastChangelogVersion(options.currentVersion, options.agentDir);
	}
	return startupChangelog.markdown ? startupChangelog : undefined;
}

// Re-export getChangelogPath from paths.ts for convenience
export { getChangelogPath } from "../config";

/**
 * Last musepi version whose changelog the user has seen. Stored as a plain-text
 * marker file (`~/.musepi/agent/last-changelog-version`) rather than in
 * `config.yml`, so version bumps never dirty user-tracked config files.
 */
export async function readLastChangelogVersion(agentDir?: string): Promise<string | undefined> {
	try {
		const value = (await Bun.file(getLastChangelogVersionPath(agentDir)).text()).trim();
		return value || undefined;
	} catch (error) {
		if (!isEnoent(error)) {
			logger.warn("Failed to read last-changelog-version marker", { error: String(error) });
		}
		return undefined;
	}
}

/** Persist the last-seen changelog version marker. Best-effort: failures are logged, never thrown. */
export async function writeLastChangelogVersion(version: string, agentDir?: string): Promise<void> {
	try {
		await Bun.write(getLastChangelogVersionPath(agentDir), version);
	} catch (error) {
		logger.warn("Failed to persist last-changelog-version marker", { error: String(error) });
	}
}
