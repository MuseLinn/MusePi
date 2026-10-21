/**
 * Rewrite `t("english text")` call sites to the namespaced keys the dictionaries
 * now carry.
 *
 * The mapping comes from `scripts/i18n-key-migration.json`, written by
 * migrate-i18n-namespaced.ts — the same table the dictionaries were rewritten
 * with. Deriving it a second time here would let the two drift apart.
 *
 * Only literal keys are rewritten. Dynamic keys (`t(\`prefix ${x}\`)`) are
 * reported and left alone: their mapping depends on the runtime value, so they
 * need a per-site decision.
 *
 * `--apply` writes; without it this reports.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const apply = process.argv.includes("--apply");
const MAPPING_PATH = path.resolve(root, "scripts/i18n-key-migration.json");

const raw = JSON.parse(fs.readFileSync(MAPPING_PATH, "utf8")) as Record<string, Record<string, string>>;

/**
 * One flat old→new table. A key present in both packages (client-core and
 * coding-agent have separate barrels) must map to the same text or the rewrite
 * is ambiguous — report those rather than guessing.
 */
const flat = new Map<string, string>();
const ambiguous = new Map<string, Set<string>>();
for (const [pkg, table] of Object.entries(raw)) {
	for (const [oldKey, newKey] of Object.entries(table)) {
		// Per-domain entries are stored as "<domain>\0<text>"; the call site does
		// not know the domain, so only the unambiguous global entries are usable.
		if (oldKey.includes("\u0000")) continue;
		const existing = flat.get(oldKey);
		if (existing !== undefined && existing !== newKey) {
			const set = ambiguous.get(oldKey) ?? new Set([existing]);
			set.add(newKey);
			ambiguous.set(oldKey, set);
			flat.delete(oldKey);
			continue;
		}
		if (!ambiguous.has(oldKey)) flat.set(oldKey, newKey);
	}
}

/**
 * Source roots paired with the dictionary package their t() calls resolve
 * against. desktop-app renders client-core components, so it reads that barrel.
 */
const ROOTS: Array<{ dir: string; pkg: string }> = [
	{ dir: "packages/client-core/src", pkg: "client-core" },
	{ dir: "packages/desktop-app/src", pkg: "client-core" },
	{ dir: "packages/coding-agent/src", pkg: "coding-agent" },
];

/** Per-package tables: within one barrel the old→new mapping is a function. */
const tables = new Map<string, Map<string, string>>();
for (const [pkg, table] of Object.entries(raw)) {
	const t = new Map<string, string>();
	for (const [oldKey, newKey] of Object.entries(table)) {
		if (!oldKey.includes("\u0000")) t.set(oldKey, newKey);
	}
	tables.set(pkg, t);
}

function* walk(dir: string): Generator<string> {
	for (const entry of fs.readdirSync(dir)) {
		const abs = path.join(dir, entry);
		const st = fs.statSync(abs);
		if (st.isDirectory()) {
			if (entry === "node_modules" || entry === "dist") continue;
			yield* walk(abs);
		} else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) {
			yield abs;
		}
	}
}

/** `t("...")` / `tLoose("...")` / `builtinText("...")` with a plain string key. */
const CALL_RE = /\b(t|tLoose|builtinText)\(\s*"((?:[^"\\]|\\.)*)"/g;

let filesChanged = 0;
let sitesChanged = 0;
let missing = 0;
const unmapped = new Map<string, number>();
const dynamicSites: string[] = [];

for (const rootSpec of ROOTS) {
	const table = tables.get(rootSpec.pkg) ?? new Map<string, string>();
	const abs = path.resolve(root, rootSpec.dir);
	if (!fs.existsSync(abs)) continue;
	for (const file of walk(abs)) {
		const text = fs.readFileSync(file, "utf8");
		let changed = false;
		const next = text.replace(CALL_RE, (whole, fn: string, key: string) => {
			const mapped = table.get(key);
			if (mapped === undefined) {
				// Not every string literal is a translation key (a path, an id).
				// Only count ones that look like a sentence or a known label.
				if (/[A-Za-z]{3}/.test(key) && !key.includes("/") && !key.includes("\\")) {
					unmapped.set(key, (unmapped.get(key) ?? 0) + 1);
				}
				missing += 1;
				return whole;
			}
			changed = true;
			sitesChanged += 1;
			return `${fn}("${mapped}"`;
		});
		// Dynamic keys cannot be mapped statically; list them for a per-site pass.
		for (const line of text.split("\n")) {
			if (/\bt(?:Loose)?\(`/.test(line) && line.includes("${"))
				dynamicSites.push(`${path.relative(root, file)}: ${line.trim().slice(0, 100)}`);
		}
		if (changed) {
			if (apply) fs.writeFileSync(file, next);
			filesChanged += 1;
		}
	}
}

console.log(`mapping entries (unambiguous): ${flat.size}`);
console.log(`ambiguous keys (in >1 domain): ${ambiguous.size}`);
console.log(`call sites ${apply ? "rewritten" : "to rewrite"}: ${sitesChanged} in ${filesChanged} file(s)`);
console.log(`dynamic-key sites needing a manual look: ${dynamicSites.length}`);
for (const d of dynamicSites.slice(0, 10)) console.log(`  ${d}`);

// Unmapped strings that occur often are probably keys whose dictionary entry was
// renamed but whose call site the regex shape missed.
const frequent = [...unmapped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
if (frequent.length > 0) {
	console.log(`\nmost frequent unmapped string literals (may be missed keys):`);
	for (const [k, n] of frequent) console.log(`  ×${n}  ${JSON.stringify(k)}`);
}
if (!apply) console.log("\n(dry run — pass --apply to write)");
