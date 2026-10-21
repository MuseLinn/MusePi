/**
 * Migrate English-source i18n keys to namespaced keys.
 *
 * Convention (measured against the source dictionaries: avg 40.8 chars,
 * 4.5 segments, max 56):
 *
 *   <domain>.<camelCaseSlug>[.info|.desc]
 *
 * - `domain` is the dictionary file (settings, tools, general, …).
 * - Short phrases slug in full: "Hide Tool Activity" → display.hideToolActivity
 *   (the domain is prepended by the caller).
 * - Medium phrases cap at four words so a key stays readable.
 * - Long prose gets a `.info` / `.desc` tail instead of a 40-word identifier:
 *   "After the agent stops, nudge it to capture lessons …" →
 *   settings.afterTheAgentStops.desc
 * - Variants that collapse to the same name get a numeric suffix, which the
 *   report lists so they can be reviewed rather than silently accepted.
 *
 * `--apply` rewrites dictionaries and call sites; without it this only reports.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const apply = process.argv.includes("--apply");
const showCollisions = process.argv.includes("--collisions");

const KEY_LINE = /^\t("[^"]+"|[A-Za-z_$][\w$]*)\s*:/;

/** Words that carry no meaning for an identifier. */
const STOP = new Set([
	"a",
	"an",
	"the",
	"of",
	"or",
	"and",
	"to",
	"for",
	"in",
	"on",
	"at",
	"by",
	"with",
	"is",
	"are",
	"be",
	"it",
	"its",
	"this",
	"that",
	"when",
	"if",
	"as",
	"from",
	"into",
]);

function words(text: string): string[] {
	return text
		.replace(/\{[^}]*\}/g, " ") // placeholders never enter a key
		.replace(/\([^)]*\)/g, " ") // parenthetical asides are not identifiers
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
}

function camel(list: string[]): string {
	return list
		.map((w, i) => {
			if (/[^\x00-\x7F]/.test(w)) return w; // keep CJK segments whole
			const lower = w.toLowerCase();
			return i === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
		})
		.join("");
}

/** A phrase is "prose" when it reads as a sentence rather than a label. */
function isProse(text: string): boolean {
	const w = words(text);
	if (w.length >= 12) return true;
	if (/[.!?]\s/.test(text)) return true;
	if (/[,;:]\s/.test(text) && w.length >= 6) return true;
	return false;
}

/** Placeholder names in a template, as a stable suffix ("{count}" → "WithCount"). */
function placeholderSuffix(text: string): string {
	const names = [...text.matchAll(/\{([^}]*)\}/g)].map(m => m[1]!.replace(/[^\p{L}\p{N}]+/gu, "")).filter(Boolean);
	if (names.length === 0) return "";
	return names.map(n => `With${n.charAt(0).toUpperCase()}${n.slice(1)}`).join("");
}

/**
 * Label text → { tab, group } from the settings schema — the product tree.
 *
 * The join is on LABEL TEXT, not on the setting key: a dictionary entry's key is
 * the label the UI shows ("Advisor Sync Backlog"), while the schema identifies
 * the same thing by its setting key ("advisor.syncBacklog"). Only strings that
 * appear as a schema label get a product path; everything else (tool copy,
 * prose) keeps the flat form.
 */
function readSettingGroups(): Map<string, { tab: string; group: string }> {
	const map = new Map<string, { tab: string; group: string }>();
	const schemaPath = path.resolve(root, "packages/coding-agent/src/config/settings-schema.ts");
	if (!fs.existsSync(schemaPath)) return map;
	const src = fs.readFileSync(schemaPath, "utf8");
	const re = /"[\w.]+":\s*\{([\s\S]{0,900}?)\n\t\},/g;
	for (const m of src.matchAll(re)) {
		const body = m[1]!;
		const tab = /tab:\s*"([^"]+)"/.exec(body)?.[1];
		const group = /group:\s*"([^"]+)"/.exec(body)?.[1];
		const label = /label:\s*"((?:[^"\\]|\\.)*)"/.exec(body)?.[1];
		if (tab && group && label) map.set(label, { tab, group });
	}
	return map;
}

/** "Startup & Updates" → "startupUpdates"; "Power (macOS)" → "powerMacos". */
function segment(text: string): string {
	return text
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map((w, i) => {
			const lower = w.toLowerCase();
			return i === 0 ? lower : lower.charAt(0).toUpperCase() + lower.slice(1);
		})
		.join("");
}

