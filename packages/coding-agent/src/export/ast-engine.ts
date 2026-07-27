/**
 * AstEngine implementation using @ast-grep/napi.
 *
 * Replaces OMP's native pi-natives astMatch with the official ast-grep npm package.
 */

import { Lang, parse, pattern } from "@ast-grep/napi";
import type { AstEngine } from "../export/ttsr.ts";

/** Map file extensions to ast-grep Lang. Falls back to undefined for unhandled languages. */
function extToLang(filePath: string): Lang | undefined {
	const ext = filePath.split(".").pop()?.toLowerCase();
	switch (ext) {
		case "ts":
		case "mts":
		case "cts":
			return Lang.TypeScript;
		case "tsx":
			return Lang.Tsx;
		case "js":
		case "mjs":
		case "cjs":
		case "jsx":
			return Lang.JavaScript;
		case "html":
		case "htm":
			return Lang.Html;
		case "css":
		case "scss":
		case "less":
			return Lang.Css;
		default:
			return undefined;
	}
}

/**
 * Ast-grep engine for TTSR AST pattern matching.
 *
 * Thread-safe (all calls are synchronous). Accepts the same ast-grep patterns
 * that OMP's pi-natives astMatch does — the @ast-grep/napi package uses the
 * same underlying tree-sitter + ast-grep-core.
 */
export class AstGrepEngine implements AstEngine {
	async matchAll(patterns: string[], source: string, lang: string): Promise<boolean> {
		const napiLang = extToLang(lang) ?? langToEnum(lang);
		if (!napiLang) return false;

		try {
			const root = parse(napiLang, source);
			for (const p of patterns) {
				const config = pattern(napiLang, p);
				const matches = root.root().findAll(config);
				if (matches.length > 0) return true;
			}
		} catch {
			// Parse errors for a malformed snippet are non-fatal
		}
		return false;
	}
}

/** Try matching a language name against known Lang enum values. */
function langToEnum(name: string): Lang | undefined {
	const lower = name.toLowerCase();
	if (lower === "typescript" || lower === "ts") return Lang.TypeScript;
	if (lower === "tsx") return Lang.Tsx;
	if (lower === "javascript" || lower === "js" || lower === "jsx") return Lang.JavaScript;
	if (lower === "html") return Lang.Html;
	if (lower === "css") return Lang.Css;
	return undefined;
}
