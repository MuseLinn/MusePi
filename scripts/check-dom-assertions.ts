/**
 * Ban `toBeNull` / `toBeDefined` on a DOM-node query result in desktop tests.
 *
 * Why this exists: a failing `expect(<DOM node>).toBeNull()` does not print a
 * diff. Bun's reporter serialises the received node to render it, and a real
 * rendered tree is large enough that the serialisation stalls the reporter:
 * measured here, a guard that should have failed in milliseconds reported
 *
 *   (fail) failing toBeNull on a realistic rendered tree [69849.65ms]
 *   ^ this test timed out after 5000ms.
 *
 * and the process took 69.8 seconds to exit. The boolean form
 * (`expect(node === null).toBe(true)`) failed in 1.26ms with a proper diff. So
 * a failing DOM-node guard is indistinguishable from a slow suite — which is
 * exactly how several guards passed review while their defect was present: a
 * timeout reads as flake, and flake gets re-run instead of read.
 *
 * What is flagged: an `expect(...)` whose argument is a DOM-node query and whose
 * matcher is `toBeNull`, `toBeDefined` or `not.toBeDefined`. Those three exist
 * to say "this node is absent" or "this node is present", and both facts are
 * boolean: write `expect(node === null).toBe(true)` or `expect(rows.length).toBe(0)`.
 * `.not.toBeNull()` is flagged too — the negative case fails by serialising the
 * same node.
 *
 * What is NOT flagged: every other matcher on a node (`toBe`, `toBeTruthy`,
 * `toContain`, `.length` counts, attribute reads) and every `toBeNull` whose
 * subject is not a DOM query (`expect(value).toBeNull()`, `expect(await
 * readThing()).toBeNull()`). The ban is about the reporter stall, not about
 * assertion style in general.
 *
 * Baseline: 182 pre-existing sites are recorded per file, following the shape of
 * `check-dead-code` and `check-comment-provenance` — a rule that is red on
 * arrival is a rule nobody can land. The gate fails on a NEW site (or a file
 * exceeding its recorded count) and stays green as the debt is paid down. A
 * cleared site needs no bookkeeping; a shrink is picked up by `--write`.
 *
 *   bun scripts/check-dom-assertions.ts            # fail on growth
 *   bun scripts/check-dom-assertions.ts --write    # re-record the baseline
 *   bun scripts/check-dom-assertions.ts --report   # list every site
 */
import * as fs from "node:fs";
import * as path from "node:path";

const BASELINE_PATH = "scripts/dom-assertions-baseline.json";
const ROOT = path.resolve(import.meta.dir, "..");

