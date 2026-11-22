/**
 * One-axis overflow guard — a scroll container must declare the axis it is NOT
 * meant to scroll.
 *
 * Why this exists: per CSS, `overflow-y: auto` alone sets the other axis to
 * `auto` as well (`visible` is not a permitted companion). So every container
 * that only ever scrolls vertically silently becomes a horizontal scroll
 * container too, and the first row wider than the content box — a `nowrap`
 * path, a long unbroken token, a card whose content is complete — grows a
 * horizontal scrollbar. The project hover card shipped exactly that (user
 * report: "内容明明显示完整却出现了不该出现的横向滚动"), and the same shape
 * appeared in 60-odd other rules, which is why this is a class rule and not
 * a one-off patch.
 *
 * Contract (docs/gui-components.md, "Overflow contract"):
 *   - a rule that sets `overflow-x` or `overflow-y` must set BOTH;
 *   - the axis that must never scroll is declared explicitly (`hidden`/`clip`);
 *   - a genuinely horizontal scroller is named in {@link HORIZONTAL_SCROLLERS}
 *     with the reason it is allowed to scroll sideways, rather than dropped in
 *     a silent allowlist;
 *   - shorthand `overflow: <v>` alone is allowed when both axes get the same
 *     value by definition; `overflow: hidden auto` likewise sets both.
 *
 * What it does NOT check: whether a container SHOULD scroll on an axis. The
 * allowlist is the human judgement; this guard keeps the declaration honest
 * and forces a new horizontal scroller to be named.
 *
 * Generated output is not source. The guard reads the stylesheets git tracks
 * plus untracked files that are not ignored, and never a gitignored path:
 * `apps/desktop/src/styles/tailwind.out.css` is a build artifact, and its
 * utilities (`.overflow-y-auto` and friends) declare one axis by construction
 * because that is what those utilities mean. Reading it made the local gate
 * red on any tree where someone had built first while clean CI stayed green —
 * a guard that fails on build output teaches people to ignore it. The skip is
 * answered by git (`git ls-files` plus `git check-ignore`), not by a list that
 * needs maintenance, so a new generated stylesheet is skipped the moment it is
 * ignored. An untracked stylesheet that is NOT ignored is still scanned, so
 * writing a new sheet cannot dodge the guard.
 *
 *   bun scripts/check-overflow-axis.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOTS = ["apps/desktop/src"];

/**
 * Horizontal scrollers that are allowed to scroll sideways, with the reason.
 * Keep in sync with the allowlist paragraph in docs/gui-components.md — the
 * doc references this list instead of copying it, so this array is the single
 * source of truth.
 */
export const HORIZONTAL_SCROLLERS: Readonly<Record<string, string>> = {
	".gui-model-tabs": "model-pane tab strip: tabs are laid out in one row and scrolled, never wrapped",
	".gui-ext-tabs": "extension detail tab strip: same one-row-then-scroll shape",
	".gui-creation-chiprail": "creation chip rail: one row of preset chips, deliberately scrolled",
	".gui-creation-startfrom-row": "creation 'start from' rail: one row of templates, deliberately scrolled",
	".gui-code-preview-body": "code preview block: source lines keep their own width",
	".gui-connector-failure-details pre": "connector failure log: a preformatted server message keeps its width",
	".gui-ext-detail-code pre": "extension source preview: preformatted code keeps its width",
	".gui-agents-center-table":
		"agents-center data table: five-column grid with hard minimums (~540px); clipping would drop the last column",
};

export interface OverflowProblem {
	file: string;
	selector: string;
	/** The single axis that was declared without its counterpart. */
	axis: "overflow-x" | "overflow-y";
	reason: "missing-counterpart" | "unlisted-horizontal-scroller" | "unused-allowlist-entry";
	detail: string;
}

/** A gitignored stylesheet the guard deliberately did not read. */
export interface SkippedStylesheet {
	file: string;
	/** The ignore rule that matched, as `source:line (pattern)`. */
	rule: string;
}

export interface StylesheetScan {
	/** Repo-relative stylesheets the guard audits. */
	files: string[];
	/** Ignored stylesheets skipped, each with the rule that skipped it. */
	skipped: SkippedStylesheet[];
}

