/**
 * Enforce complete English/Chinese pairs for MusePi documentation.
 *
 * Convention (bilingual docs, mirroring dsh / the repo's package-README
 * rule `README.md` + `README.zh-CN.md`):
 *
 *   - Every in-scope document has a pair: `foo.md` (English) + `foo.zh-CN.md`
 *     (Simplified Chinese), plus a consistency record `foo.i18n.yaml`
 *     holding the git blob hash of each side at the last confirmed-consistent
 *     state.
 *   - Both languages carry equal authority. A PR that edits one side must
 *     bring the counterpart along in the same PR and re-record the pair.
 *   - Language switcher: the English side links to the Chinese side right
 *     after its H1 (`English | [中文](foo.zh-CN.md)`); the Chinese side
 *     links back (`[English](foo.md) | 中文`).
 *
 * Usage (from repo root, `bun run verify-translation-pairing ...`):
 *
 *   bun run verify-translation-pairing            # corpus-wide status report (never fails)
 *   bun run verify-translation-pairing --list     # same as above
 *   bun run verify-translation-pairing <stem...>  # strict check of named pairs (fails on violation)
 *   bun run verify-translation-pairing --write <stem...>   # record blob hashes for named pairs
 *   bun run verify-translation-pairing --write --all       # record every complete pair
 *
 * A pair is named by any of its three files or its bare stem
 * (`docs/foo.md`, `docs/foo.zh-CN.md`, `docs/foo.i18n.yaml`, `docs/foo`).
 *
 * This is a progressive gate: the corpus-wide report lists missing pairs but
 * exits 0, so translation can land incrementally. Named-pair checks are
 * strict so an edited pair cannot silently go stale in CI or pre-commit.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

/** Pairs that never get a counterpart or sidecar. */
const EXCLUDED_STEMS = new Set<string>([
  // agent instructions, maintained in English only
  "docs/AGENTS",
  "docs/CLAUDE",
  // teaching examples — standalone sample projects, not docs
  "docs/skills/examples/hello-extension/README",
  "docs/skills/examples/mini-marketplace/README",
  "docs/skills/examples/safety-hook/README",
]);

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.name.endsWith(".md")) acc.push(full);
  }
  return acc;
}

function inScope(file: string): boolean {
  const rel = relative(root, file).replaceAll("\\", "/");
  if (!rel.startsWith("docs/") && rel !== "index.md" && rel !== "README.md") return false;
  if (rel.endsWith(".zh-CN.md")) return true; // counterpart discovery handles pairing
  for (const stem of EXCLUDED_STEMS) {
    if (rel === `${stem}.md` || rel.startsWith(`${stem}.`)) return false;
  }
  return true;
}

function pairOf(file: string): { en: string; zh: string; stem: string } {
  const rel = relative(root, file).replaceAll("\\", "/");
  const zh = rel.endsWith(".zh-CN.md");
  const stem = zh ? rel.slice(0, -".zh-CN.md".length) : rel.slice(0, -".md".length);
  return { en: join(root, `${stem}.md`), zh: join(root, `${stem}.zh-CN.md`), stem };
}

function blobHash(file: string): string {
  return execSync(`git hash-object "${file.replaceAll("\\", "/")}"`, {
    cwd: root,
    encoding: "utf-8",
  }).trim();
}

function i18nPath(stem: string): string {
  return join(root, `${stem}.i18n.yaml`);
}

