#!/usr/bin/env bun

/**
 * Guard source comments against naming the upstream projects we learned from.
 *
 * Why: the repository has a settled habit of annotating comments with the
 * project a design came from ("openchamber parity", "dsh-style"). Reading
 * references and adopting what works is a development-time activity recorded
 * in the task brief, the PR and docs/review/0.5.0-roadmap.md; a comment has no room
 * for that, and for a maintainer without the same context the name carries no
 * information. Cross-surface consistency notes (TUI vs GUI vs daemon) are a
 * different thing and stay — those are real contracts.
 *
 * Scope: comment lines of tracked TypeScript sources. Baseline counts per file
 * so the existing annotations do not fail the build, cleanup never breaks it,
 * and only a new annotation does.
 *
 * Deliberately NOT flagged:
 *   - `opencode` — mostly the `x-opencode-session` wire header and the
 *     OpenCode-compatible provider family; both are product vocabulary.
 *   - `kimi` / `kimi-code` — our own provider id and model namespace.
 *   - `omp` — our own former name, still in paths and config keys.
 *   - internal parity wording (`TUI parity`, `client-core parity`).
 *
 * usage:
 *   bun scripts/check-comment-provenance.ts            # report + fail on growth
 *   bun scripts/check-comment-provenance.ts --write    # re-record the baseline
 *   bun scripts/check-comment-provenance.ts --report   # per-file detail
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

const BASELINE_PATH = "scripts/comment-provenance-baseline.json";

/** Upstream projects whose names do not belong in a comment. Each entry is
 *  anchored so a substring cannot trip it (`zcode` must not match `zcodes`). */
const PROVENANCE_TOKENS: RegExp[] = [
	/\bdsh\b/i,
	/\bopenchamber\b/i,
	/\bopen-design\b/i,
	/\bworkdsh\b/i,
	/\bzcode\b/i,
	/\bproma\b/i,
	/\bbitfun\b/i,
	/\bkimiwork\b/i,
	/\bcraft-agents\b/i,
	/\bhermes-agent\b/i,
	/\breactbits\b/i,
	/\bkimicode\b/i,
	/\bclawd-on-desk\b/i,
];

/** A comment line, or a block-comment continuation line. */
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;

export interface CommentProvenanceHit {
	file: string;
	line: number;
	tokens: string[];
}

export interface Baseline {
	/** file path → number of annotation lines allowed. */
	counts: Record<string, number>;
}

export function collectHits(files: string[], readFile: (f: string) => string): CommentProvenanceHit[] {
	const hits: CommentProvenanceHit[] = [];
	for (const file of files) {
		let text: string;
		try {
			text = readFile(file);
		} catch {
			continue;
		}
		const lines = text.split(/\r?\n/);
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? "";
			if (!COMMENT_LINE.test(line)) continue;
			const tokens = PROVENANCE_TOKENS.filter(re => re.test(line)).map(re => re.source);
			if (tokens.length > 0) hits.push({ file, line: i + 1, tokens });
		}
	}
	return hits;
}

/** file → annotated comment line count. */
export function countByFile(hits: CommentProvenanceHit[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const hit of hits) {
		counts[hit.file] = (counts[hit.file] ?? 0) + 1;
	}
	return counts;
}

/** Tracked TypeScript sources, excluding tests and generated output. */
export function trackedSources(): string[] {
	return execFileSync("git", ["ls-files", "*.ts", "*.tsx"], {
		encoding: "utf8",
	})
		.split("\n")
		.filter(f => f && !f.includes("node_modules") && !/\.(test|spec)\./.test(f));
}

export function readBaseline(): Baseline {
	try {
		return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as Baseline;
	} catch {
		return { counts: {} };
	}
}

function main(): number {
	const argv = process.argv.slice(2);
	const write = argv.includes("--write");
	const report = argv.includes("--report");
	const files = trackedSources();
	const hits = collectHits(files, f => fs.readFileSync(f, "utf8"));
	const counts = countByFile(hits);

	if (write) {
		const sorted: Record<string, number> = {};
		for (const key of Object.keys(counts).sort()) sorted[key] = counts[key] ?? 0;
		fs.writeFileSync(BASELINE_PATH, `${JSON.stringify({ counts: sorted }, null, "\t")}\n`);
		const total = Object.values(sorted).reduce((a, b) => a + b, 0);
		console.log(`comment-provenance: recorded ${Object.keys(sorted).length} file(s), ${total} annotated line(s)`);
		return 0;
	}

	const baseline = readBaseline();
	const allowed = baseline.counts;
	const violations: { file: string; count: number; allowed: number }[] = [];
	for (const [file, count] of Object.entries(counts)) {
		const cap = allowed[file] ?? 0;
		if (count > cap) violations.push({ file, count, allowed: cap });
	}
	// A file may also disappear from the baseline while still having hits.
	for (const [file, cap] of Object.entries(allowed)) {
		if ((counts[file] ?? 0) > cap) {
			if (!violations.some(v => v.file === file)) {
				violations.push({ file, count: counts[file] ?? 0, allowed: cap });
			}
		}
	}

	const totalHits = hits.length;
	const totalAllowed = Object.values(allowed).reduce((a, b) => a + b, 0);

	if (report) {
		for (const hit of hits) {
			console.log(`  ${hit.file}:${hit.line}  ${hit.tokens.join(" ")}`);
		}
	}

	if (violations.length > 0) {
		console.error(`comment-provenance: ${violations.length} file(s) gained upstream attributions`);
		for (const v of violations.sort((a, b) => b.count - a.count)) {
			console.error(`  ${v.file}: ${v.count} annotated line(s), baseline allows ${v.allowed}`);
		}
		console.error("");
		console.error("A comment states a contract or a non-obvious reason, not where the idea came from.");
		console.error(`Name the behaviour instead. If the name is genuinely needed, record it in`);
		console.error("docs/review/0.5.0-roadmap.md and re-record the baseline with --write.");
		return 1;
	}

	console.log(
		`comment-provenance: OK — ${totalHits} annotated line(s) vs baseline ${totalAllowed}` +
			(totalHits < totalAllowed ? ` (${totalAllowed - totalHits} cleaned since the baseline)` : ""),
	);
	return 0;
}

if (import.meta.main) {
	process.exit(main());
}
