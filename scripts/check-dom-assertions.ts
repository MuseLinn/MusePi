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
 * What is flagged: an `expect(...)` that asserts on a DOM node with `toBeNull`,
 * `toBeDefined` or `toBeUndefined` — directly (`expect(host.querySelector(".x"))`)
 * or through a binding to one (`const node = host.querySelector(".x");
 * expect(node)`). The negated forms (`.not.toBeNull()`, `.not.toBeDefined()`) are
 * flagged too: they fail by serialising the same node. A variable is not a
 * different subject — measured on a 400-row tree, asserting absence on a present
 * node through a binding gave `timed out after 15000ms`, no diff, real 16.5s,
 * which is the same failure as the inline form.
 *
 * An identifier only counts as a node when the same file binds it to a DOM query.
 * A name that is not bound that way is left alone: guessing from the name would
 * flag `expect(value).toBeNull()` and make the ban forbid its own fix.
 *
 * Where it looks: every `*.test.*` / `*.spec.*` file in `apps/desktop`, which
 * includes the co-located suites under `src/`. The reporter stall is a property
 * of the matcher and the received value, not of a directory; scoping to `test/`
 * left 26 `src/**` suites unguarded. Implementation files are never scanned.
 *
 * What is NOT flagged: every other matcher on a node (`toBe`, `toBeTruthy`,
 * `toContain`, `.length` counts, attribute reads) and every `toBeNull` whose
 * subject is not a DOM query (`expect(value).toBeNull()`, `expect(await
 * readThing()).toBeNull()`). The ban is about the reporter stall, not about
 * assertion style in general.
 *
 * Baseline: the sites already in the tree are recorded per file in
 * `scripts/dom-assertions-baseline.json`, following the shape of
 * `check-dead-code` and `check-comment-provenance` — a rule that is red on
 * arrival is a rule nobody can land. The gate fails on a NEW site (or a file
 * exceeding its recorded count) and stays green as the debt is paid down. A
 * cleared site needs no bookkeeping; a shrink is picked up by `--write`. The
 * live totals are whatever the baseline currently holds — `--report` lists them,
 * and the success line prints the count — so this description states the
 * mechanism rather than a number that would drift from it.
 *
 *   bun scripts/check-dom-assertions.ts            # fail on growth
 *   bun scripts/check-dom-assertions.ts --write    # re-record the baseline
 *   bun scripts/check-dom-assertions.ts --report   # list every site
 */
import * as fs from "node:fs";
import * as path from "node:path";

const BASELINE_PATH = "scripts/dom-assertions-baseline.json";
const ROOT = path.resolve(import.meta.dir, "..");

/**
 * DOM accessors whose result is a node (or a node collection indexed into one).
 *
 * The optional `<...>` is a TypeScript type argument (`querySelector<HTMLElement>`),
 * which sits between the accessor and its `(` — without it the inline shape with a
 * type argument was silently skipped.
 */
const DOM_QUERY =
	/(?:\b(?:querySelector|querySelectorAll|closest|getElementById|getElementsByTagName|getElementsByClassName)\s*(?:<[^<>()]*>)?\s*\(|\b(?:firstElementChild|lastElementChild|nextElementSibling|previousElementSibling|parentElement)\b)/;

/**
 * A binding whose right-hand side is a DOM query: `const node = host.querySelector(".x")`.
 *
 * The alias is what makes the ban's subject real rather than textual. A node held
 * in a variable stalls the reporter exactly as an inline one does — measured on a
 * 400-row tree, asserting `toBeNull` on a present node through a binding gave
 * `timed out after 15000ms`, no diff, real 16.5s — so matching only the inline
 * text would ship a promise narrower than the mechanism it describes.
 */
const ALIAS_BINDING = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*([^;]*)/g;

/** `expect(<identifier>)` followed by one of the node matchers. */
const ALIAS_ASSERTION =
	/expect\(\s*([A-Za-z_$][\w$]*)\s*[!?]?\s*\)\s*(\.\s*(?:not\s*\.\s*)?(?:toBeNull|toBeDefined|toBeUndefined)\s*\()/g;

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
 * Find every `expect(...)` that asserts presence or absence of a DOM node.
 *
 * Two shapes reach the reporter the same way, so both are collected:
 *
 *  - **inline** — `expect(host.querySelector(".x")).toBeNull()`. The scan walks
 *    the text, matching `expect(` and then finding its balanced closing paren,
 *    so a nested call is read as one argument instead of a truncated one.
 *    Templates and strings are skipped while balancing, since a selector can
 *    contain parentheses.
 *  - **aliased** — `const node = host.querySelector(".x"); expect(node).toBeNull()`.
 *    A binding whose right-hand side is a DOM query is a node, and asserting on
 *    the variable stalls exactly as the inline form does. Every such binding in
 *    the file is collected first, so an assertion earlier in the file than the
 *    binding is still caught.
 *
 * An identifier is only treated as a node when the same file binds it to a DOM
 * query. A name that is not bound that way is left alone: guessing from its name
 * would flag `expect(value).toBeNull()` and make the ban forbid its own fix.
 */
export function collectDomAssertions(file: string, source: string): DomAssertionSite[] {
	const sites: DomAssertionSite[] = [];
	const text = source;
	const nodeAliases = new Set<string>();
	for (const binding of text.matchAll(ALIAS_BINDING)) {
		if (DOM_QUERY.test(binding[2] ?? "")) nodeAliases.add(binding[1] as string);
	}

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
		const trimmed = argument.trim().replace(/[!?]$/, "");
		const isNode = DOM_QUERY.test(argument) || nodeAliases.has(trimmed);
		if (!isNode) continue;
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

/**
 * Desktop test sources across the whole package, tracked or newly written,
 * minus generated output.
 *
 * The pathspec is the package, not `apps/desktop/test`: the reporter stall is a
 * property of the matcher and the received value, not of a directory, and
 * `apps/desktop/src/**\/*.test.tsx` holds co-located suites that touch the DOM
 * the same way. Scoping to `test/` left those unguarded.
 */
export function testSources(): string[] {
	const listed = Bun.spawnSync(
		["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "apps/desktop"],
		{ cwd: ROOT, stdout: "pipe", stderr: "pipe" },
	);
	return listed.stdout
		.toString()
		.split("\0")
		.map(entry => entry.trim())
		.filter(entry => /\.(test|spec)\.(ts|tsx)$/.test(entry))
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

	const baseline = readBaseline().counts;
	const violations = growth(counts, baseline);
	// A baseline entry whose file is gone describes a tree that no longer
	// exists. Left unsaid it makes the recorded total and the live total differ
	// with no explanation — which is how a stale count survives a review.
	const stale = Object.keys(baseline).filter(file => !(file in counts));
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
	const staleNote =
		stale.length > 0 ? `; ${stale.length} baseline file(s) no longer exist — re-record with --write` : "";
	console.log(
		`dom-assertions: OK — ${sites.length} site(s) across ${Object.keys(counts).length} file(s),` +
			` no new DOM-node presence assertion${staleNote}` +
			`\n  the recorded sites still stall on failure; see docs on guards in .agents/rules/testing.md`,
	);
	if (stale.length > 0) for (const file of stale.sort()) console.log(`  stale baseline entry: ${file}`);
}

if (import.meta.main) main();