function readRecord(stem: string): Record<string, string> | null {
  const p = i18nPath(stem);
  if (!existsSync(p)) return null;
  const out: Record<string, string> = {};
  for (const line of readFileSync(p, "utf-8").split(/\r?\n/)) {
    const m = line.match(/^([^#\s][^:]*):\s*([0-9a-f]{40})\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function writeRecord(stem: string, en: string, zh: string): void {
  const p = i18nPath(stem);
  const body = `# Consistency record for ${basename(stem)}.md / ${basename(stem)}.zh-CN.md\n`
    + `# Blob hashes at last confirmed-consistent state. Edit one side -> update the other\n`
    + `# in the same PR, then re-record: bun run verify-translation-pairing --write ${stem}\n`
    + `${basename(stem)}.md: ${blobHash(en)}\n`
    + `${basename(stem)}.zh-CN.md: ${blobHash(zh)}\n`;
  writeFileSync(p, body, "utf-8");
}

function hasSwitcher(file: string, kind: "en" | "zh"): boolean {
  const lines = readFileSync(file, "utf-8").split(/\r?\n/);
  // Some docs (READMEs) have no markdown/HTML H1; fall back to the first 12
  // lines in that case. Switchers may be markdown links or inline HTML.
  // A real H1 lives near the top; scanning the whole file would misread
  // `# comment` lines inside code fences (README.zh-CN.md §shell block).
  const h1 = lines.slice(0, 25).findIndex((l) => /^(# |<h1)/.test(l.trim()));
  // README-style HTML headers (banner/tagline/badges) push the switcher past
  // 12 lines when there is no H1; allow a wider window in that case.
  const window = lines.slice(h1 === -1 ? 0 : h1 + 1, h1 === -1 ? 25 : h1 + 13).join("\n");
  if (kind === "en") {
    return /English[^\n]*(?:\[中文\]\([^)]*\.zh-CN\.md\)|<a[^>]*\.zh-CN\.md[^>]*>)/.test(window);
  }
  return /(?:\[English\]\([^)]*\.md\)|<a[^>]*\.md[^>]*>)[^\n]*中文/.test(window);
}

type Status = "ok" | "missing-pair" | "out-of-sync" | "no-record" | "missing-switcher" | "unpaired-zh";

interface Row { stem: string; status: Status; detail: string }

function checkStem(stem: string): Row {
  const en = join(root, `${stem}.md`);
  const zh = join(root, `${stem}.zh-CN.md`);
  const enExists = existsSync(en);
  const zhExists = existsSync(zh);
  const rel = stem.replaceAll("\\", "/");

  if (!enExists && !zhExists) return { stem: rel, status: "missing-pair", detail: "neither side exists" };
  if (enExists && !zhExists) return { stem: rel, status: "missing-pair", detail: "no .zh-CN.md" };
  if (!enExists && zhExists) return { stem: rel, status: "unpaired-zh", detail: "no English .md" };

  const record = readRecord(stem);
  if (!record) return { stem: rel, status: "no-record", detail: "no .i18n.yaml" };
  const enHash = blobHash(en);
  const zhHash = blobHash(zh);
  const enRec = record[`${basename(stem)}.md`];
  const zhRec = record[`${basename(stem)}.zh-CN.md`];
  if (enRec !== enHash || zhRec !== zhHash) {
    return { stem: rel, status: "out-of-sync", detail: `record ${enRec?.slice(0, 8) ?? "-"}/${zhRec?.slice(0, 8) ?? "-"} vs ${enHash.slice(0, 8)}/${zhHash.slice(0, 8)}` };
  }
  if (!hasSwitcher(en, "en")) return { stem: rel, status: "missing-switcher", detail: "English side lacks 'English | [中文](…zh-CN.md)'" };
  if (!hasSwitcher(zh, "zh")) return { stem: rel, status: "missing-switcher", detail: "Chinese side lacks '[English](…md) | 中文'" };
  return { stem: rel, status: "ok", detail: "" };
}

function collectStems(): string[] {
  const stems = new Set<string>();
  for (const file of walk(join(root, "docs"))) {
    const rel = relative(root, file).replaceAll("\\", "/");
    if (!inScope(file)) continue;
    stems.add(pairOf(file).stem);
  }
  for (const f of ["index.md", "README.md"]) {
    const p = join(root, f);
    if (existsSync(p) && inScope(p)) stems.add(pairOf(p).stem);
  }
  return [...stems].sort();
}

function parseStemArg(raw: string): string {
  let s = raw.replaceAll("\\", "/");
  s = s.replace(/^\.\//, "");
  if (s.endsWith(".zh-CN.md")) s = s.slice(0, -".zh-CN.md".length);
  else if (s.endsWith(".i18n.yaml")) s = s.slice(0, -".i18n.yaml".length);
  else if (s.endsWith(".md")) s = s.slice(0, -".md".length);
  // root-level stems ("index", "README") stay as-is; docs stems carry "docs/"
  return s;
}

const args = process.argv.slice(2);
const writeMode = args.includes("--write");
const listMode = args.includes("--list");
const allMode = args.includes("--all");
const named = args.filter((a) => !a.startsWith("--"));

const allStems = collectStems();
const namedStems = named.map(parseStemArg);
const targets =
  named.length > 0
    ? namedStems.map((s) => (allStems.includes(s) ? s : `docs/${s}`))
    : allStems;

const rows = targets.map(checkStem);

if (writeMode) {
  let written = 0;
  for (const row of rows) {
    if (row.status === "missing-pair" || row.status === "unpaired-zh") continue;
    const en = join(root, `${row.stem}.md`);
    const zh = join(root, `${row.stem}.zh-CN.md`);
    if (!existsSync(en) || !existsSync(zh)) continue;
    writeRecord(row.stem, en, zh);
    written++;
  }
  console.log(`recorded ${written} pair(s)`);
  process.exit(0);
}

const counts: Record<Status, number> = { ok: 0, "missing-pair": 0, "out-of-sync": 0, "no-record": 0, "missing-switcher": 0, "unpaired-zh": 0 };
for (const row of rows) {
  counts[row.status]++;
  if (listMode || row.status !== "ok") {
    console.log(`${row.status.padEnd(16)} ${row.stem}${row.detail ? "  (" + row.detail + ")" : ""}`);
  }
}
if (listMode) {
  console.log(`\n${rows.length} in scope, ok=${counts.ok}`);
  process.exit(0);
}

// Strict mode only when explicit pairs were named: a stale pair fails.
if (named.length > 0) {
  const bad = rows.filter((r) => r.status !== "ok");
  for (const row of bad) {
    console.error(`✗ ${row.stem}: ${row.detail}`);
  }
  if (bad.length > 0) process.exit(1);
  console.log(`✓ ${rows.length} named pair(s) consistent`);
  process.exit(0);
}

// Corpus-wide: report only (progressive rollout; translation lands incrementally).
const bad = rows.filter((r) => r.status !== "ok");
console.log(`\n${rows.length} in scope · ok=${counts.ok} · missing-pair=${counts["missing-pair"]} · no-record=${counts["no-record"]} · out-of-sync=${counts["out-of-sync"]} · missing-switcher=${counts["missing-switcher"]}`);
if (bad.length === 0) console.log("✓ all in-scope documents are paired and consistent");
process.exit(0);
