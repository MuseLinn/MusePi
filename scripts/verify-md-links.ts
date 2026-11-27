import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { Glob } from "bun";

/**
 * Gate: relative Markdown links must resolve, and a `#fragment` onto a Markdown
 * target must name a heading or an explicit anchor there.
 *
 * Why a gate: a moved or renamed document leaves its inbound links silently
 * dead, and a drifted heading leaves every deep link pointing at nothing. Both
 * read as working prose in review.
 *
 * The parser is deliberately small: it strips fenced code blocks so a sample
 * link is not judged, then reads inline `](...)` destinations and reference
 * definitions. MusePi parses no Markdown elsewhere, so this avoids a parser
 * dependency for a check that only needs these two forms.
 */

const ROOT = resolve(import.meta.dirname, "..");

/** Authored Markdown whose cross-links are checked. */
const SOURCE_GLOBS = ["docs/**/*.md"] as const;

/**
 * Process records keep historical links: an ADR or a review names the document
 * as it stood when the decision was made, and rewriting it would falsify the
 * record.
 */
const PROCESS_RECORD_PREFIXES = ["docs/adr/", "docs/gui-verification/", "docs/review/", "docs/superpowers/"];

/** An inline destination: `](target)` or `](target "title")`. */
const INLINE_LINK = /\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+["'][^"']*["'])?\s*\)/g;

/**
 * A line carrying this marker states that its links are illustrative and name no
 * real document. It counts on the line itself or the line directly above it, so
 * a paragraph explaining a link convention keeps its example.
 */
const EXAMPLE_MARKER = "link-example:";

/** A reference definition: `[label]: target`. */
const DEFINITION = /^\s{0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm;

/**
 * Resolve a rendered-site destination to the document it is generated from.
 *
 * The GitHub Pages `jekyll-relative-links` plugin rewrites internal `.md` links
 * to `.html` (see `_config.yml`), so a documented `./collab.html` means
 * `./collab.md`. Judging the rendered name would report every such link broken.
 */
export function sourceDocumentFor(target: string): string {
	if (!target.endsWith(".html")) return target;
	return `${target.slice(0, target.length - ".html".length)}.md`;
}

/** One broken link and what about it failed. */
interface LinkViolation {
	/** Repository-relative Markdown source. */
	file: string;
	/** One-based line of the link. */
	line: number;
	/** The destination exactly as written. */
	url: string;
	/** Which part failed. */
	reason: "target" | "anchor";
}

/**
 * Blank out fenced code blocks while preserving line numbering, so a link
 * written inside a sample is not mistaken for a real one.
 */
export function stripFencedCode(source: string): string {
	const lines = source.split("\n");
	let fence: string | null = null;
	const out: string[] = [];
	for (const line of lines) {
		const trimmed = line.trimStart();
		if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
			const marker = trimmed.slice(0, 3);
			if (fence === null) fence = marker;
			else if (marker === fence) fence = null;
			out.push("");
			continue;
		}
		out.push(fence === null ? line : "");
	}
	return out.join("\n");
}

/**
 * Whether a destination is owned by another renderer or another origin: a
 * scheme-qualified URL, a protocol-relative host, or a root-absolute path.
 * A same-document `#fragment` is checked, against the source file itself.
 */
export function isExternalTarget(url: string): boolean {
	if (url.startsWith("//") || url.startsWith("/")) return true;
	return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url);
}

/** Split a destination into its path and its `#fragment`. */
export function splitDestination(url: string): { path: string; fragment: string | null } {
	const hash = url.indexOf("#");
	const withoutQuery = url.replace(/[?].*$/, "");
	if (hash < 0) return { path: withoutQuery, fragment: null };
	const raw = url.slice(hash + 1).replace(/\?.*$/, "");
	const path = url.slice(0, hash).replace(/[?].*$/, "");
	return { path, fragment: raw.length > 0 ? safeDecode(raw) : null };
}

/** Percent-decode a destination part; a malformed escape names no real target. */
function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * GitHub's heading slug: lowercase, drop everything but letters, numbers,
 * underscores, spaces, and hyphens, then turn spaces into hyphens.
 */
export function githubSlug(heading: string): string {
	return heading
		.toLowerCase()
		.replace(/[^\p{L}\p{N}_ -]/gu, "")
		.replaceAll(" ", "-");
}

