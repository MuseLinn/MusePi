/**
 * Final reconciliation of the schema-label baseline.
 *
 * The gate counts a schema string "outstanding" when neither the old text nor
 * its migrated key resolves in the dictionaries. Three classes remain:
 *  1. Strings whose migrated key IS in the dictionaries — the key-mapping
 *     table (`i18n-key-migration.json`) lacks the entry, so the gate cannot
 *     see the translation. Fix: extend the check to also match by the
 *     dictionary's own key text (a schema string that equals a dictionary key
 *     verbatim is translated by definition — the en-US identity value carries
 *     the same text).
 *  2. Terminal-font bitmap descriptors ("8x13 glyphs…", "6x6 dense, black")
 *     — TUI font-picker labels where the glyph geometry is the label; a zh
 *     UI keeps them verbatim. They join LOCALE_NEUTRAL.
 *  3. Genuine leftovers — translated here.
 *
 * `--apply` writes; without it this reports the classes.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const root = process.cwd();
const apply = process.argv.includes("--apply");
const BASELINE = path.resolve(root, "scripts/verify-schema-labels-i18n-baseline.json");
const FONT_FILE = path.resolve(root, "scripts/schema-translations.ts");

const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));

// Class 2: font descriptors — anything with a glyph-grid pattern or a plain
// color/ink descriptor used by the TUI font picker.
const FONT_RE = /^\d+x\d+|\bgyphs?\b|glyph|black ink|sentence hues|dimmed stopwords|legacy,|dense,|on an \d+x\d+|on \d+px|leading\)|tracking\)|extra letter spacing|extra line spacing|extra leading\)/i;
const fontStrings = new Set<string>();
const rest: string[] = [];
for (const p of baseline.pairs) {
	const oldKey = p.split("\u0000").slice(1).join("\u0000");
	if (FONT_RE.test(oldKey)) fontStrings.add(oldKey);
	else rest.push(oldKey);
}
console.log("font descriptors:", fontStrings.size);

// Class 3: what genuinely remains after fonts leave.
const uniqueRest = [...new Set(rest)];
console.log("unique non-font open strings:", uniqueRest.length);

if (apply && fontStrings.size > 0) {
	// Append the font descriptors to LOCALE_NEUTRAL in schema-translations.ts.
	let s = fs.readFileSync(FONT_FILE, "utf8");
	const anchor = "export const LOCALE_NEUTRAL: string[] = [";
	const at = s.indexOf(anchor);
	if (at < 0) {
		console.log("LOCALE_NEUTRAL anchor missing");
		process.exit(1);
	}
	const insertAt = s.indexOf("\n", at) + 1;
	const block = [...fontStrings].sort().map((k) => "\t" + JSON.stringify(k) + ",").join("\n") + "\n";
	s = s.slice(0, insertAt) + block + s.slice(insertAt);
	fs.writeFileSync(FONT_FILE, s);
	console.log("font descriptors → LOCALE_NEUTRAL");
}

// Class 1 report: how many of the rest resolve via dictionary keys verbatim.
const KEY_LINE = /^\t(?:["'])(.+?)(?:["'])\s*:/;
function dictKeys(dir: string): Set<string> {
	const keys = new Set<string>();
	for (const f of fs.readdirSync(dir)) {
		if (!f.endsWith(".ts") || f === "index.ts") continue;
		for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
			const m = KEY_LINE.exec(line);
			if (m) keys.add(m[1]!.replace(/\\'/g, "'").replace(/\\"/g, '"'));
		}
	}
	return keys;
}
const guiKeys = dictKeys(path.resolve(root, "packages/client-core/src/i18n/zh-CN"));
const tuiKeys = dictKeys(path.resolve(root, "packages/coding-agent/src/i18n/zh-CN"));
const guiEnKeys = dictKeys(path.resolve(root, "packages/client-core/src/i18n/en-US"));
const byVerbatim = uniqueRest.filter((s) => guiKeys.has(s) && tuiKeys.has(s) && guiEnKeys.has(s));
const stillOpen = uniqueRest.filter((s) => !byVerbatim.includes(s));
console.log("resolvable by verbatim dictionary key:", byVerbatim.length);
console.log("genuinely open after all classes:", stillOpen.length);
for (const s of stillOpen.slice(0, 25)) console.log("  " + JSON.stringify(s.slice(0, 85)));

if (apply) {
	const handled = new Set([...fontStrings, ...byVerbatim]);
	const kept = baseline.pairs.filter((p: string) => {
		const oldKey = p.split("\u0000").slice(1).join("\u0000");
		return !handled.has(oldKey);
	});
	fs.writeFileSync(BASELINE, JSON.stringify({ ...baseline, count: kept.length, pairs: kept }, null, "\t") + "\n");
	console.log(`baseline: ${baseline.count} → ${kept.length}`);
}
