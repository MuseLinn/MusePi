// Regex works and the keys are present — so the reconcile script's dict keys
// set is fine, but the migration TABLE lookup failed for brands (they weren't
// in i18n-key-migration.json as "AI" → key because their key IS their text).
// The gate check in reconcile-baseline2 requires nk (mapped key) — for brands
// nk is undefined so `done` is false. The dictionary key text equals the
// string verbatim, so "done" should be true. Fix the resolution: also pass
// when keys.has(oldKey) directly.
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
const guiKeys = dictKeys(path.resolve(root, "packages/client-core/src/i18n/zh-CN"));
const tuiKeys = dictKeys(path.resolve(root, "packages/coding-agent/src/i18n/zh-CN"));

const resolved = new Set<string>();
const open = new Map<string, string[]>();
for (const p of baseline.pairs) {
	const parts = p.split("\u0000");
	const dict = parts[0];
	const oldKey = parts.slice(1).join("\u0000");
	const table = migration[dict.startsWith("client-core") ? "client-core" : "coding-agent"] ?? {};
	const nk = table[oldKey];
	const keys = dict.startsWith("client-core") ? guiKeys : tuiKeys;
	// Resolved when: the mapped key is in the dict, OR the string itself is a
	// dictionary key (identity entries — brand names, font descriptors).
	const done = (nk && keys.has(nk)) || keys.has(oldKey);
	if (done) resolved.add(oldKey);
	else {
		const list = open.get(oldKey) ?? [];
		list.push(dict);
		open.set(oldKey, list);
	}
}
console.log("resolved:", resolved.size);
console.log("open:", open.size);
for (const [s, dicts] of open) {
	console.log("  [" + dicts.map((d) => (d.startsWith("client") ? "G" : "T")).join("") + "] " + JSON.stringify(s.slice(0, 85)));
}
if (apply) {
	const kept = baseline.pairs.filter((p: string) => {
		const oldKey = p.split("\u0000").slice(1).join("\u0000");
		return !resolved.has(oldKey);
	});
	fs.writeFileSync(BASELINE, JSON.stringify({ ...baseline, count: kept.length, pairs: kept }, null, "\t") + "\n");
	console.log(`baseline: ${baseline.count} → ${kept.length}`);
}
