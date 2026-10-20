/**
 * WelcomeComposer TIP_KEYS: a `as const` tuple of keys read through t(tipKey).
 * Each entry is renamed individually.
 */
import { parse as parseBabel } from "@babel/parser";
import _traverse from "@babel/traverse";
import * as fs from "node:fs";
import * as path from "node:path";

const traverse = _traverse as unknown as typeof import("@babel/traverse").default;
const apply = process.argv.includes("--apply");
const file = path.resolve("packages/desktop-app/src/components/WelcomeComposer.tsx");

const raw = JSON.parse(fs.readFileSync(path.resolve("scripts/i18n-key-migration.json"), "utf8"));
const cc: Record<string, string> = raw["client-core"] ?? {};

const source = fs.readFileSync(file, "utf8");
const ast = parseBabel(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
const edits: Array<{ start: number; end: number; replacement: string }> = [];

traverse(ast, {
	ArrayExpression(path) {
		// TIP_KEYS starts with "try / for commands and @ for context".
		const first = path.node.elements[0];
		if (!first || first.type !== "StringLiteral" || first.value !== "try / for commands and @ for context") return;
		for (const el of path.node.elements) {
			if (el?.type !== "StringLiteral") continue;
			const next = cc[el.value];
			if (next && next !== el.value) {
				edits.push({ start: el.start!, end: el.end!, replacement: JSON.stringify(next) });
			}
		}
	},
});

console.log(`edits: ${edits.length}`);
if (edits.length === 0) process.exit(0);
edits.sort((a, b) => a.start - b.start);
let next = "";
let cursor = 0;
for (const e of edits) {
	next += source.slice(cursor, e.start) + e.replacement;
	cursor = e.end;
}
next += source.slice(cursor);
if (apply) {
	fs.writeFileSync(file, next);
	console.log("written");
} else {
	console.log("(dry run)");
}
