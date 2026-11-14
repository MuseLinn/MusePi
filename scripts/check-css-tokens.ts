#!/usr/bin/env bun

/** Ensure every semantic --color-* reference resolves to a tokens.css definition. */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOTS = ["apps/desktop/src", "packages/client-core/src"];
const TOKENS_FILE = "packages/client-core/src/styles/tokens.css";

export interface CssTokenProblem {
	file: string;
	line: number;
	message: string;
}

export function definedColorTokens(source: string): Set<string> {
	const defined = new Set<string>();
	for (const match of source.matchAll(/(?:^|[{;\n])\s*(--color-[\w-]+)\s*:/gm)) {
		if (match[1]) defined.add(match[1]);
	}
	return defined;
}

export function checkCssTokens(
	files: ReadonlyArray<readonly [string, string]>,
	tokensSource: string,
): CssTokenProblem[] {
	const defined = definedColorTokens(tokensSource);
	const problems: CssTokenProblem[] = [];
	for (const [file, source] of files) {
		const lines = source.split("\n");
		lines.forEach((line, index) => {
			for (const match of line.matchAll(/var\(\s*(--color-[\w-]+)\s*[,)]/g)) {
				const token = match[1];
				if (token && !defined.has(token)) {
					problems.push({ file, line: index + 1, message: `undefined semantic color token ${token}` });
				}
			}
		});
	}
	return problems;
}

function listCssFiles(dir: string, out: string[] = []): string[] {
	for (const name of fs.readdirSync(dir)) {
		const file = path.join(dir, name);
		const stat = fs.statSync(file);
		if (stat.isDirectory()) listCssFiles(file, out);
		else if (name.endsWith(".css") && !name.endsWith(".out.css")) out.push(file);
	}
	return out;
}

export function main(): number {
	const tokensSource = fs.readFileSync(TOKENS_FILE, "utf8");
	const files: Array<readonly [string, string]> = [];
	for (const root of ROOTS) {
		for (const file of listCssFiles(root)) files.push([file, fs.readFileSync(file, "utf8")]);
	}
	const problems = checkCssTokens(files, tokensSource);
	if (problems.length > 0) {
		for (const problem of problems) console.error(`${problem.file}:${problem.line}: ${problem.message}`);
		console.error(`css-tokens: ${problems.length} undefined reference(s); define semantic colors in ${TOKENS_FILE}`);
		return 1;
	}
	console.log(`css-tokens: OK — ${files.length} stylesheets, all semantic color references defined`);
	return 0;
}

if (import.meta.main) process.exit(main());
