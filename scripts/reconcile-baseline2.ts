/**
 * Classify the 1166 remaining: are they (a) unit forms already translated by
 * batch 2's generator, (b) locale-neutral numbers, or (c) something real?
 * The gate's own check may already be satisfied for the unit forms because
 * their keys are generated (settings.1Minute etc.) — verify via migration
 * table + dictionary presence, and drop from the baseline what resolves.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const root = process.cwd();
const apply = process.argv.includes("--apply");
const BASELINE = path.resolve(root, "scripts/verify-schema-labels-i18n-baseline.json");
const MIGRATION = path.resolve(root, "scripts/i18n-key-migration.json");

const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
const migration: Record<string, Record<string, string>> = JSON.parse(fs.readFileSync(MIGRATION, "utf8"));
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
const tables: Array<{ dict: string; gui: boolean; keys: Set<string> }> = [
	{ dict: "client-core (GUI)", gui: true, keys: dictKeys(path.resolve(root, "packages/client-core/src/i18n/zh-CN")) },
	{
		dict: "coding-agent (TUI)",
		gui: false,
		keys: dictKeys(path.resolve(root, "packages/coding-agent/src/i18n/zh-CN")),
	},
];

// Unit-form generator (same as batch 2).
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
	hours: "小时",
};
function unitKeyTail(s: string): string | null {
	const m =
		/^(~?)([\d.,]+)\s*(K|M)?\s*(tokens|KB|MB|lines|minutes|seconds|messages|retries|reminders|tasks|turns|items|requests|hours?)$/.exec(
			s.trim(),
		);
	if (!m) return null;
	return null; // translation handled in batch 2 — here we only need the shape
}
function isUnitForm(s: string): boolean {
	return /^(~?)([\d.,]+)\s*(K|M)?\s*(tokens|KB|MB|lines|minutes|seconds|messages|retries|reminders|tasks|turns|items|requests|hours?|lines)$/.test(
		s.trim(),
	);
}
function isNumber(s: string): boolean {
	return /^[~\d.,%\s+x]+$/.test(s.trim()) && /\d/.test(s.trim());
}

const resolved = new Set<string>();
const open = new Map<string, string[]>(); // string → dicts
for (const p of baseline.pairs) {
	const parts = p.split("\u0000");
	const dict = parts[0];
	const oldKey = parts.slice(1).join("\u0000");
	const table = migration[dict.startsWith("client-core") ? "client-core" : "coding-agent"] ?? {};
	const nk = table[oldKey];
	const keys = (dict.startsWith("client-core") ? tables[0] : tables[1]).keys;
	const done = nk ? keys.has(nk) : false;
	if (done) {
		resolved.add(oldKey);
	} else if (isNumber(oldKey)) {
		resolved.add(oldKey); // locale-neutral: no entry needed
	} else if (isUnitForm(oldKey)) {
		resolved.add(oldKey); // unit forms carry generated keys from batch 2
	} else {
		const list = open.get(oldKey) ?? [];
		list.push(dict);
		open.set(oldKey, list);
	}
}
console.log("resolved (translated/neutral/unit-form):", resolved.size);
console.log("genuinely open:", open.size);
const sorted = [...open.keys()].sort((a, b) => a.length - b.length);
for (const s of sorted.slice(0, 30))
	console.log(
		"  [" +
			open
				.get(s)!
				.map(d => (d.startsWith("client") ? "G" : "T"))
				.join("") +
			"] " +
			JSON.stringify(s.slice(0, 80)),
	);

if (apply) {
	const kept = baseline.pairs.filter((p: string) => {
		const oldKey = p.split("\u0000").slice(1).join("\u0000");
		return !resolved.has(oldKey);
	});
	fs.writeFileSync(BASELINE, `${JSON.stringify({ ...baseline, count: kept.length, pairs: kept }, null, "\t")}\n`);
	console.log(`baseline: ${baseline.count} → ${kept.length}`);
}
