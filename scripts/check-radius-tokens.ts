#!/usr/bin/env bun

/**
 * Guard the radius token ladder (design spec 2026-09-17, docs/gui-design.md).
 *
 * Why this exists: before the ladder landed, the two GUI packages carried
 * ELEVEN literal px radius values across ~490 declarations while six different
 * `--radius-*` names were referenced — three of which (--radius-xs/-md/-2xl,
 * 27 call sites) were never defined anywhere, silently rendering as square
 * corners. A radius is also the one property where "close enough" is visible
 * pixel-by-pixel, so the ladder only works if literals stay banned.
 *
 * Contract:
 *   - every `border-radius:` declaration must reference `var(--radius-*)`,
 *     or use one of the semantic non-ladder shapes (pill / circle / none);
 *   - every referenced `--radius-*` must be defined in tokens.css. An
 *     undefined custom property makes the whole declaration invalid at
 *     computed-value time, so `border-radius` falls back to its initial
 *     value 0 and the element renders square with no console error;
 *   - `tailwind.out.css` is build output and skipped;
 *   - tokens.css must still define all six ladder steps.
 *
 * Exit 0 when compliant, exit 1 with a per-line report otherwise.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOTS = ["apps/desktop/src", "packages/client-core/src"];
const TOKENS_FILE = "packages/client-core/src/styles/tokens.css";
const LADDER = ["--radius-xs", "--radius-sm", "--radius-md", "--radius-lg", "--radius-xl", "--radius-2xl"] as const;

/** Semantic shapes that are not part of the ladder (pill / circle / none). */
const ALLOWED_RE =
	/^(?:var\(--radius[-\w]*\)|9999px|999px|99px|50%|0|inherit|calc\(infinity \* 1px\)|0\.5px|1\.5px|0\.25rem)(?:\s+(?:var\(--radius[-\w]*\)|9999px|999px|99px|50%|0|inherit|calc\(infinity \* 1px\)|0\.5px|1\.5px|0\.25rem))*$/;

const DEFINITION_RE = /(?:^|[{;\n])\s*(--radius[\w-]*)\s*:/gm;
const REFERENCE_RE = /var\(\s*(--radius[\w-]*)\s*[,)]/g;

export interface Violation {
	file: string;
	line: number;
	value: string;
}

export interface UndefinedRef {
	file: string;
	line: number;
	token: string;
}

export interface CheckResult {
	ok: boolean;
	violations: Violation[];
	missingTokens: string[];
	undefinedRefs: UndefinedRef[];
	scanned: number;
}

function listCssFiles(dir: string, out: string[] = []): string[] {
	for (const name of fs.readdirSync(dir)) {
		const p = path.join(dir, name);
		const st = fs.statSync(p);
		if (st.isDirectory()) listCssFiles(p, out);
		// `*.out.css` is generated Tailwind output — regenerated, not authored.
		else if (name.endsWith(".css") && !name.endsWith(".out.css")) out.push(p);
	}
	return out;
}

export function definedRadiusTokens(source: string): Set<string> {
	const defined = new Set<string>();
	for (const match of source.matchAll(DEFINITION_RE)) {
		if (match[1]) defined.add(match[1]);
	}
	return defined;
}

export function checkRadiusTokens(files: ReadonlyArray<[string, string]>, tokensSource?: string): CheckResult {
	const violations: Violation[] = [];
	const references: UndefinedRef[] = [];
	for (const [file, content] of files) {
		const lines = content.split("\n");
		lines.forEach((line, i) => {
			for (const ref of line.matchAll(REFERENCE_RE)) {
				const token = ref[1];
				if (token) references.push({ file, line: i + 1, token });
			}
			const m = /border-radius:\s*([^;]+);/.exec(line);
			if (!m) return;
			const value = m[1].trim();
			if (ALLOWED_RE.test(value)) return;
			violations.push({ file, line: i + 1, value });
		});
	}
	const source = tokensSource ?? (fs.existsSync(TOKENS_FILE) ? fs.readFileSync(TOKENS_FILE, "utf8") : "");
	const defined = definedRadiusTokens(source);
	const missingTokens = LADDER.filter(t => !defined.has(t));
	const undefinedRefs = references.filter(ref => !defined.has(ref.token));
	return {
		ok: violations.length === 0 && missingTokens.length === 0 && undefinedRefs.length === 0,
		violations,
		missingTokens,
		undefinedRefs,
		scanned: files.length,
	};
}

function main(): number {
	const files: Array<[string, string]> = [];
	for (const root of ROOTS) {
		if (!fs.existsSync(root)) continue;
		for (const file of listCssFiles(root)) files.push([file, fs.readFileSync(file, "utf8")]);
	}
	const result = checkRadiusTokens(files);
	if (!result.ok) {
		if (result.violations.length > 0) {
			console.error(`radius token check FAILED (${result.violations.length} violations):`);
			for (const v of result.violations.slice(0, 40)) {
				console.error(`  ${v.file}:${v.line}  border-radius: ${v.value}`);
			}
			if (result.violations.length > 40) console.error(`  … and ${result.violations.length - 40} more`);
		}
		if (result.undefinedRefs.length > 0) {
			console.error(`undefined radius tokens (${result.undefinedRefs.length} references):`);
			for (const r of result.undefinedRefs.slice(0, 40)) {
				console.error(`  ${r.file}:${r.line}  ${r.token} is not defined in ${TOKENS_FILE}`);
			}
			if (result.undefinedRefs.length > 40) console.error(`  … and ${result.undefinedRefs.length - 40} more`);
		}
		for (const t of result.missingTokens) console.error(`  missing token definition: ${t} (${TOKENS_FILE})`);
		console.error("Use var(--radius-xs/sm/md/lg/xl/2xl) — see docs/gui-design.md for the ladder + concentric rule.");
		return 1;
	}
	console.log(`radius tokens OK — ${result.scanned} css files, 0 literal radii, every reference defined`);
	return 0;
}

if (import.meta.main) {
	process.exit(main());
}
