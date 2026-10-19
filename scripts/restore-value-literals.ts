/**
 * Restore value-position literals that the migration's literal sweeps renamed.
 *
 * Values that share their spelling with old keys — icon ids, Tone values,
 * state discriminants, protocol names — were renamed by those sweeps and must
 * go back to the bare word. Translation keys live in t() arguments (handled by
 * the AST call-site tool) and are NOT touched here.
 *
 * Reads the type-check output from stdin (one "file(line,col): error ..." per
 * line) so the working set is exactly what is currently broken.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseBabel } from "@babel/parser";
import type * as Babel from "@babel/types";
import _traverse from "@babel/traverse";
const traverse = _traverse as unknown as typeof import("@babel/traverse").default;

const root = path.resolve(import.meta.dirname, "..");
const apply = process.argv.includes("--apply");

const DOMAINS = ["settings", "tools", "guest", "agents", "general", "transcript", "commands", "shell"];
const DOMAIN_RE = new RegExp(`^(${DOMAINS.join("|")})\\.(.+)$`);

/** JSX attribute names whose value is an id/enum, not copy. */
const VALUE_ATTRS = new Set(["name", "tone", "pair", "value", "kind", "type", "icon", "mode", "status", "role"]);
/** Object property names that carry enum values. */
const VALUE_PROPS = new Set(["kind", "type", "value", "phase", "status", "tone", "role", "action", "mode", "availability", "severity"]);

/** Strip the domain prefix: "settings.close" → "close". */
function bare(text: string): string | null {
	const m = DOMAIN_RE.exec(text);
	return m ? m[2]! : null;
}

/** Files named on argv, or parsed from stdin when empty. */
function collectFiles(): string[] {
	const args = process.argv.slice(2).filter(a => !a.startsWith("--"));
	if (args.length > 0) return args.map(a => path.resolve(a));
	let stdin = "";
	try { stdin = fs.readFileSync(".tmp-error-files.txt", "utf8"); } catch { stdin = fs.readFileSync(0, "utf8"); }
	const files = new Set<string>();
	for (const line of stdin.split("\n")) {
		const line0 = line.trim();
		if (line0 === "") continue;
		const m = /^([^^(]+?)(?:\(|$)/.exec(line0);
		if (m) {
			const rel = m[1]!.trim();
			files.add(path.resolve(rel));
			if (!fs.existsSync(path.resolve(rel))) files.add(path.resolve("packages/desktop-app", rel));
		}
	}
	return [...files];
}

let restored = 0;
let filesChanged = 0;

for (const file of collectFiles()) {
	if (!fs.existsSync(file)) continue;
	const source = fs.readFileSync(file, "utf8");
	let ast: Babel.File;
	try {
		ast = parseBabel(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
	} catch {
		continue;
	}
	const edits: Array<{ start: number; end: number; replacement: string }> = [];

	traverse(ast, {
		StringLiteral(path) {
			const bareValue = bare(path.node.value);
			if (bareValue === null) return;
			const parent = path.parent;
			let restore = false;

			if (parent.type === "JSXAttribute") {
				const attr = parent.name;
				if (attr.type === "JSXIdentifier" && VALUE_ATTRS.has(attr.name)) restore = true;
			} else if (parent.type === "ObjectProperty" && parent.key.type === "Identifier") {
				if (VALUE_PROPS.has(parent.key.name)) restore = true;
			} else if (parent.type === "BinaryExpression") {
				if (parent.operator === "===" || parent.operator === "!==") restore = true;
			} else if (parent.type === "ArrayExpression" && path.parentPath?.parent.type === "JSXExpressionContainer") {
				// A StateIcon pair={["on", "off"]} — both members are ids.
				restore = true;
			} else if (parent.type === "TSTypeReference" || parent.type === "TypeAnnotation") {
				restore = false;
			}

			if (!restore) return;
			edits.push({ start: path.node.start!, end: path.node.end!, replacement: JSON.stringify(bareValue) });
		},
	});

	if (edits.length === 0) continue;
	edits.sort((a, b) => a.start - b.start);
	let next = "";
	let cursor = 0;
	for (const e of edits) {
		next += source.slice(cursor, e.start) + e.replacement;
		cursor = e.end;
	}
	next += source.slice(cursor);
	if (apply) fs.writeFileSync(file, next);
	filesChanged += 1;
	restored += edits.length;
	console.log(`${path.relative(root, file).replaceAll("\\", "/")}: ${edits.length}`);
}

console.log(`value literals ${apply ? "restored" : "to restore"}: ${restored} in ${filesChanged} file(s)`);
if (!apply) console.log("(dry run — pipe type-check output or pass files, then --apply)");
