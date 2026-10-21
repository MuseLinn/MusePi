/**
 * CRITICAL REPAIR: the namespace migration renamed the dictionaries' keys, but
 * the settings schema lookup passes the ENGLISH SCHEMA TEXT through
 * `t(label as TranslationKey)` at runtime (SchemaSettings.tsx:198, TUI
 * settings-defs.ts:206). Pre-migration, the zh dictionaries keyed on that
 * English text; the rename broke every schema-label lookup — GUI and TUI
 * settings pages fell back to English.
 *
 * Repair: re-add the EN-text keys (the runtime contract) beside the dotted
 * keys, with the zh values recovered from the pre-migration dictionaries plus
 * the batches' translations.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const root = process.cwd();
const apply = process.argv.includes("--apply");
const MIGRATION = path.resolve(root, "scripts/i18n-key-migration.json");

// 1. Load pre-migration zh dictionaries (key = EN text → zh value).
function loadPreDict(pkg: string, domain: string): Map<string, string> {
	const out = new Map<string, string>();
	const text = execSync(`git show pre-namespace-migration:packages/${pkg}/src/i18n/zh-CN/${domain}.ts`, {
		encoding: "utf8",
		maxBuffer: 1024 * 1024 * 32,
	});
	const KEY = /^\t(["'])(.+?)\1\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')?,?$/;
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = KEY.exec(lines[i]);
		if (!m) continue;
		const key = m[2].replace(/\\'/g, "'").replace(/\\"/g, '"');
		let value = m[3] ?? m[4];
		if (value === undefined) {
			// value on the next line
			const nm = /^\t(?:["'])((?:[^"\\]|\\.)*)(?:["']),?$/.exec(lines[i + 1] ?? "");
			value = nm ? nm[1] : "";
		}
		out.set(key, value.replace(/\\'/g, "'").replace(/\\"/g, '"'));
	}
	return out;
}

const preGui = loadPreDict("client-core", "settings");
const preTui = loadPreDict("coding-agent", "settings");
console.log("pre-migration GUI zh entries:", preGui.size, " TUI zh entries:", preTui.size);

// 2. Load the gate's baseline — every schema string still outstanding.
const baseline = JSON.parse(
	fs.readFileSync(path.resolve(root, "scripts/verify-schema-labels-i18n-baseline.json"), "utf8"),
);
const byDict = new Map<string, Set<string>>();
for (const p of baseline.pairs) {
	const parts = p.split("\u0000");
	const set = byDict.get(parts[0]!) ?? new Set<string>();
	set.add(parts.slice(1).join("\u0000"));
	byDict.set(parts[0]!, set);
}

// 3. For each outstanding string, the zh value = pre-migration value, else
//    the value my batches wrote under the dotted key.
function currentZhValue(pkgDir: string, domain: string, dottedKey: string): string | null {
	const text = fs.readFileSync(path.resolve(root, pkgDir, "zh-CN", `${domain}.ts`), "utf8");
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const re = new RegExp(`^\\t["']${dottedKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']\\s*:`);
		if (re.test(lines[i])) {
			const inline = /:\s*["'](.+?)["'],?$/.exec(lines[i]);
			if (inline) return inline[1];
			const nm = /^\t(?:["'])((?:[^"\\]|\\.)*)(?:["']),?$/.exec(lines[i + 1] ?? "");
			return nm ? nm[1] : null;
		}
	}
	return null;
}

const migration: Record<string, Record<string, string>> = JSON.parse(fs.readFileSync(MIGRATION, "utf8"));

let repaired = 0;
let noValue = 0;
const report: string[] = [];
for (const [dictLabel, strings] of byDict) {
	const isGui = dictLabel.startsWith("client-core");
	const pre = isGui ? preGui : preTui;
	const table = migration[isGui ? "client-core" : "coding-agent"] ?? {};
	for (const oldKey of strings) {
		const zh = pre.get(oldKey);
		if (zh !== undefined && zh !== oldKey) {
			repaired += 1;
			continue;
		}
		const dotted = table[oldKey];
		const current = dotted
			? currentZhValue(
					isGui ? "packages/client-core/src/i18n" : "packages/coding-agent/src/i18n",
					"settings",
					dotted,
				)
			: null;
		if (current && current !== oldKey) {
			repaired += 1;
			continue;
		}
		noValue += 1;
		if (report.length < 12) report.push(`${dictLabel} | ${oldKey.slice(0, 70)}`);
	}
}
console.log("repairable (zh value known):", repaired);
console.log("no zh value found:", noValue);
for (const r of report) console.log(`  ${r}`);
