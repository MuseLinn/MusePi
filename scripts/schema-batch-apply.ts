/**
 * Shared apply step for the translation batch scripts: writes entries to both
 * dictionaries, re-baselines, and prints counts. The entry map comes from the
 * importing script.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { LOCALE_NEUTRAL, TRANSLATIONS } from "./schema-translations.ts";

const root = process.cwd();
const BASELINE = path.resolve(root, "scripts/verify-schema-labels-i18n-baseline.json");
const MIGRATION = path.resolve(root, "scripts/i18n-key-migration.json");

const DICTS: Array<{ label: string; zh: string; en: string | null }> = [
	{
		label: "client-core (GUI)",
		zh: path.resolve(root, "packages/client-core/src/i18n/zh-CN/settings.ts"),
		en: path.resolve(root, "packages/client-core/src/i18n/en-US/settings.ts"),
	},
	{
		label: "coding-agent (TUI)",
		zh: path.resolve(root, "packages/coding-agent/src/i18n/zh-CN/settings.ts"),
		en: null,
	},
];

const KEY_LINE = /^\t("[^"]+"|[A-Za-z_$][\w$]*)\s*:/;
function dictKeys(file: string): Set<string> {
	const keys = new Set<string>();
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		const m = KEY_LINE.exec(line);
		if (m) keys.add(m[1]!.replace(/^"|"$/g, ""));
	}
	return keys;
}
function insert(text: string, entries: Array<[string, string]>): string {
	const topClose = text.lastIndexOf("} as const") >= 0 ? text.lastIndexOf("} as const") : text.lastIndexOf("}");
	const lineEnd = text.lastIndexOf("\n", topClose);
	const block = `${entries.map(([k, v]) => `\t${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n")}\n`;
	return text.slice(0, lineEnd) + block + text.slice(lineEnd);
}

export function applyBatch(translations: Record<string, string>, apply: boolean): void {
	const migration: Record<string, Record<string, string>> = JSON.parse(fs.readFileSync(MIGRATION, "utf8"));
	const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
	const openByDict = new Map<string, string[]>();
	for (const p of baseline.pairs) {
		const parts = p.split("\u0000");
		const set = openByDict.get(parts[0]!) ?? [];
		set.push(parts.slice(1).join("\u0000"));
		openByDict.set(parts[0]!, set);
	}

	let translated = 0;
	const handled = new Set<string>();

	for (const dict of DICTS) {
		const strings = openByDict.get(dict.label) ?? [];
		const table = migration[dict.label.startsWith("client-core") ? "client-core" : "coding-agent"] ?? {};
		const zhKeys = dictKeys(dict.zh);
		const zhEntries: Array<[string, string]> = [];
		const enEntries: Array<[string, string]> = [];

		for (const oldKey of strings) {
			const zhValue = translations[oldKey];
			if (zhValue === undefined) continue;
			handled.add(oldKey);
			const newKey = table[oldKey] ?? oldKey;
			if (zhKeys.has(newKey)) continue;
			zhEntries.push([newKey, zhValue]);
			if (dict.en) enEntries.push([newKey, oldKey]);
			translated += dict.en ? 2 : 1;
		}

		console.log(`${dict.label}: +${zhEntries.length} zh, +${enEntries.length} en`);
		if (apply) {
			if (zhEntries.length > 0) fs.writeFileSync(dict.zh, insert(fs.readFileSync(dict.zh, "utf8"), zhEntries));
			if (dict.en && enEntries.length > 0)
				fs.writeFileSync(dict.en, insert(fs.readFileSync(dict.en, "utf8"), enEntries));
		}
	}

	if (apply) {
		const kept = baseline.pairs.filter((p: string) => {
			const oldKey = p.split("\u0000").slice(1).join("\u0000");
			return !handled.has(oldKey);
		});
		fs.writeFileSync(BASELINE, `${JSON.stringify({ ...baseline, count: kept.length, pairs: kept }, null, "\t")}\n`);
		console.log(`baseline: ${baseline.count} → ${kept.length}`);
	}
	console.log(`batch: ${translated} pair(s) translated${apply ? "" : " (dry run — pass --apply)"}`);
}

// Re-export for scripts that also need the neutral list.
export { LOCALE_NEUTRAL, TRANSLATIONS as SCHEMA_TRANSLATIONS };

void KEY_LINE;
