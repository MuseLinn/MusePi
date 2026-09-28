/**
 * Changelog highlights — client-side structured parsing of the startup
 * changelog markdown (what's-new panel).
 *
 * The daemon keeps serving a plain markdown string (zero wire changes); this
 * parser slices it into per-version `## [x.y.z] - date` sections and extracts
 * up to three bold "highlights" per version plus per-kind entry counts.
 * Pure line-level state machine: no regex segmentation, no side effects, no
 * React, no imports.
 */

/** The four categorized sections that produce counts and highlight kinds.
 *  Entries under any other heading (e.g. "Breaking Changes") are neither
 *  counted nor highlighted. */
export type ChangelogHighlightKind = "added" | "fixed" | "changed" | "removed";

export interface ChangelogHighlight {
	kind: ChangelogHighlightKind;
	/** The bullet's bold span (`- **title**：…` → the span text). */
	title: string;
	/** First sentence of the bullet's Chinese main line after the bold span.
	 *  The indented `- EN:` child line NEVER leaks in here; display-side
	 *  truncation (≤2 lines) is the caller's job (CSS line clamp). */
	description: string;
}

export interface ChangelogVersionCounts {
	added: number;
	fixed: number;
	changed: number;
	removed: number;
}

export interface ChangelogVersion {
	version: string;
	/** Date from the `## [x.y.z] - date` heading ("" when it carries none). */
	date: string;
	highlights: ChangelogHighlight[];
	counts: ChangelogVersionCounts;
	/** Raw markdown of this section (heading included) — the full-log
	 *  fallback and the per-version expandable rows render this verbatim. */
	markdown: string;
}

/** Highlights kept per version (the what's-new card shows ≤3). */
export const HIGHLIGHTS_PER_VERSION = 3;

const KIND_BY_HEADING: Record<string, ChangelogHighlightKind> = {
	added: "added",
	fixed: "fixed",
	changed: "changed",
	removed: "removed",
};

/** First sentence: up to and including the first CJK sentence terminator.
 *  Text without any terminator is kept whole (single-sentence bullets). */
function firstSentence(text: string): string {
	const match = text.match(/^[^。！？]*[。！？]/);
	return match ? match[0] : text;
}

/** Split a bullet's main line into bold title + description, or null when
 *  the line carries no leading bold span (never a highlight candidate). */
function extractHighlight(line: string): { title: string; description: string } | null {
	if (!line.startsWith("**")) return null;
	const end = line.indexOf("**", 2);
	if (end < 0) {
		// Unterminated bold span: everything after the opener is the title.
		return { title: line.slice(2).trim(), description: "" };
	}
	const title = line.slice(2, end).trim();
	if (title === "") return null;
	const rest = line
		.slice(end + 2)
		.replace(/^[:：]\s*/, "")
		.trim();
	return { title, description: firstSentence(rest) };
}

/** Parse startup changelog markdown into per-version highlight sections.
 *  `[Unreleased]` sections are skipped; empty input or input without any
 *  version section yields [] (the caller falls back to the raw rendering).
 *  Document order is preserved — the array head is the current version. */
export function parseChangelogHighlights(markdown: string): ChangelogVersion[] {
	if (markdown.trim() === "") return [];
	const versions: ChangelogVersion[] = [];
	let current: {
		version: string;
		date: string;
		lines: string[];
		highlights: ChangelogHighlight[];
		counts: ChangelogVersionCounts;
	} | null = null;
	let kind: ChangelogHighlightKind | null = null;

	const push = (): void => {
		if (!current) return;
		versions.push({
			version: current.version,
			date: current.date,
			highlights: current.highlights,
			counts: current.counts,
			markdown: current.lines.join("\n").trim(),
		});
		current = null;
	};

	for (const line of markdown.split("\n")) {
		const heading = line.match(/^##\s+\[([^\]]+)\]\s*(?:-\s*(.*))?$/);
		if (heading) {
			push();
			kind = null;
			const version = heading[1].trim();
			if (version === "" || version.toLowerCase() === "unreleased") continue;
			current = {
				version,
				date: (heading[2] ?? "").trim(),
				lines: [line],
				highlights: [],
				counts: { added: 0, fixed: 0, changed: 0, removed: 0 },
			};
			continue;
		}
		if (!current) continue;
		current.lines.push(line);

		const kindHeading = line.match(/^###\s+(.+?)\s*$/);
		if (kindHeading) {
			kind = KIND_BY_HEADING[kindHeading[1].toLowerCase()] ?? null;
			continue;
		}
		// Top-level bullets only — the indented `  - EN:` child lines never
		// match, so they can be neither counted nor highlighted.
		if (!line.startsWith("- ")) continue;
		const body = line.slice(2);
		if (kind) current.counts[kind] += 1;
		if (!kind || current.highlights.length >= HIGHLIGHTS_PER_VERSION) continue;
		const parsed = extractHighlight(body);
		if (parsed) current.highlights.push({ kind, ...parsed });
	}
	push();
	return versions;
}
