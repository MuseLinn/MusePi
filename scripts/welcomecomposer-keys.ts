/**
 * WelcomeComposer final keys: the tips array is a `as const` tuple of keys read
 * through `t(PLACEHOLDER_TIPS[tipIdx]!)` / `t(tipKey)`, and two direct t() calls
 * carry the composer placeholder and the image-attachment hint. Each literal is
 * renamed individually — the file's state values (attachments, phases, icon ids)
 * are never touched.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseBabel } from "@babel/parser";

import _traverse from "@babel/traverse";
const traverse = _traverse as unknown as typeof import("@babel/traverse").default;

const apply = process.argv.includes("--apply");
const file = path.resolve("packages/desktop-app/src/components/WelcomeComposer.tsx");

const raw = JSON.parse(fs.readFileSync(path.resolve("scripts/i18n-key-migration.json"), "utf8"));
const cc: Record<string, string> = raw["client-core"] ?? {};

const source = fs.readFileSync(file, "utf8");
const ast = parseBabel(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
const edits: Array<{ start: number; end: number; replacement: string }> = [];

traverse(ast, {
	CallExpression(path) {
		const callee = path.node.callee;
		if (callee.type !== "Identifier" || callee.name !== "t") return;
		for (const arg of path.node.arguments) {
			if (arg.type === "StringLiteral") {
				const next = cc[arg.value];
				if (next && next !== arg.value) {
					edits.push({ start: arg.start!, end: arg.end!, replacement: JSON.stringify(next) });
				}
			} else if (arg.type === "TSAsExpression" || arg.type === "TSTypeAssertion") {
				const inner = arg.expression;
				if (inner.type === "StringLiteral") {
					const next = cc[inner.value];
					if (next && next !== inner.value) {
						edits.push({ start: inner.start!, end: inner.end!, replacement: JSON.stringify(next) });
					}
				}
			}
		}
	},
	// The tips tuple: only elements that are StringLiterals with a mapping.
	ArrayExpression(path) {
		// Restrict to the PLACEHOLDER_TIPS declaration by its first element.
		const first = path.node.elements[0];
		if (!first || first.type !== "StringLiteral" || first.value !== "ask anything, / for commands, @ for context…") return;
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
	console.log("(dry run — pass --apply)");
}
