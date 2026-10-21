// Post-batch cross-quote dedup (same routine as batch 4's fix), all three files.
const fs = require("node:fs");
const KEY_DQ = /^\t"((?:[^"\\]|\\.)*)":/;
const KEY_SQ = /^\t'((?:[^'\\]|\\.)*)':/;
function unesc(raw, q) {
	return q === "'" ? raw.replace(/\\'/g, "'").replace(/\\\\/g, "\\") : JSON.parse(`"${raw}"`);
}
const files = [
	"packages/client-core/src/i18n/zh-CN/settings.ts",
	"packages/client-core/src/i18n/en-US/settings.ts",
	"packages/coding-agent/src/i18n/zh-CN/settings.ts",
];
for (const f of files) {
	const lines = fs.readFileSync(f, "utf8").split("\n");
	const firstAt = new Map();
	lines.forEach((l, i) => {
		const dq = KEY_DQ.exec(l);
		const sq = !dq && KEY_SQ.exec(l);
		const m = dq ?? sq;
		if (!m) return;
		const k = unesc(m[1], dq ? '"' : "'");
		if (!firstAt.has(k)) firstAt.set(k, i);
	});
	const skip = new Set();
	lines.forEach((l, i) => {
		const dq = KEY_DQ.exec(l);
		const sq = !dq && KEY_SQ.exec(l);
		const m = dq ?? sq;
		if (!m) return;
		const k = unesc(m[1], dq ? '"' : "'");
		if (firstAt.get(k) !== i) {
			skip.add(i);
			const next = lines[i + 1];
			if (next && /^\t{2}/.test(next)) skip.add(i + 1);
		}
	});
	if (skip.size) {
		const out = lines.filter((_, i) => !skip.has(i));
		fs.writeFileSync(f, out.join("\n"));
	}
	console.log(`${f.split("/").slice(-2).join("/")}: removed ${skip.size}`);
}
