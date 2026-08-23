#!/usr/bin/env bun
/**
 * Verify every package under `packages/` that has a `package.json` ships a
 * `README.md`.  If a `README.md` exists, a matching `README.zh-CN.md` must
 * also exist unless the package is on the grandfather list (pre-existing
 * single-language READMEs that are allowed to lag behind translation).
 */

import * as fs from "node:fs";
import * as path from "node:path";

const PACKAGES_DIR = path.resolve("packages");

// Pre-existing packages that already had README.md but no zh-CN twin at the
// time this gate was introduced.  They must stay on this list until someone
// actually translates them — the list is the debt register.
const GRANDFATHERED = new Set([
	"agent",
	"ai",
	"browser-relay",
	"catalog",
	"coding-agent",
	"desktop-web",
	"hashline",
	"metaharness",
	"mnemopi",
	"natives",
	"omptype",
	"snapcompact",
	"stats",
	"tui",
	"utils",
	"wire",
]);

let failures = 0;
const missingReadme: string[] = [];
const missingZh: string[] = [];
const grandfathered: string[] = [];

for (const entry of fs.readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	const pkgDir = path.join(PACKAGES_DIR, entry.name);
	const pkgJson = path.join(pkgDir, "package.json");
	if (!fs.existsSync(pkgJson)) continue;

	const readme = path.join(pkgDir, "README.md");
	if (!fs.existsSync(readme)) {
		missingReadme.push(entry.name);
		failures++;
		continue;
	}

	const zh = path.join(pkgDir, "README.zh-CN.md");
	if (!fs.existsSync(zh)) {
		if (GRANDFATHERED.has(entry.name)) {
			grandfathered.push(entry.name);
		} else {
			missingZh.push(entry.name);
			failures++;
		}
	}
}

if (missingReadme.length) {
	console.error("❌ Missing README.md:");
	for (const name of missingReadme) console.error(`   packages/${name}/README.md`);
}
if (missingZh.length) {
	console.error("❌ Missing README.zh-CN.md (not grandfathered):");
	for (const name of missingZh) console.error(`   packages/${name}/README.zh-CN.md`);
}
if (grandfathered.length) {
	console.log("ℹ️  Grandfathered single-language READMEs (debt register):");
	for (const name of grandfathered) console.log(`   packages/${name}/README.md`);
}
if (!failures) {
	console.log(`✅ README gate passed (${grandfathered.length} grandfathered packages pending zh-CN translation)`);
}

process.exit(failures ? 1 : 0);
