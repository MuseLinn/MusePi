/**
 * Gate unused exports, exported types and unused dependencies with knip.
 *
 * Why exports and not files: on this repository knip reports 1838 unused files,
 * almost all of them benches, test fixtures, example plugins, docs samples and
 * one-off scripts that no entry point declares. A gate that shouts 1838 is the
 * same failure as a gate that never fires — everyone learns to scroll past it.
 * The unused-symbol side is a different matter: 461 findings across exports,
 * types and dependencies, which is a backlog rather than noise.
 *
 * Why a baseline and not a hard failure: some of those are reachable only by
 * name. Extension entry points and slot components are resolved by string at
 * runtime, so no import statement exists for knip to find. The baseline records
 * what the tool sees today and the gate blocks growth, leaving the cleanup to
 * whoever owns each symbol. Same shape as the comment-provenance gate, for the
 * same reason: a rule that fires on the state of the tree is a rule nobody can
 * land in one commit.
 *
 * Findings are keyed without a line number on purpose. A symbol that moves
 * should not read as newly dead, or every refactor in the repository turns the
 * gate red.
 *
 *   bun scripts/check-dead-code.ts
 *   bun scripts/check-dead-code.ts --write   re-record the baseline
 */
import * as fs from "node:fs";
import * as path from "node:path";

const BASELINE_PATH = "scripts/dead-code-baseline.json";
const KNIP_CLI = "node_modules/knip/dist/cli.js";
const ISSUE_TYPES = ["exports", "types", "dependencies", "devDependencies", "unlisted"];

export interface DeadCodeEntry {
	kind: string;
	/** Repo-relative file the symbol or dependency is declared in. */
	file: string;
	/** The exported name, or the dependency name. */
	symbol: string;
}

interface KnipSymbol {
	name?: unknown;
}

export function entryKey(e: DeadCodeEntry): string {
	return `${e.kind} ${e.file} ${e.symbol}`;
}

const asName = (v: unknown): string | null => {
	if (typeof v === "string") return v;
	if (v && typeof v === "object" && typeof (v as KnipSymbol).name === "string") {
		return (v as KnipSymbol).name as string;
	}
	return null;
};

/**
 * Flatten knip's JSON report.
 *
 * The report is a list of per-file issues, each carrying arrays per kind, so
 * each array is read on its own terms. Unlisted dependencies are reported
 * against package.json as bare names rather than objects.
 */
export function parseKnipReport(raw: unknown): DeadCodeEntry[] {
	const report = (raw ?? {}) as { issues?: Record<string, unknown>[] };
	const out: DeadCodeEntry[] = [];
	for (const issue of report.issues ?? []) {
		const file = typeof issue.file === "string" ? issue.file : "";
		if (!file) continue;
		for (const kind of ISSUE_TYPES) {
			const items = issue[kind];
			if (!Array.isArray(items)) continue;
			for (const item of items) {
				const symbol = asName(item);
				if (symbol) out.push({ kind, file, symbol });
			}
		}
	}
	return out;
}

/** Findings not present in the baseline, deduplicated and stable in order. */
export function diffAgainstBaseline(current: DeadCodeEntry[], baseline: string[]): string[] {
	const known = new Set(baseline);
	const seen = new Set<string>();
	const added: string[] = [];
	for (const e of current) {
		const k = entryKey(e);
		if (seen.has(k) || known.has(k)) continue;
		seen.add(k);
		added.push(k);
	}
	return added.sort();
}

async function runKnip(): Promise<DeadCodeEntry[]> {
	const proc = Bun.spawn(
		["bun", KNIP_CLI, "--no-progress", "--reporter", "json", "--include", ISSUE_TYPES.join(",")],
		{
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	// knip exits non-zero whenever it has findings, which is the normal case here.
	if (stdout.trim().length === 0) {
		throw new Error(`knip produced no report (exit ${exitCode}): ${stderr.slice(0, 400)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error(`knip report was not JSON: ${stdout.slice(0, 300)}`);
	}
	return parseKnipReport(parsed);
}

async function main(): Promise<void> {
	const current = await runKnip();
	const unique = [...new Set(current.map(entryKey))];

	if (process.argv.includes("--write")) {
		fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
		fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(unique.sort(), null, "\t")}\n`, "utf8");
		console.log(`dead-code: recorded ${unique.length} finding(s)`);
		return;
	}

	const baseline: string[] = fs.existsSync(BASELINE_PATH)
		? (JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as string[])
		: [];
	const added = diffAgainstBaseline(current, baseline);
	if (added.length > 0) {
		for (const a of added) console.error(`  ${a}`);
		console.error(
			`\ndead-code: ${added.length} finding(s) beyond the ${baseline.length} baselined.` +
				"\nknip only sees static imports, so an entry point or slot component resolved by" +
				"\nname has no import to find. If a finding is one of those, re-record with --write." +
				"\nOtherwise delete the symbol or the dependency.",
		);
		process.exit(1);
	}
	console.log(`dead-code: OK — ${unique.length} finding(s) vs baseline ${baseline.length}`);
}

if (import.meta.main) await main();