const RULE = /([^{}]+)\{([^{}]*)\}/g;

function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Drop the stylesheets git ignores.
 *
 * Pure so the rule can be tested without a repository: the caller supplies the
 * candidate list and the set git reported as ignored. Sorted so the report and
 * the problem order do not depend on filesystem enumeration order.
 */
export function selectStylesheets(candidates: readonly string[], ignored: ReadonlySet<string>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const file of candidates) {
		if (!file.endsWith(".css")) continue;
		if (ignored.has(file) || seen.has(file)) continue;
		seen.add(file);
		out.push(file);
	}
	return out.sort();
}

function git(args: string[], cwd: string): string {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
	}
	return result.stdout.toString();
}

function splitNul(output: string): string[] {
	return output
		.split("\0")
		.map(part => part.trim())
		.filter(part => part.length > 0);
}

/**
 * Enumerate the stylesheets to audit under `roots`, asking git what it tracks
 * and what it ignores.
 *
 * `--cached` is the tracked set, `--others --exclude-standard` adds a
 * developer's new unignored sheet, and `--others --ignored` names exactly what
 * to leave out. A tracked path that no longer exists on disk is dropped rather
 * than read as empty — a deleted file is not a stylesheet with zero rules.
 */
export function scanStylesheets(root: string, roots: readonly string[] = ROOTS): StylesheetScan {
	const candidates = splitNul(
		git(["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", ...roots], root),
	);
	const ignoredFiles = splitNul(
		git(["ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", ...roots], root),
	).filter(file => file.endsWith(".css"));
	const ignored = new Set(ignoredFiles);
	const files = selectStylesheets(candidates, ignored).filter(file => existsSync(join(root, file)));

	const skipped: SkippedStylesheet[] = [];
	if (ignoredFiles.length > 0) {
		// Exit 1 means "no path matched an ignore rule", which cannot happen for
		// a list git just reported as ignored; treat it as no rules rather than
		// failing the guard over a diagnostic.
		const result = Bun.spawnSync(["git", "check-ignore", "-v", "--", ...ignoredFiles], {
			cwd: root,
			stdout: "pipe",
			stderr: "pipe",
		});
		const rules = new Map<string, string>();
		for (const line of result.stdout.toString().split("\n")) {
			const tab = line.indexOf("\t");
			if (tab < 0) continue;
			const [source = "", lineNo = "", pattern = ""] = line.slice(0, tab).split(":");
			rules.set(line.slice(tab + 1).trim(), `${source}:${lineNo} (${pattern})`);
		}
		for (const file of ignoredFiles.sort()) {
			skipped.push({ file, rule: rules.get(file) ?? "ignored (rule not reported)" });
		}
	}
	return { files, skipped };
}

/** Normalise a selector list to the individual selectors this guard names. */
function selectorsOf(prelude: string): string[] {
	return prelude
		.split(",")
		.map(part => part.replace(/\s+/g, " ").trim())
		.filter(part => part.length > 0);
}

/**
 * Audit one stylesheet.
 *
 * Rules are matched flat (`selector { body }`); at-rule preludes contain no
 * braces so `@media {` never matches RULE, and its inner rules are matched on
 * their own. Declarations are read per rule, which is the only granularity
 * that matters here: the counterpart has to sit in the same rule.
 */
