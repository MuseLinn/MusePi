// ============================================================
// MusePi LSP — pure helpers: URI conversion, language ids, diagnostic
// sorting/formatting, hover text extraction, symbol tree rendering.
// No process handles, no fs — string in, string out.
// ============================================================

import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import type {
	LspDiagnostic,
	LspDiagnosticSeverity,
	LspDocumentSymbol,
	LspHover,
	LspLocation,
	LspLocationLink,
	LspMarkedString,
	LspSymbolInformation,
} from "./types.ts";

// =============================================================================
// URI handling (cross-platform)
// =============================================================================

export function fileToUri(filePath: string): string {
	return pathToFileURL(path.resolve(filePath)).href;
}

/** Tolerates both percent-encoded URIs and lax servers that send raw paths. */
export function uriToFile(uri: string): string {
	if (!uri.startsWith("file://")) return uri;
	try {
		return fileURLToPath(uri);
	} catch {
		let filePath = uri.slice(7);
		try {
			filePath = decodeURIComponent(filePath);
		} catch {
			// Invalid percent-encoding — treat as a literal path.
		}
		if (process.platform === "win32" && filePath.startsWith("/") && /^[A-Za-z]:/.test(filePath.slice(1))) {
			filePath = filePath.slice(1);
		}
		return filePath;
	}
}

// =============================================================================
// Language id detection
// =============================================================================

const LANGUAGE_IDS: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescriptreact",
	".mts": "typescript",
	".cts": "typescript",
	".js": "javascript",
	".jsx": "javascriptreact",
	".mjs": "javascript",
	".cjs": "javascript",
	".py": "python",
	".pyi": "python",
	".go": "go",
	".rs": "rust",
	".c": "c",
	".h": "c",
	".cpp": "cpp",
	".cc": "cpp",
	".cxx": "cpp",
	".hpp": "cpp",
	".java": "java",
	".kt": "kotlin",
	".kts": "kotlin",
	".rb": "ruby",
	".lua": "lua",
	".sh": "shellscript",
	".bash": "shellscript",
	".zsh": "shellscript",
	".json": "json",
	".jsonc": "jsonc",
	".html": "html",
	".htm": "html",
	".css": "css",
	".scss": "scss",
	".less": "less",
	".md": "markdown",
	".yaml": "yaml",
	".yml": "yaml",
	".vue": "vue",
	".svelte": "svelte",
	".php": "php",
	".cs": "csharp",
	".swift": "swift",
	".zig": "zig",
	".lua5": "lua",
	".nix": "nix",
	".dart": "dart",
	".tf": "terraform",
	".prisma": "prisma",
	".graphql": "graphql",
	".gql": "graphql",
	".tex": "latex",
	".vim": "vim",
};

export function detectLanguageId(filePath: string): string {
	return LANGUAGE_IDS[path.extname(filePath).toLowerCase()] ?? "plaintext";
}

// =============================================================================
// Diagnostic formatting
// =============================================================================

const SEVERITY_NAMES: Record<number, string> = { 1: "error", 2: "warning", 3: "info", 4: "hint" };

export function severityToString(severity?: LspDiagnosticSeverity): string {
	return SEVERITY_NAMES[severity ?? 1] ?? "unknown";
}

/** Sort by severity (errors first), then line, column, message. */
export function sortDiagnostics(diagnostics: LspDiagnostic[]): LspDiagnostic[] {
	return [...diagnostics].sort((a, b) => {
		const sev = (a.severity ?? 1) - (b.severity ?? 1);
		if (sev !== 0) return sev;
		if (a.range.start.line !== b.range.start.line) return a.range.start.line - b.range.start.line;
		if (a.range.start.character !== b.range.start.character) return a.range.start.character - b.range.start.character;
		return a.message.localeCompare(b.message);
	});
}

/** Collapse server-side whitespace noise (newlines, runs of spaces) inside messages. */
function stripDiagnosticNoise(message: string): string {
	return message.replace(/\s*\n\s*/g, " ").replace(/ {2,}/g, " ").trim();
}

/** One-line model-facing diagnostic: `path:line:col [severity] [source] message (code)`. */
export function formatDiagnostic(diagnostic: LspDiagnostic, filePath: string): string {
	const severity = severityToString(diagnostic.severity);
	const line = diagnostic.range.start.line + 1;
	const col = diagnostic.range.start.character + 1;
	const source = diagnostic.source ? `[${diagnostic.source}] ` : "";
	const code = diagnostic.code !== undefined ? ` (${String(diagnostic.code)})` : "";
	return `${filePath}:${line}:${col} [${severity}] ${source}${stripDiagnosticNoise(diagnostic.message)}${code}`;
}