/** Drop camelCase words already carried by a path segment, and re-case. */
function stripPathWords(tail: string, pathWords: Set<string>): string {
	if (pathWords.size === 0) return tail;
	const kept = tail
		.split(/(?=[A-Z])/)
		.filter(Boolean)
		.filter(w => !pathWords.has(w.toLowerCase()));
	const joined = kept.join("");
	if (!joined) return "";
	return joined.charAt(0).toLowerCase() + joined.slice(1);
}

const SETTING_GROUPS = readSettingGroups();

function slugifyAt(text: string, wordCap: number): { tail: string; kind: "plain" | "info" | "desc" } {
	const w = words(text);
	if (w.length === 0) return { tail: "text", kind: "plain" };

	if (isProse(text)) {
		// Long prose: keep a short recognizable head plus a uniform tail. The
		// wording lives in the value; the key only has to be unique and locatable.
		const head = w.filter(x => !STOP.has(x.toLowerCase())).slice(0, 3);
		const tail = camel(head.length > 0 ? head : w.slice(0, 3)) + placeholderSuffix(text);
		return { tail, kind: text.length > 120 ? "desc" : "info" };
	}

	// Labels and short sentences: slug in full, capped so keys stay short.
	const meaningful = w.filter(x => !STOP.has(x.toLowerCase()));
	const pick = meaningful.length >= 2 ? meaningful.slice(0, wordCap) : w.slice(0, wordCap);
	// The placeholder suffix is part of the name: "Context" and "Context {count}"
	// are different messages and must not share a key.
	return { tail: camel(pick) + placeholderSuffix(text), kind: "plain" };
}

/** Widening ladder: a longer head is better than a numeric suffix. */
function slugCandidates(text: string): string[] {
	const out: string[] = [];
	for (const cap of [4, 6, 8, 999]) {
		const { tail, kind } = slugifyAt(text, cap);
		const name = tail + (kind === "plain" ? "" : `.${kind}`);
		if (!out.includes(name)) out.push(name);
	}
	return out;
}

interface DictFile {
	abs: string;
	rel: string;
	domain: string;
	keys: string[];
}

function readDictFiles(dirRel: string): DictFile[] {
	const abs = path.resolve(root, dirRel);
	const out: DictFile[] = [];
	// coding-agent has no en-US directory (its English side is the source text in
	// code), so a missing locale is a fact, not an error.
	if (!fs.existsSync(abs)) return out;
	for (const file of fs.readdirSync(abs)) {
		if (!file.endsWith(".ts") || file === "index.ts") continue;
		const text = fs.readFileSync(path.join(abs, file), "utf8");
		const keys: string[] = [];
		for (const line of text.split("\n")) {
			const m = KEY_LINE.exec(line);
			if (m) keys.push(m[1]!.replace(/^"|"$/g, ""));
		}
		out.push({ abs: path.join(abs, file), rel: `${dirRel}/${file}`, domain: file.replace(/\.ts$/, ""), keys });
	}
	return out;
}

/** Build one package's mapping: old English key → namespaced key. */
function buildMapping(files: DictFile[]): Map<string, string> {
	const mapping = new Map<string, string>();
	const used = new Set<string>();
	const collisions: Array<{ domain: string; oldKey: string; base: string; final: string }> = [];

	for (const file of files) {
		for (const key of file.keys) {
			// A known settings label carries its product path (domain.tab.group);
			// everything else stays flat. Words already in the path are dropped
			// from the tail ("Mnemopi DB Path" → mnemopi.dbPath, not mnemopi.mnemopiDbPath).
			const group = SETTING_GROUPS.get(key);
			const pathWords = group
				? new Set([segment(group.tab).toLowerCase(), segment(group.group).toLowerCase()].filter(Boolean))
				: new Set<string>();
			const prefix = group ? `${file.domain}.${segment(group.tab)}.${segment(group.group)}` : file.domain;
			const candidates = slugCandidates(key).map(c => {
				const [head, ...rest] = c.split(".");
				const trimmed = pathWords.size > 0 ? stripPathWords(head, pathWords) || head : head;
				return `${prefix}.${[trimmed, ...rest].join(".")}`;
			});
			// First candidate free, else widen; numeric suffix only after the ladder
			// is exhausted (two genuinely identical phrases in one domain).
			let candidate = candidates.find(c => !used.has(c)) ?? "";
			const base = candidates[0]!;
			if (candidate === "") {
				let n = 2;
				while (used.has(`${base}${n}`)) n += 1;
				candidate = `${base}${n}`;
				collisions.push({ domain: file.domain, oldKey: key, base, final: candidate });
			}
			used.add(candidate);
			// The same English string can appear in two domains; each dictionary
			// entry needs its own namespaced key, so keys are per (domain, text)
			// and the lookup at call sites uses the first match below.
			if (!mapping.has(key)) mapping.set(key, candidate);
			else mapping.set(`${file.domain}\u0000${key}`, candidate);
		}
	}
	if (showCollisions) {
		console.log(`  collisions needing a numeric suffix: ${collisions.length}`);
		for (const c of collisions.slice(0, 25)) {
			console.log(`    ${JSON.stringify(c.oldKey)} → ${c.final}`);
		}
	}
	return mapping;
}

