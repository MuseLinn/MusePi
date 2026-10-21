/**
 * GENERAL-domain repair (same class as the schema repair): the pre-migration
 * zh dictionaries keyed on the ENGLISH SCHEMA/UI TEXT; the rename broke every
 * data-driven `t(enText)` lookup whose string lives in a component data object
 * (context dialog, shortcuts registry, plugin catalog, tools.format options,
 * snapcompact, update toasts, …). The settings-domain repair covered only
 * settings-schema strings. This extends the repair to the general domain —
 * and every other client-core domain — by re-adding the pre-migration EN-text
 * keys beside the dotted ones, for all client-core zh domains AND the TUI's.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const root = process.cwd();
const apply = process.argv.includes("--apply");

const KEY = /^\t(["'])(.+?)\1\s*:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')?,?$/;

function unesc(q: string, raw: string): string {
	return q === "'" ? raw.replace(/\\'/g, "'").replace(/\\\\/g, "\\") : raw.replace(/\\"/g, '"').replace(/\\n/g, "\n");
}

function loadDict(file: string): Map<string, string> {
	const out = new Map<string, string>();
	const lines = fs.readFileSync(file, "utf8").split("\n");
	for (let i = 0; i < lines.length; i++) {
		const m = KEY.exec(lines[i]);
		if (!m) continue;
		let value = m[3] ?? m[4];
		if (value === undefined) {
			const nm = /^\t(?:["'])(.+?)(?:["'])\s*,?\s*$/.exec(lines[i + 1] ?? "");
			value = nm ? nm[1] : "";
		}
		out.set(unesc(m[1], m[2]), unesc(m[1] ?? '"', value));
	}
	return out;
}

function listDomains(dir: string): string[] {
	return fs
		.readdirSync(dir)
		.filter(f => f.endsWith(".ts") && f !== "index.ts")
		.map(f => f.replace(/\.ts$/, ""));
}

// Which domains have pre-migration EN-text keys that the current (dotted)
// dictionary dropped? For each domain: keys present pre-migration whose text
// is non-dotted (contains a space or starts lowercase without a dot) AND that
// are missing from the current dictionary.
const PACKAGES = [
	{ pkg: "client-core", zhDir: "packages/client-core/src/i18n/zh-CN", enDir: "packages/client-core/src/i18n/en-US" },
	{ pkg: "coding-agent", zhDir: "packages/coding-agent/src/i18n/zh-CN", enDir: null },
];

interface Plan {
	file: string;
	entries: Array<[string, string]>;
}

for (const { pkg, zhDir, enDir } of PACKAGES) {
	for (const domain of listDomains(path.resolve(root, zhDir))) {
		const preText = (() => {
			try {
				return execSync(`git show pre-namespace-migration:packages/${pkg}/src/i18n/zh-CN/${domain}.ts`, {
					encoding: "utf8",
					maxBuffer: 1024 * 1024 * 32,
				});
			} catch {
				return null;
			}
		})();
		if (!preText) continue;
		const pre = new Map<string, string>();
		for (const line of preText.split("\n")) {
			const m = KEY.exec(line);
			if (!m) continue;
			pre.set(unesc(m[1], m[2]), unesc(m[1], m[3] ?? m[4] ?? ""));
		}
		const curFile = path.resolve(root, zhDir, `${domain}.ts`);
		const cur = loadDict(curFile);
		const missing: Array<[string, string]> = [];
		for (const [k, v] of pre) {
			if (cur.has(k)) continue;
			// Skip dotted keys (the new namespace form — already present under
			// their new names) and non-translatable ones.
			if (/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9.]+)+$/.test(k) && !k.includes(" ")) continue;
			missing.push([k, v]);
		}
		if (missing.length === 0) continue;
		console.log(`${pkg}/${domain}: ${missing.length} EN-text key(s) to restore`);
		if (apply) {
			const insertAt = (() => {
				const text = fs.readFileSync(curFile, "utf8");
				const topClose =
					text.lastIndexOf("} as const") >= 0 ? text.lastIndexOf("} as const") : text.lastIndexOf("}");
				return text.lastIndexOf("\n", topClose);
			})();
			const text = fs.readFileSync(curFile, "utf8");
			const block = `${missing.map(([k, v]) => `\t${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n")}\n`;
			fs.writeFileSync(curFile, text.slice(0, insertAt) + block + text.slice(insertAt));
		}
		// en-US: identity values for the same keys.
		if (enDir) {
			const enFile = path.resolve(root, enDir, `${domain}.ts`);
			if (fs.existsSync(enFile)) {
				const en = loadDict(enFile);
				const enMissing = missing.filter(([k]) => !en.has(k));
				if (enMissing.length > 0 && apply) {
					const text = fs.readFileSync(enFile, "utf8");
					const topClose =
						text.lastIndexOf("} as const") >= 0 ? text.lastIndexOf("} as const") : text.lastIndexOf("}");
					const insertAt = text.lastIndexOf("\n", topClose);
					const block = `${enMissing.map(([k]) => `\t${JSON.stringify(k)}: ${JSON.stringify(k)},`).join("\n")}\n`;
					fs.writeFileSync(enFile, text.slice(0, insertAt) + block + text.slice(insertAt));
					console.log(`  en-US: +${enMissing.length} identity`);
				}
			}
		}
	}
}
console.log(apply ? "repair applied" : "(dry run — pass --apply)");
