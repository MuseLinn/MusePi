/**
 * Guard the Tailwind source globs in the renderer's stylesheet entry.
 *
 * Why this exists: `@source` paths resolve against the CSS file that declares
 * them, and a glob that matches nothing contributes nothing — it does not warn
 * and it does not fail. So both of these were wrong for as long as they were
 * committed:
 *
 *   ./src/**\/*.{ts,tsx}     -> src/styles/src/**   one level too deep
 *   ../guest-client/src/**    -> that package was renamed to client-core
 *
 * Regenerating then produced a stylesheet with zero utilities. The build still
 * exited 0 and still emitted preflight and theme, so nothing objected; only the
 * Tailwind classes stopped existing, which strips layout from the whole renderer
 * on any clean checkout. A developer's stale local artifact hid it.
 *
 * The check is deliberately narrow: every `@source` target must resolve to at
 * least one existing file. It does not try to judge whether the scan found the
 * classes you meant — that is Tailwind's job, and a token-diff gate produces
 * false positives (CSS escapes `.5` as `\.5`, variants, arbitrary values).
 *
 *   bun scripts/check-tailwind-sources.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";

export interface TailwindSourceProblem {
	/** Stylesheet that declares the @source. */
	file: string;
	/** 1-based line of the declaration. */
	line: number;
	/** The glob as written. */
	glob: string;
	message: string;
}

/**
 * Expand a `@source` glob far enough to prove it points at something.
 *
 * The glob itself is not resolved — only its fixed prefix is, which is the part
 * that goes stale when a package is renamed or a file moves. Matching a directory
 * is enough: a prefix that exists but matches no file is reported by the caller,
 * not silently accepted.
 */
function fixedPrefix(glob: string): string {
	const cut = glob.search(/[*?[{]/);
	const raw = cut === -1 ? glob : glob.slice(0, cut);
	// Drop the trailing separator the fixed prefix always ends on.
	return raw.endsWith("/") || raw.endsWith("\\") ? raw.slice(0, -1) : raw;
}

export function checkTailwindSources(
	file: string,
	source: string,
	exists: (relativeToCssFile: string) => boolean,
): TailwindSourceProblem[] {
	const problems: TailwindSourceProblem[] = [];
	const lines = source.split("\n");
	lines.forEach((text, index) => {
		const at = text.match(/^\s*@source\s+["']([^"']+)["']\s*;/);
		if (!at) return;
		const glob = at[1] as string;
		if (glob.startsWith("http://") || glob.startsWith("https://")) return;
		if (!exists(fixedPrefix(glob))) {
			problems.push({
				file,
				line: index + 1,
				glob,
				message: "matches no file",
			});
		}
	});
	return problems;
}

async function main(): Promise<void> {
	const listed = await $`git ls-files ${"*tailwind.css"}`.quiet().nothrow();
	if (listed.exitCode !== 0) throw new Error("git ls-files *tailwind.css failed");
	const files = listed
		.text()
		.split("\n")
		.map(l => l.trim())
		.filter(l => l.length > 0);

	const problems: TailwindSourceProblem[] = [];
	let declared = 0;
	for (const file of files) {
		const source = await fs.promises.readFile(path.resolve(file), "utf8");
		const cssDir = path.dirname(path.resolve(file));
		declared += (source.match(/^\s*@source\s+/gm) ?? []).length;
		problems.push(...checkTailwindSources(file, source, p => fs.existsSync(path.resolve(cssDir, p))));
	}

	if (problems.length > 0) {
		for (const p of problems) console.error(`  ${p.file}:${p.line}: @source "${p.glob}" ${p.message}`);
		console.error(
			"\ntailwind-sources: a @source that matches nothing is skipped silently, so the" +
				"\ngenerated sheet loses its utilities while the build still succeeds. Paths" +
				"\nresolve against the CSS file, not the package root.",
		);
		process.exit(1);
	}
	console.log(`tailwind-sources: OK — ${declared} @source path(s) across ${files.length} stylesheet(s) resolve`);
}

if (import.meta.main) await main();
