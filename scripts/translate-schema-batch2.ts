/**
 * Batch 2: the mechanical unit-form strings ('N minutes', 'N KB', '~NK tokens')
 * and their Chinese equivalents. These are countable-unit labels — zh renders
 * them as 'N 分钟' etc. — fully scriptable, no semantic judgment needed.
 *
 * Also re-baselines with the correct regex so the count is accurate.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { TRANSLATIONS } from "./schema-translations.ts";

const root = process.cwd();
const apply = process.argv.includes("--apply");
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

const migration: Record<string, Record<string, string>> = JSON.parse(fs.readFileSync(MIGRATION, "utf8"));
const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));

/** Unit nouns → zh. */
const UNITS: Record<string, string> = {
	tokens: "tokens",
	KB: "KB",
	MB: "MB",
	lines: "行",
	minutes: "分钟",
	seconds: "秒",
	messages: "条消息",
	retries: "次重试",
	reminders: "次提醒",
	tasks: "个任务",
	turns: "轮",
	items: "项",
	requests: "次请求",
	hour: "小时",
};

/** '~2.5K tokens' / '120 seconds' / '1 MB' → '约2.5K tokens' / '120 秒' / '1 MB'. */
function translateUnitForm(s: string): string | null {
	const m =
		/^(~?)([\d.,]+)\s*(K|M)?\s*(tokens|KB|MB|lines|minutes|seconds|messages|retries|reminders|tasks|turns|items|requests|hours?)$/.exec(
			s.trim(),
		);
	if (!m) return null;
	const [, tilde, num, kSuffix, unit] = m;
	const zhUnit = UNITS[unit] ?? unit;
	// Token counts and byte sizes keep the Arabic numeral and K/M suffix in zh.
	if (unit === "tokens" || unit === "KB" || unit === "MB") {
		return `${tilde === "~" ? "约" : ""}${num}${kSuffix ?? ""} ${zhUnit}`;
	}
	return `${tilde === "~" ? "约" : ""}${num} ${zhUnit}`;
}

const openByDict = new Map<string, string[]>();
for (const p of baseline.pairs) {
	const parts = p.split("\u0000");
	const set = openByDict.get(parts[0]!) ?? [];
	set.push(parts.slice(1).join("\u0000"));
	openByDict.set(parts[0]!, set);
}

let translated = 0;
let neutralCount = 0;
const handled = new Set<string>();

for (const dict of DICTS) {
	const strings = openByDict.get(dict.label) ?? [];
	const table = migration[dict.label.startsWith("client-core") ? "client-core" : "coding-agent"] ?? {};
	const zhKeys = dictKeys(dict.zh);
	const zhEntries: Array<[string, string]> = [];
	const enEntries: Array<[string, string]> = [];

	for (const oldKey of strings) {
		if (handled.has(oldKey)) continue;
		// Existing batch-1 translations take priority.
		if (TRANSLATIONS[oldKey] !== undefined) {
			handled.add(oldKey);
			const newKey = table[oldKey] ?? oldKey;
			if (!zhKeys.has(newKey)) {
				zhEntries.push([newKey, TRANSLATIONS[oldKey]]);
				if (dict.en) enEntries.push([newKey, oldKey]);
			}
			continue;
		}
		// Unit-form strings get generated translations.
		const zhValue = translateUnitForm(oldKey);
		if (zhValue !== null) {
			handled.add(oldKey);
			const newKey = table[oldKey] ?? oldKey;
			if (!zhKeys.has(newKey)) {
				zhEntries.push([newKey, zhValue]);
				if (dict.en) enEntries.push([newKey, oldKey]);
			}
			translated += 1;
			continue;
		}
		// Pure numeric/percent values are locale-neutral.
		if (/^(~?[\d.,]+\s*(%|x)?|[\d.,]+)$/.test(oldKey.trim()) || oldKey.trim() === "") {
			handled.add(oldKey);
			neutralCount += 1;
		}
	}
	if (!apply) continue;
	if (zhEntries.length > 0) fs.writeFileSync(dict.zh, insert(fs.readFileSync(dict.zh, "utf8"), zhEntries));
	if (dict.en && enEntries.length > 0) fs.writeFileSync(dict.en, insert(fs.readFileSync(dict.en, "utf8"), enEntries));
}

if (apply) {
	const kept = baseline.pairs.filter((p: string) => {
		const oldKey = p.split("\u0000").slice(1).join("\u0000");
		return !handled.has(oldKey);
	});
	fs.writeFileSync(BASELINE, `${JSON.stringify({ ...baseline, count: kept.length, pairs: kept }, null, "\t")}\n`);
	console.log(`baseline: ${baseline.count} → ${kept.length}`);
}
console.log(
	`batch 2: ${translated} unit-form pair(s), ${neutralCount} neutral, ${baseline.count - (apply ? handled.size : 0)} still open after`,
);
if (!apply) console.log("(dry run — pass --apply)");
