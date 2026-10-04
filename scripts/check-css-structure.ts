/**
 * Guard tracked CSS against the structural break the rest of the toolchain
 * waves through.
 *
 * Why this exists: neither biome nor `bun build` rejects a stylesheet with an
 * unclosed block. Biome does not lint CSS at all (`Checked 0 files`), and Bun's
 * CSS pipeline recovered from a file missing two closing braces and still
 * reported success with exit 0. Browsers recover too — they close the block when
 * they meet the next at-rule — so the production Electron build rendered a
 * half-applied stylesheet for as long as the defect was there.
 *
 * The only strict parser in the tree is the PostCSS that Vite runs, and that is
 * a transitive dependency of the dev server rather than something the repo
 * depends on. So this check does the one thing that reliably catches the failure
 * mode: it counts blocks. A missing or extra brace is reported with the line of
 * the opening brace that never closed.
 *
 * What it does NOT do: validate declarations, at-rule preludes, or values. It is
 * a brace check, not a CSS parser. Anything subtler needs a real parser, and a
 * silently-passing check is worse than none.
 *
 *   bun scripts/check-css-structure.ts
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

export interface CssStructureProblem {
	/** Repo-relative path of the offending stylesheet. */
	file: string;
	/** 1-based line of an opening brace that never closed, or of a stray close. */
	line: number;
	message: string;
}

/**
 * Strip comments and quoted strings, then report unbalanced blocks.
 *
 * Comments and strings are removed rather than counted because both legitimately
 * contain braces: `content: "}"` and `/* } *\/` are both legal CSS. Counting
 * them would report a defect that is not there.
 */
export function checkCssStructure(file: string, source: string): CssStructureProblem[] {
	const problems: CssStructureProblem[] = [];
	const open: number[] = [];
	let depth = 0;
	let line = 1;
	let inComment = false;
	let quote: string | null = null;

	for (let i = 0; i < source.length; i++) {
		const ch = source[i] as string;
		const next = source[i + 1];
		if (ch === "\n") line++;
		if (inComment) {
			if (ch === "*" && next === "/") {
				inComment = false;
				i++;
			}
			continue;
		}
		if (quote) {
			if (ch === "\\") i++;
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === "/" && next === "*") {
			inComment = true;
			i++;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === "{") {
			if (depth === 0) open.push(line);
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth < 0) {
				problems.push({
					file,
					line,
					message: "closing brace with no opening brace",
				});
				depth = 0;
				open.length = 0;
			} else if (depth === 0) {
				open.length = 0;
			}
		}
	}
	// Whatever is still open never closed. Report the outermost first: it is the
	// construct a reader has to fix, and the inner ones are usually its children.
	for (const start of open) {
		problems.push({ file, line: start, message: "opening brace never closed" });
	}
	return problems;
}

async function main(): Promise<void> {
	// Interpolated rather than inline: Bun Shell globs an inline `*.css` itself
	// and fails before git ever sees it.
	const listed = await $`git ls-files ${"*.css"}`.quiet().nothrow();
	if (listed.exitCode !== 0) throw new Error("git ls-files *.css failed");
	const files = listed
		.text()
		.split("\n")
		.map(l => l.trim())
		.filter(l => l.length > 0);

	const problems: CssStructureProblem[] = [];
	for (const file of files) {
		const source = await fs.readFile(path.resolve(file), "utf8");
		problems.push(...checkCssStructure(file, source));
	}

	if (problems.length > 0) {
		for (const p of problems) console.error(`  ${p.file}:${p.line}: ${p.message}`);
		console.error(
			`\ncss-structure: ${problems.length} problem(s) across ${files.length} stylesheet(s).` +
				"\nAn unclosed block is silently tolerated by browsers and by `bun build`, so the" +
				"\nstylesheet half-applies in production while the Vite dev server refuses to load it.",
		);
		process.exit(1);
	}
	console.log(`css-structure: OK — ${files.length} stylesheet(s) balanced`);
}

if (import.meta.main) await main();