/** Rendered heading text: drop link syntax, inline code marks, and emphasis. */
function headingText(raw: string): string {
	return raw
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[`*_~]/g, "")
		.replace(/\s+#+\s*$/, "")
		.trim();
}

/**
 * Whether one line's links are illustrative.
 *
 * The marker governs the block it starts: everything from the marked line down
 * to the next blank line or the next list item. A convention explained in one
 * list item often spans several lines, and the example link can land on any of
 * them.
 */
export function isExampleLink(source: string, line: number): boolean {
	const lines = stripFencedCode(source).split("\n");
	let start = line - 1;
	// Walk up to the line that opens this block.
	while (start > 0) {
		const previous = lines[start - 1] ?? "";
		const current = lines[start] ?? "";
		if (previous.trim().length === 0 || /^\s*(?:[-*+]|\d+\.)\s/.test(current)) break;
		start -= 1;
	}
	const opening = lines[start] ?? "";
	if (opening.includes(EXAMPLE_MARKER)) return true;
	return (lines[start - 1] ?? "").includes(EXAMPLE_MARKER);
}

/**
 * Every fragment a document exposes: each heading's GitHub slug with
 * collision suffixes, plus every explicit `<a id="…">`.
 */
export function documentAnchors(source: string): Set<string> {
	const anchors = new Set<string>();
	const seen = new Map<string, number>();
	const body = stripFencedCode(source);
	for (const line of body.split("\n")) {
		const heading = /^#{1,6}\s+(.*)$/.exec(line);
		if (heading !== null) {
			const base = githubSlug(headingText(heading[1] ?? ""));
			if (base.length === 0) continue;
			let suffix = seen.get(base) ?? 0;
			let candidate = base;
			while (anchors.has(candidate)) {
				suffix += 1;
				candidate = `${base}-${suffix}`;
			}
			seen.set(base, suffix);
			anchors.add(candidate);
		}
	}
	for (const match of body.matchAll(/<a\s+id="([^"]+)"/g)) {
		const id = match[1];
		if (id !== undefined) anchors.add(id);
	}
	return anchors;
}

/** Every destination in one document, with its one-based line. */
export function destinations(source: string): { url: string; line: number }[] {
	const body = stripFencedCode(source);
	const starts = [0];
	for (let i = 0; i < body.length; i++) if (body[i] === "\n") starts.push(i + 1);
	const lineOf = (offset: number): number => {
		let low = 0;
		let high = starts.length - 1;
		while (low < high) {
			const mid = (low + high + 1) >> 1;
			if ((starts[mid] ?? 0) <= offset) low = mid;
			else high = mid - 1;
		}
		return low + 1;
	};
	const found: { url: string; line: number }[] = [];
	for (const pattern of [INLINE_LINK, DEFINITION]) {
		pattern.lastIndex = 0;
		for (const match of body.matchAll(pattern)) {
			const url = (match[1] ?? match[2] ?? "").trim();
			if (url.length === 0) continue;
			found.push({ url, line: lineOf(match.index ?? 0) });
		}
	}
	return found.sort((a, b) => a.line - b.line);
}

/**
 * Find every broken relative link in one document.
 *
 * `read` and `exists` are injected so a caller can share one cache across a
 * whole run, and so this stays testable without touching the filesystem.
 */
export function findLinkViolations(
	sourcePath: string,
	source: string,
	scanRoot: string,
	read: (absPath: string) => string | null,
	exists: (absPath: string) => boolean,
): LinkViolation[] {
	const file = relative(scanRoot, sourcePath).split("\\").join("/");
	const dir = dirname(sourcePath);
	const violations: LinkViolation[] = [];
	const anchorsOf = (absPath: string): Set<string> => {
		const text = read(absPath);
		return text === null ? new Set() : documentAnchors(text);
	};
	for (const { url, line } of destinations(source)) {
		if (isExternalTarget(url)) continue;
		const { path, fragment } = splitDestination(url);
		const resolved = path.length === 0 ? sourcePath : resolve(dir, safeDecode(path));
		// A rendered-page link names the document it is generated from.
		const target = sourceDocumentFor(resolved);
		// Only Markdown cross-links are judged: a link to a directory, a source
		// file, or an asset carries renderer-owned semantics this gate cannot read.
		if (path.length > 0 && !target.endsWith(".md")) continue;
		if (isExampleLink(source, line)) continue;
		if (!exists(target)) {
			violations.push({ file, line, url, reason: "target" });
			continue;
		}
		if (fragment === null) continue;
		if (!anchorsOf(target).has(fragment)) {
			violations.push({ file, line, url, reason: "anchor" });
		}
	}
	return violations;
}

/** Authored Markdown sources, excluding process records that keep their history. */
export async function markdownSources(scanRoot: string = ROOT): Promise<string[]> {
	const sources: string[] = [];
	for (const pattern of SOURCE_GLOBS) {
		for await (const rel of new Glob(pattern).scan(scanRoot)) {
			const normalized = rel.split("\\").join("/");
			if (PROCESS_RECORD_PREFIXES.some(prefix => normalized.startsWith(prefix))) continue;
			sources.push(resolve(scanRoot, normalized));
		}
	}
	return sources.sort();
}

async function main(): Promise<number> {
	const sources = await markdownSources();
	const reads = new Map<string, string | null>();
	const probes = new Map<string, boolean>();
	const read = (absPath: string): string | null => {
		if (!reads.has(absPath)) {
			try {
				reads.set(absPath, readFileSync(absPath, "utf8"));
			} catch {
				reads.set(absPath, null);
			}
		}
		return reads.get(absPath) ?? null;
	};
	const exists = (absPath: string): boolean => {
		const hit = probes.get(absPath);
		if (hit !== undefined) return hit;
		const probe = read(absPath) !== null;
		probes.set(absPath, probe);
		return probe;
	};

	const violations = sources.flatMap(source =>
		findLinkViolations(source, readFileSync(source, "utf8"), ROOT, read, exists),
	);
	if (violations.length === 0) {
		console.log(`verify-md-links: ${sources.length} file(s) checked, all relative cross-links resolve.`);
		return 0;
	}
	console.error("verify-md-links: broken relative cross-links found:");
	for (const violation of violations) {
		const why = violation.reason === "target" ? "target does not exist" : "no such anchor in target";
		console.error(`  ${violation.file}:${violation.line}  ${violation.url}  (${why})`);
	}
	return 1;
}

if (import.meta.main) process.exit(await main());