/** DOM accessors whose result is a node (or a node collection indexed into one). */
const DOM_QUERY =
	/(?:\b(?:querySelector|querySelectorAll|closest|getElementById|getElementsByTagName|getElementsByClassName)\s*\(|\b(?:firstElementChild|lastElementChild|nextElementSibling|previousElementSibling|parentElement)\b)/;

/** The three matchers that say "present" or "absent" and serialise a node when they fail. */
const NODE_MATCHER = /^\s*\.\s*(not\s*\.\s*)?(toBeNull|toBeDefined|toBeUndefined)\s*\(/;

export interface DomAssertionSite {
	file: string;
	/** 1-based line. */
	line: number;
	/** The assertion as written, whitespace-collapsed. */
	text: string;
}

interface Baseline {
	/** file → number of recorded sites allowed. */
	counts: Record<string, number>;
}

/**
 * Find every `expect(<DOM query>)` whose matcher serialises a node.
 *
 * The scan walks the text once, matching `expect(` and then finding its
 * balanced closing paren, so a nested call (`expect(host.querySelector(a ?? b))`)
 * is read as one argument instead of a truncated one. Templates and strings are
 * skipped while balancing, since a selector can contain parentheses.
 */
export function collectDomAssertions(file: string, source: string): DomAssertionSite[] {
	const sites: DomAssertionSite[] = [];
	const text = source;
	let index = text.indexOf("expect(");
	while (index >= 0) {
		const start = index + "expect(".length;
		let depth = 1;
		let quote: string | null = null;
		let cursor = start;
		for (; cursor < text.length && depth > 0; cursor++) {
			const ch = text[cursor] as string;
			if (quote) {
				if (ch === "\\") cursor++;
				else if (ch === quote) quote = null;
				continue;
			}
			if (ch === '"' || ch === "'" || ch === "`") quote = ch;
			else if (ch === "(") depth++;
			else if (ch === ")") depth--;
		}
		const argument = text.slice(start, cursor - 1);
		const matchStart = cursor;
		index = text.indexOf("expect(", cursor);
		if (!DOM_QUERY.test(argument)) continue;
		const matcher = text.slice(matchStart).match(NODE_MATCHER);
		if (!matcher) continue;
		const line = text.slice(0, matchStart).split("\n").length;
		sites.push({
			file,
			line,
			text: `expect(${argument.replace(/\s+/g, " ").trim()}).${matcher[1] ?? ""}${matcher[2]}()`,
		});
	}
	return sites;
}

/** Desktop test sources, tracked or newly written, minus generated output. */
export function testSources(): string[] {
	const listed = Bun.spawnSync(
		["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "apps/desktop/test"],
		{ cwd: ROOT, stdout: "pipe", stderr: "pipe" },
	);
	return listed.stdout
		.toString()
		.split("\0")
		.map(entry => entry.trim())
		.filter(entry => /\.(ts|tsx)$/.test(entry))
		.filter(entry => fs.existsSync(path.join(ROOT, entry)))
		.sort();
}

/** file → site count. */
export function countByFile(sites: readonly DomAssertionSite[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const site of sites) counts[site.file] = (counts[site.file] ?? 0) + 1;
	return counts;
}

/** Files whose count grew past the baseline. A shrink is not a violation. */
export function growth(
	counts: Record<string, number>,
	baseline: Record<string, number>,
): { file: string; count: number; allowed: number }[] {
	const out: { file: string; count: number; allowed: number }[] = [];
	for (const [file, count] of Object.entries(counts)) {
		const allowed = baseline[file] ?? 0;
		if (count > allowed) out.push({ file, count, allowed });
	}
	return out.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
}

function readBaseline(): Baseline {
	try {
		return JSON.parse(fs.readFileSync(path.join(ROOT, BASELINE_PATH), "utf8")) as Baseline;
	} catch {
		return { counts: {} };
	}
}

function main(): void {
	const argv = process.argv.slice(2);
	const write = argv.includes("--write");
	const report = argv.includes("--report");
	const sites = testSources().flatMap(file =>
		collectDomAssertions(file, fs.readFileSync(path.join(ROOT, file), "utf8")),
	);
	const counts = countByFile(sites);

	if (write) {
		const sorted: Record<string, number> = {};
		for (const file of Object.keys(counts).sort()) sorted[file] = counts[file] as number;
		fs.writeFileSync(path.join(ROOT, BASELINE_PATH), `${JSON.stringify({ counts: sorted }, null, "\t")}\n`);
		console.log(`dom-assertions: recorded ${sites.length} site(s) across ${Object.keys(sorted).length} file(s)`);
		return;
	}

	const violations = growth(counts, readBaseline().counts);
	if (report) {
		for (const site of sites) console.log(`  ${site.file}:${site.line}  ${site.text}`);
	}
	if (violations.length > 0) {
		console.error(`dom-assertions: ${violations.length} file(s) gained DOM-node presence assertions`);
		for (const violation of violations) {
			console.error(`  ${violation.file}: ${violation.count} site(s), baseline allows ${violation.allowed}`);
			for (const site of sites.filter(item => item.file === violation.file).slice(violation.allowed)) {
				console.error(`    ${site.file}:${site.line}  ${site.text}`);
			}
		}
		console.error(
			"\n`expect(<DOM query>).toBeNull()` fails by serialising the node, which stalls Bun's" +
				"\nreporter: the guard reports 'timed out' with no diff and reads as flake." +
				"\nAssert the boolean instead — `expect(node === null).toBe(true)` or `expect(rows.length).toBe(0)`.",
		);
		process.exit(1);
	}
	console.log(
		`dom-assertions: OK — ${sites.length} recorded site(s), no new DOM-node presence assertion` +
			`\n  the recorded sites still stall on failure; see docs on guards in .agents/rules/testing.md`,
	);
}

if (import.meta.main) main();