export function auditOverflowAxis(file: string, source: string): OverflowProblem[] {
	const problems: OverflowProblem[] = [];
	const text = stripComments(source);
	for (const match of text.matchAll(RULE)) {
		const prelude = match[1] ?? "";
		const body = match[2] ?? "";
		const declarations = new Map<string, string>();
		for (const declaration of body.split(";")) {
			const colon = declaration.indexOf(":");
			if (colon < 0) continue;
			const property = declaration.slice(0, colon).trim().toLowerCase();
			if (!property.startsWith("overflow")) continue;
			declarations.set(
				property,
				declaration
					.slice(colon + 1)
					.trim()
					.replace(/\s+/g, " ")
					.toLowerCase(),
			);
		}
		const x = declarations.get("overflow-x");
		const y = declarations.get("overflow-y");
		if (x === undefined && y === undefined) continue;

		const selectors = selectorsOf(prelude);
		const namedInAllowlist = selectors.filter(selector => selector in HORIZONTAL_SCROLLERS);

		if (x !== undefined && y !== undefined) {
			// Both axes declared. If a rule is allowlisted it must really scroll
			// sideways; `hidden`/`clip` on x under a horizontal-scroller entry is a
			// stale allowlist entry that hides a bug instead of naming it.
			if (namedInAllowlist.length > 0 && x !== "auto" && x !== "scroll") {
				for (const selector of namedInAllowlist) {
					problems.push({
						file,
						selector,
						axis: "overflow-x",
						reason: "unused-allowlist-entry",
						detail: `allowlisted as a horizontal scroller but declares overflow-x: ${x}`,
					});
				}
			}
			continue;
		}

		const axis = x !== undefined ? "overflow-x" : "overflow-y";
		const value = (x ?? y) as string;
		if (axis === "overflow-x" && (value === "auto" || value === "scroll")) {
			// A genuinely horizontal scroller is allowed, but only when named.
			for (const selector of selectors) {
				if (selector in HORIZONTAL_SCROLLERS) continue;
				problems.push({
					file,
					selector,
					axis,
					reason: "unlisted-horizontal-scroller",
					detail: `scrolls horizontally without an allowlist entry (add it to HORIZONTAL_SCROLLERS with a reason)`,
				});
			}
			continue;
		}
		for (const selector of selectors) {
			problems.push({
				file,
				selector,
				axis,
				reason: "missing-counterpart",
				detail: `${axis}: ${value} leaves ${axis === "overflow-x" ? "overflow-y" : "overflow-x"} computing to auto — declare it explicitly`,
			});
		}
	}
	return problems;
}

/** Every allowlist entry must still be a real horizontal scroller in the tree. */
export function unusedAllowlistEntries(files: { file: string; source: string }[]): OverflowProblem[] {
	const seen = new Set<string>();
	for (const { source } of files) {
		for (const match of stripComments(source).matchAll(RULE)) {
			for (const selector of selectorsOf(match[1] ?? "")) seen.add(selector);
		}
	}
	const problems: OverflowProblem[] = [];
	for (const selector of Object.keys(HORIZONTAL_SCROLLERS)) {
		if (seen.has(selector)) continue;
		problems.push({
			file: "(allowlist)",
			selector,
			axis: "overflow-x",
			reason: "unused-allowlist-entry",
			detail: "named horizontal scroller no longer exists — drop the entry",
		});
	}
	return problems;
}

function main(): void {
	const repoRoot = join(import.meta.dir, "..");
	const scan = scanStylesheets(repoRoot);
	const sources = scan.files.map(file => ({
		file: relative(repoRoot, file).split("\\").join("/"),
		source: readFileSync(join(repoRoot, file), "utf8"),
	}));

	const problems = sources.flatMap(({ file, source }) => auditOverflowAxis(file, source));
	problems.push(...unusedAllowlistEntries(sources));

	if (problems.length > 0) {
		console.error(`overflow-axis: ${problems.length} problem(s) in ${sources.length} stylesheet(s)`);
		for (const problem of problems) {
			console.error(`  ${problem.file}  ${problem.selector}  [${problem.reason}] ${problem.detail}`);
		}
		console.error(
			"\nA scroll container declares the axis it uses AND the axis it must not use:" +
				"\n`overflow-y: auto; overflow-x: clip;` is the usual vertical-list shape." +
				"\nSee docs/gui-components.md → Overflow contract.",
		);
		process.exit(1);
	}
	const skipped = scan.skipped.length > 0 ? `, ${scan.skipped.length} ignored stylesheet(s) skipped` : "";
	for (const { file, rule } of scan.skipped) console.log(`  skipped ${file} — gitignored by ${rule}`);
	console.log(`overflow-axis: OK — ${sources.length} stylesheet(s)${skipped}, every scroller declares both axes`);
}

if (import.meta.main) main();
