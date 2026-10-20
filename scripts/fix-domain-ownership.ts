// Remove ALL cross-domain duplicates my repair introduced into the settings
// domain files: any key that exists in another domain file of the same package
// belongs there, not here. Report what moved.
const fs = require("node:fs");
const path = require("node:path");

const TARGETS = [
	{ settings: "packages/client-core/src/i18n/zh-CN/settings.ts", dir: "packages/client-core/src/i18n/zh-CN" },
	{ settings: "packages/client-core/src/i18n/en-US/settings.ts", dir: "packages/client-core/src/i18n/en-US" },
	{ settings: "packages/coding-agent/src/i18n/zh-CN/settings.ts", dir: "packages/coding-agent/src/i18n/zh-CN" },
];
const KEY_LINE = /^\t["']([^"']+)["']\s*:/;

for (const t of TARGETS) {
	// Collect keys owned by OTHER domain files in the same directory.
	const others = new Map<string, string>(); // key → owning file
	for (const entry of fs.readdirSync(path.resolve(t.dir))) {
		if (!entry.endsWith(".ts") || entry === "index.ts" || entry === "settings.ts") continue;
		for (const line of fs.readFileSync(path.resolve(t.dir, entry), "utf8").split("\n")) {
			const m = KEY_LINE.exec(line);
			if (m && !others.has(m[1])) others.set(m[1], entry);
		}
	}
	const lines = fs.readFileSync(path.resolve(t.settings), "utf8").split("\n");
	const out = [];
	const removed = [];
	for (const l of lines) {
		const m = KEY_LINE.exec(l);
		if (m && others.has(m[1])) {
			removed.push(m[1] + " (" + others.get(m[1]) + ")");
			continue;
		}
		out.push(l);
	}
	fs.writeFileSync(path.resolve(t.settings), out.join("\n"));
	console.log(t.settings.split("/").slice(-2).join("/") + ": removed " + removed.length);
	for (const r of removed.slice(0, 8)) console.log("  " + r);
}
