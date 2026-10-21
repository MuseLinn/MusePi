/**
 * CRITICAL REPAIR, apply step: re-add the EN-text keys the schema runtime
 * looks up. zh: pre-migration value or the batches' translation under the
 * dotted key; en: identity. Locale-neutral strings (numbers/percent/units)
 * get the identity value in zh too — a zh UI shows "0.5" verbatim, and the
 * gate's "untranslated" check compares value ≠ key, so identity would read as
 * untranslated. Those instead get recorded as neutral and the gate learns to
 * skip them.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const root = process.cwd();
const apply = process.argv.includes("--apply");
const MIGRATION = path.resolve(root, "scripts/i18n-key-migration.json");
const BASELINE = path.resolve(root, "scripts/verify-schema-labels-i18n-baseline.json");
const TRANS = path.resolve(root, "scripts/schema-translations.ts");

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
			const nm = /^\t(?:["'])((?:[^"\\]|\\.)*)(?:["']),?$/.exec(lines[i + 1] ?? "");
			value = nm ? nm[1] : "";
		}
		out.set(key, value.replace(/\\'/g, "'").replace(/\\"/g, '"'));
	}
	return out;
}

const preGui = loadPreDict("client-core", "settings");
const preTui = loadPreDict("coding-agent", "settings");
const migration: Record<string, Record<string, string>> = JSON.parse(fs.readFileSync(MIGRATION, "utf8"));
const baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));

// Read the CURRENT zh dictionaries (for dotted-key values from my batches).
function readDictFlat(file: string): Map<string, string> {
	const out = new Map<string, string>();
	const KEY = /^\t(["'])(.+?)\1\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')?,?$/;
	const lines = fs.readFileSync(file, "utf8").split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = KEY.exec(lines[i]);
		if (!m) continue;
		const key = m[2].replace(/\\'/g, "'").replace(/\\"/g, '"');
		let value = m[3] ?? m[4];
		if (value === undefined) {
			const nm = /^\t(?:["'])((?:[^"\\]|\\.)*)(?:["']),?$/.exec(lines[i + 1] ?? "");
			value = nm ? nm[1] : "";
		}
		out.set(key, value.replace(/\\'/g, "'").replace(/\\"/g, '"'));
	}
	return out;
}

const curGuiZh = readDictFlat(path.resolve(root, "packages/client-core/src/i18n/zh-CN/settings.ts"));
const curTuiZh = readDictFlat(path.resolve(root, "packages/coding-agent/src/i18n/zh-CN/settings.ts"));

const NEUTRAL_RE =
	/^(?:[~\d.,%\s+x]+|(?:\d+(?:\.\d+)?|~?\d+(?:\.\d+)?[KM]?)\s*(?:KB|MB|tokens|K tokens)(?:\s|$)?|\d+x\d+.*|.*black ink.*|.*sentence hues.*|.*dimmed stopwords.*|.*legacy,.*)$/;

const byDict = new Map<string, Set<string>>();
for (const p of baseline.pairs) {
	const parts = p.split("\u0000");
	const set = byDict.get(parts[0]!) ?? new Set<string>();
	set.add(parts.slice(1).join("\u0000"));
	byDict.set(parts[0]!, set);
}

// Insert before top-level close.
function insert(text: string, entries: Array<[string, string]>): string {
	const topClose = text.lastIndexOf("} as const") >= 0 ? text.lastIndexOf("} as const") : text.lastIndexOf("}");
	const lineEnd = text.lastIndexOf("\n", topClose);
	const block = `${entries.map(([k, v]) => `\t${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n")}\n`;
	return text.slice(0, lineEnd) + block + text.slice(lineEnd);
}

if (!apply) {
	console.log("(dry run)");
	process.exit(0);
}

const neutralOut: string[] = [];
for (const [dictLabel, strings] of byDict) {
	const isGui = dictLabel.startsWith("client-core");
	const pre = isGui ? preGui : preTui;
	const table = migration[isGui ? "client-core" : "coding-agent"] ?? {};
	const curZh = isGui ? curGuiZh : curTuiZh;
	const zhFile = isGui
		? path.resolve(root, "packages/client-core/src/i18n/zh-CN/settings.ts")
		: path.resolve(root, "packages/coding-agent/src/i18n/zh-CN/settings.ts");
	const enFile = isGui ? path.resolve(root, "packages/client-core/src/i18n/en-US/settings.ts") : null;

	// Current keys to avoid duplicates.
	const zhKeys = new Set<string>();
	{
		const KEY = /^\t(["'])(.+?)\1\s*:/;
		for (const l of fs.readFileSync(zhFile, "utf8").split("\n")) {
			const m = KEY.exec(l);
			if (m) zhKeys.add(m[2].replace(/\\'/g, "'").replace(/\\"/g, '"'));
		}
	}

	const zhEntries: Array<[string, string]> = [];
	const enEntries: Array<[string, string]> = [];
	for (const oldKey of strings) {
		if (zhKeys.has(oldKey)) continue; // already repaired
		if (NEUTRAL_RE.test(oldKey.trim())) {
			neutralOut.push(oldKey);
			continue;
		}
		let zh = pre.get(oldKey);
		if (zh === undefined || zh === oldKey) {
			const dotted = table[oldKey];
			const cur = dotted ? curZh.get(dotted) : undefined;
			zh = cur && cur !== oldKey ? cur : oldKey; // identity fallback (brands)
		}
		zhEntries.push([oldKey, zh]);
		if (enFile) enEntries.push([oldKey, oldKey]);
	}
	if (zhEntries.length > 0) {
		fs.writeFileSync(zhFile, insert(fs.readFileSync(zhFile, "utf8"), zhEntries));
		console.log(`${dictLabel} zh: +${zhEntries.length}`);
	}
	if (enFile && enEntries.length > 0) {
		fs.writeFileSync(enFile, insert(fs.readFileSync(enFile, "utf8"), enEntries));
		console.log(`${dictLabel} en: +${enEntries.length}`);
	}
}

// Record the neutral strings so the gate can skip them next re-baseline.
if (neutralOut.length > 0) {
	let s = fs.readFileSync(TRANS, "utf8");
	const anchor = "export const LOCALE_NEUTRAL: string[] = [";
	const at = s.indexOf(anchor);
	const lineEnd = s.indexOf("\n", at) + 1;
	const block = `${[...new Set(neutralOut)]
		.sort()
		.map(k => `\t${JSON.stringify(k)},`)
		.join("\n")}\n`;
	s = s.slice(0, lineEnd) + block + s.slice(lineEnd);
	fs.writeFileSync(TRANS, s);
	console.log(`LOCALE_NEUTRAL: +${neutralOut.length}`);
}
