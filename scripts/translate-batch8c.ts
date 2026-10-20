/**
 * Batch 8C: propagate the batch-8A/8B translations into the TUI dictionary.
 * The GUI (client-core) and the TUI (coding-agent) share the settings schema,
 * so both dictionaries need the same values for the same EN-text keys.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const root = process.cwd();
const apply = process.argv.includes("--apply");

// Read the translations back out of the batch scripts (single source of truth).
async function loadTranslations(file: string): Promise<Record<string, string>> {
	const src = fs.readFileSync(path.resolve(root, file), "utf8");
	const out: Record<string, string> = {};
	// The scripts use `JSON.stringify(k) + ": " + JSON.stringify(v) + ","` — the
	// translation table is a TS object literal; parse it with the runtime.
	const mod = await import(path.resolve(root, file) + "?t=" + Date.now());
	// The scripts apply on import; re-derive the map by scanning the file's
	// object literal instead (the import already wrote the GUI dictionary).
	return out;
}

// Simpler and robust: the GUI dictionary now holds the translations — copy any
// EN-text key whose GUI value differs from the key into the TUI dictionary.
const GUI_ZH = path.resolve(root, "packages/client-core/src/i18n/zh-CN/settings.ts");
const TUI_ZH = path.resolve(root, "packages/coding-agent/src/i18n/zh-CN/settings.ts");

const KEY = /^\t("(?:[^"\\]|\\.)*")\s*:\s*(.*)$/;
function parse(file: string): Map<string, string> {
	const out = new Map<string, string>();
	const lines = fs.readFileSync(file, "utf8").split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = KEY.exec(lines[i]);
		if (!m) continue;
		const key = JSON.parse(m[1]);
		let raw = m[2].trim();
		if (!raw.startsWith('"')) {
			const nm = /^\t"((?:[^"\\]|\\.)*)",?\s*$/.exec(lines[i + 1] ?? "");
			raw = nm ? '"' + nm[1] + '"' : '""';
		}
		const vm = /^"((?:[^"\\]|\\.)*)",?\s*$/.exec(raw);
		out.set(key, vm ? JSON.parse('"' + vm[1] + '"') : "");
	}
	return out;
}

const gui = parse(GUI_ZH);
// The TUI splits its dictionaries across domain files — a key may already
// exist in coding-agent/src/i18n/zh-CN/<other>.ts.
const tui = new Map<string, string>();
for (const entry of fs.readdirSync(path.resolve(root, "packages/coding-agent/src/i18n/zh-CN"))) {
	if (!entry.endsWith(".ts") || entry === "index.ts") continue;
	for (const [k, v] of parse(path.resolve(root, "packages/coding-agent/src/i18n/zh-CN", entry))) tui.set(k, v);
}
// Only the strings the TUI settings page actually renders: the gate baseline
// lists them per dictionary.
const baseline = JSON.parse(fs.readFileSync(path.resolve(root, "scripts/verify-schema-labels-i18n-baseline.json"), "utf8"));
const tuiStrings = new Set(
	baseline.pairs
		.filter((p: string) => p.startsWith("coding-agent (TUI)\u0000"))
		.map((p: string) => p.split("\u0000").slice(1).join("\u0000")),
);
console.log("TUI baseline strings:", tuiStrings.size);

const entries: Array<[string, string]> = [];
// Only the EN-TEXT keys (the schema/runtime contract) — the dotted namespace
// keys are per-package and must not cross over.
const isEnText = (k: string) => /\s/.test(k) || !/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9.]+)+$/.test(k);
for (const [key, value] of gui) {
	if (value === "" || value === key) continue; // not a translation
	if (!isEnText(key)) continue; // dotted namespace keys are per-package
	if (tui.has(key)) continue; // TUI already has the key
	if (!tuiStrings.has(key)) continue; // the TUI never renders it
	entries.push([key, value]);
}
console.log("GUI translations absent from TUI:", entries.length);

if (apply && entries.length > 0) {
	let s = fs.readFileSync(TUI_ZH, "utf8");
	const topClose = s.lastIndexOf("} as const") >= 0 ? s.lastIndexOf("} as const") : s.lastIndexOf("}");
	const lineEnd = s.lastIndexOf("\n", topClose);
	const block = entries.map(([k, v]) => "\t" + JSON.stringify(k) + ": " + JSON.stringify(v) + ",").join("\n") + "\n";
	s = s.slice(0, lineEnd) + block + s.slice(lineEnd);
	fs.writeFileSync(TUI_ZH, s);
	console.log("written " + entries.length + " entries to TUI zh");
}
if (!apply) console.log("(dry run)");