/** Identity used for dedupe: everything except the location prefix. */
export function diagnosticLineIdentity(formatted: string): string {
	return formatted.replace(/^.*?:\d+:\d+\s+/, "");
}

/** Dedupe formatted lines that repeat the same location + message (multi-server overlap). */
export function dedupeFormattedDiagnostics(lines: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const line of lines) {
		if (seen.has(line)) continue;
		seen.add(line);
		out.push(line);
	}
	return out;
}

export function summarizeDiagnosticMessages(messages: string[]): { summary: string; errored: boolean } {
	const counts = { error: 0, warning: 0, info: 0, hint: 0 };
	for (const message of messages) {
		const match = message.match(/\[(error|warning|info|hint)\]/i);
		if (!match) continue;
		counts[match[1].toLowerCase() as keyof typeof counts] += 1;
	}
	const parts: string[] = [];
	if (counts.error > 0) parts.push(`${counts.error} error(s)`);
	if (counts.warning > 0) parts.push(`${counts.warning} warning(s)`);
	if (counts.info > 0) parts.push(`${counts.info} info(s)`);
	if (counts.hint > 0) parts.push(`${counts.hint} hint(s)`);
	return { summary: parts.length > 0 ? parts.join(", ") : "no issues", errored: counts.error > 0 };
}

// =============================================================================
// Location / hover / symbol formatting
// =============================================================================

export function formatLocation(location: LspLocation, cwd: string): string {
	const file = path.relative(cwd, uriToFile(location.uri)) || path.basename(uriToFile(location.uri));
	return `${file}:${location.range.start.line + 1}:${location.range.start.character + 1}`;
}

/** Normalize definition/references results: Location | Location[] | LocationLink | LocationLink[] | null. */
export function normalizeLocations(
	result: LspLocation | LspLocation[] | LspLocationLink | LspLocationLink[] | null | undefined,
): LspLocation[] {
	if (!result) return [];
	const raw = Array.isArray(result) ? result : [result];
	const out: LspLocation[] = [];
	for (const entry of raw) {
		if (!entry) continue;
		if ("targetUri" in entry) {
			out.push({ uri: entry.targetUri, range: entry.targetSelectionRange ?? entry.targetRange });
		} else if ("uri" in entry && "range" in entry) {
			out.push(entry);
		}
	}
	return out;
}

function markedStringText(part: LspMarkedString): string {
	return typeof part === "string" ? part : part.value;
}

/** Extract plain model-facing text from a hover result. */
export function extractHoverText(hover: LspHover | null | undefined): string {
	if (!hover) return "";
	const contents = hover.contents;
	if (typeof contents === "string") return contents.trim();
	if (Array.isArray(contents)) {
		return contents
			.map(markedStringText)
			.filter((s) => s.trim().length > 0)
			.join("\n\n")
			.trim();
	}
	if ("value" in contents && typeof contents.value === "string") return contents.value.trim();
	return "";
}

const SYMBOL_KIND_NAMES: Record<number, string> = {
	1: "File",
	2: "Module",
	3: "Namespace",
	4: "Package",
	5: "Class",
	6: "Method",
	7: "Property",
	8: "Field",
	9: "Constructor",
	10: "Enum",
	11: "Interface",
	12: "Function",
	13: "Variable",
	14: "Constant",
	15: "String",
	16: "Number",
	17: "Boolean",
	18: "Array",
	19: "Object",
	20: "Key",
	21: "Null",
	22: "EnumMember",
	23: "Struct",
	24: "Event",
	25: "Operator",
	26: "TypeParameter",
};

export function symbolKindToName(kind: number): string {
	return SYMBOL_KIND_NAMES[kind] ?? `Symbol(${String(kind)})`;
}

/** Hierarchical DocumentSymbol tree, indented two spaces per level. */
export function formatDocumentSymbols(symbols: LspDocumentSymbol[], indent = 0): string[] {
	const lines: string[] = [];
	for (const symbol of symbols) {
		const pad = "  ".repeat(indent);
		const detail = symbol.detail ? ` — ${symbol.detail.split("\n")[0]}` : "";
		lines.push(`${pad}${symbolKindToName(symbol.kind)} ${symbol.name} (line ${symbol.range.start.line + 1})${detail}`);
		if (symbol.children) lines.push(...formatDocumentSymbols(symbol.children, indent + 1));
	}
	return lines;
}

/** Flat SymbolInformation list (legacy servers). */
export function formatSymbolInformations(symbols: LspSymbolInformation[], cwd: string): string[] {
	return symbols.map(
		(symbol) => `${symbolKindToName(symbol.kind)} ${symbol.name} (${formatLocation(symbol.location, cwd)})`,
	);
}