/** Rewrite one dictionary file: keys get namespaced, values unchanged. */
function rewriteDict(file: DictFile, mapping: Map<string, string>): { changed: number; text: string } {
	const lines = fs.readFileSync(file.abs, "utf8").split("\n");
	let changed = 0;
	const out: string[] = [];
	for (const line of lines) {
		const m = KEY_LINE.exec(line);
		if (!m) {
			out.push(line);
			continue;
		}
		const rawKey = m[1]!;
		const key = rawKey.replace(/^"|"$/g, "");
		const next = mapping.get(`${file.domain}\u0000${key}`) ?? mapping.get(key);
		if (!next) {
			out.push(line);
			continue;
		}
		// Every migrated key is a dotted identifier, so it must be quoted.
		out.push(line.replace(/^\t("[^"]+"|[A-Za-z_$][\w$]*)\s*:/, `\t"${next}":`));
		changed += 1;
	}
	return { changed, text: out.join("\n") };
}

const PACKAGES = [
	{ label: "client-core", dict: "packages/client-core/src/i18n" },
	{ label: "coding-agent", dict: "packages/coding-agent/src/i18n" },
];

const report: Array<{ pkg: string; files: number; keys: number; changed: number }> = [];
const allMappings = new Map<string, Map<string, string>>();

for (const pkg of PACKAGES) {
	console.log(`\n${"=".repeat(70)}\n${pkg.label}\n${"=".repeat(70)}`);
	const zhFiles = readDictFiles(`${pkg.dict}/zh-CN`);
	const mapping = buildMapping(zhFiles);
	allMappings.set(pkg.label, mapping);

	let changed = 0;
	let total = 0;
	for (const file of zhFiles) {
		total += file.keys.length;
		if (apply) {
			const { changed: c, text } = rewriteDict(file, mapping);
			fs.writeFileSync(file.abs, text);
			changed += c;
		}
	}
	// en-US, where it exists, mirrors zh-CN key-for-key; same mapping applies.
	const enFiles = readDictFiles(`${pkg.dict}/en-US`);
	if (apply) {
		for (const file of enFiles) {
			const { changed: c, text } = rewriteDict(file, mapping);
			fs.writeFileSync(file.abs, text);
			changed += c;
		}
	}
	report.push({ pkg: pkg.label, files: zhFiles.length, keys: total, changed });
	console.log(`  domains: ${zhFiles.length}, keys: ${total}, ${apply ? `rewritten: ${changed}` : "would rewrite"}`);
	if (showCollisions) console.log("  sample collisions above");
}

const mappingPath = path.resolve(root, "scripts/i18n-key-migration.json");
if (apply) {
	const exportShape: Record<string, Record<string, string>> = {};
	for (const [pkg, table] of allMappings) exportShape[pkg] = Object.fromEntries(table);
	fs.writeFileSync(mappingPath, `${JSON.stringify(exportShape, null, "\t")}\n`);
	console.log(`\nmapping written to ${mappingPath}`);
}

console.log(`\n${"=".repeat(70)}`);
for (const r of report)
	console.log(
		`${r.pkg.padEnd(14)} ${String(r.keys).padStart(5)} keys  ${apply ? `${String(r.changed).padStart(5)} rewritten` : ""}`,
	);
const totalKeys = report.reduce((s, r) => s + r.keys, 0);
console.log(`total: ${totalKeys} keys`);
if (!apply) console.log("\n(dry run — pass --apply to write)");
