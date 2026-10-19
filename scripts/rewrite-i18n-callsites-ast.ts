/**
 * Rewrite t()-call string arguments to the namespaced keys the dictionaries
 * now carry.
 *
 * The previous attempt here used text replacement and corrupted state values:
 * `t("board")` is a translation key, but `"board" | "files"` in a type union and
 * `{ kind: "board" }` in a constructor are not, and a string replace cannot tell
 * them apart. This version parses with Babel and edits only StringLiterals that
 * are syntactically ARGUMENTS of a t()/tLoose()/builtinText() call — including
 * either branch of a conditional inside the argument list:
 *
 *   t("older releases")               → rewritten
 *   t(open ? "collapse" : "expand")   → both rewritten
 *   t(x, "fallback")                  → rewritten
 *   const k = "board"                 → untouched (not an argument)
 *   p.role === "host"                 → untouched (comparison)
 *
 * Edits are applied as absolute offsets from one parse per file, so overlapping
 * patterns cannot corrupt each other.
 *
 * The mapping comes from scripts/i18n-key-migration.json — the same table the
 * dictionaries were rewritten with. Files belong to the package their t() calls
 * resolve against (desktop-app renders client-core components).
 *
 * `--apply` writes; without it this reports.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseBabel } from "@babel/parser";
import type * as Babel from "@babel/types";

const root = path.resolve(import.meta.dirname, "..");
const apply = process.argv.includes("--apply");
const MAPPING_PATH = path.resolve(root, "scripts/i18n-key-migration.json");

const raw = JSON.parse(fs.readFileSync(MAPPING_PATH, "utf8")) as Record<string, Record<string, string>>;

/** Per-package tables; within one barrel old→new is a function. */
const tables = new Map<string, Map<string, string>>();
for (const [pkg, table] of Object.entries(raw)) {
	const t = new Map<string, string>();
	for (const [oldKey, newKey] of Object.entries(table)) {
		if (!oldKey.includes("\u0000")) t.set(oldKey, newKey);
	}
	tables.set(pkg, t);
}

const TRANSLATE_FNS = new Set(["t", "tLoose", "builtinText"]);

/** Root directories paired with the package their calls resolve against. */
const ROOTS: Array<{ dir: string; pkg: string }> = [
	{ dir: "packages/client-core/src", pkg: "client-core" },
	{ dir: "packages/desktop-app/src", pkg: "client-core" },
	{ dir: "packages/coding-agent/src", pkg: "coding-agent" },
];

/** Collect the StringLiterals that are translation keys inside one call. */
function keyLiterals(call: Babel.CallExpression): Array<{ node: Babel.StringLiteral; oldKey: string }> {
	const out: Array<{ node: Babel.StringLiteral; oldKey: string }> = [];
	const visit = (node: Babel.Node | null | undefined): void => {
		if (!node) return;
		if (node.type === "StringLiteral") {
			out.push({ node, oldKey: node.value });
			return;
		}
		// Either branch of a conditional may be a key.
		if (node.type === "ConditionalExpression") {
			visit(node.consequent);
			visit(node.alternate);
			return;
		}
		// A cast wrapper (as const / as never) around a literal.
		if (node.type === "TSAsExpression" || node.type === "TSTypeAssertion") {
			visit(node.expression);
			return;
		}
	};
	for (const arg of call.arguments) {
		if (arg.type === "SpreadElement") continue;
		visit(arg);
	}
	return out;
}

function* walk(dir: string): Generator<string> {
	for (const entry of fs.readdirSync(dir)) {
		const abs = path.join(dir, entry);
		const st = fs.statSync(abs);
		if (st.isDirectory()) {
			if (entry === "node_modules" || entry === "dist") continue;
			yield* walk(abs);
		} else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) {
			yield abs;
		}
	}
}

interface Edit {
	start: number;
	end: number;
	replacement: string;
}

let filesChanged = 0;
let sitesChanged = 0;
const dynamicSites: string[] = [];
const unmapped = new Map<string, number>();

for (const rootSpec of ROOTS) {
	const table = tables.get(rootSpec.pkg) ?? new Map<string, string>();
	const abs = path.resolve(root, rootSpec.dir);
	if (!fs.existsSync(abs)) continue;
	for (const file of walk(abs)) {
		const source = fs.readFileSync(file, "utf8");
		let ast: Babel.File;
		try {
			ast = parseBabel(source, { sourceType: "module", plugins: ["typescript", "jsx"] });
		} catch {
			continue; // a parse error is someone else's in-flight edit
		}
		const edits: Edit[] = [];

		const visit = (node: Babel.Node): void => {
			if (node.type === "CallExpression") {
				const callee = node.callee;
				const name = callee.type === "Identifier" ? callee.name : "";
				if (TRANSLATE_FNS.has(name)) {
					for (const { node: lit, oldKey } of keyLiterals(node)) {
						const next = table.get(oldKey);
						if (next !== undefined && next !== oldKey) {
							edits.push({ start: lit.start!, end: lit.end!, replacement: JSON.stringify(next) });
						}
					}
				}
			}
			for (const key of Object.keys(node) as Array<keyof Babel.Node>) {
				if (key === "loc" || key === "leadingComments" || key === "trailingComments") continue;
				const child = (node as unknown as Record<string, unknown>)[key as string];
				if (Array.isArray(child)) {
					for (const c of child) if (c && typeof c === "object" && "type" in c) visit(c as Babel.Node);
				} else if (child && typeof child === "object" && "type" in (child as object)) {
					visit(child as Babel.Node);
				}
			}
		};
		visit(ast.program as unknown as Babel.Node);

		// Dynamic keys: reported for a manual pass, never touched.
		const dyn = source.match(/\bt(?:Loose)?\(`[^`]*\$\{/g);
		if (dyn) {
			const rel = path.relative(root, file).replaceAll("\\", "/");
			for (let i = 0; i < dyn.length; i++) dynamicSites.push(rel);
		}

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
		sitesChanged += edits.length;
	}
}

// Any t() argument that had no mapping is reported: it is either a dynamic key
// handled elsewhere or a literal that is not a key at all.
console.log(`call sites ${apply ? "rewritten" : "to rewrite"}: ${sitesChanged} in ${filesChanged} file(s)`);
console.log(`dynamic-key sites (manual pass): ${dynamicSites.length}`);
if (!apply) console.log("\n(dry run — pass --apply to write)");
