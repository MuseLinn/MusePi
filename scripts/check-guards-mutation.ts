/**
 * Mutation control for the newest guards: restore each guard's defect, run its
 * test, and report what the run actually proved.
 *
 * Why this exists: five guards landed this week that passed with their defect
 * restored. A press test drove an injected CSS variable instead of the real
 * `:active` state; a deferral test asserted after the other branch had already
 * hidden the element; a cache test satisfied itself through a row clear instead
 * of the delete; a hover assertion read `matches(":hover")`, which is false
 * under a synthetic pointer even when the style demonstrably changed; and a row
 * geometry test measured a hand-built fixture whose class exists in no source
 * file. Each was found by hand, after review, by a human who thought to try.
 *
 * `.agents/rules/testing.md` has said for as long as it has existed that "a
 * regression guard must be shown to fail on the unfixed code" — but it is a
 * sentence someone has to remember, and the remembering is the part that fails.
 * This script makes the sentence executable: a guard names the one-line revert
 * that restores its defect, and the revert is applied and run mechanically.
 *
 * Marker convention, on the guard test file itself so it cannot drift away from
 * the test it describes:
 *
 *   // @guard: revert apps/desktop/src/styles/gui-chrome.css:869 | color: inherit;
 *   // @guard: test both cards' rows take the recipe's muted tone
 *
 * `revert` names `<path>:<line> | <defect>`: the line to rewrite, and what it
 * reads in the broken build. An empty defect (`... |`) deletes the line, which
 * is how a guard proves a *removed* line is load-bearing. `test` narrows the run
 * to one test by name; without it the whole file runs, which is the honest
 * default.
 *
 * Drift is caught by the run, not by a stored copy of the source: if the named
 * line moved, the defect lands somewhere harmless, the guard stays green, and
 * the result is **unproven** — the honest answer. A marker that already matches
 * the line is an **error**, since there is nothing to revert.
 *
 * Three outcomes, and the distinction is the entire point:
 *
 *   - **caught**     the suite failed, and the failure names a test (a real
 *                    assertion diff) rather than a harness error;
 *   - **unproven**   the run timed out, produced no per-test result, or the
 *                    suite still passed. A timeout is NOT a catch: a guard that
 *                    hangs has told us nothing about whether it discriminates.
 *                    `expect(<DOM node>).toBeNull()` reddens exactly this way —
 *                    Bun's reporter serialises the node and stalls, so the
 *                    suite reports "timed out" and the defect is unproven, not
 *                    caught;
 *   - **error**      the revert could not be applied, or the guard already fails
 *                    unmodified. The guard is untested.
 *
 * Every guard is run twice: once unmodified, where it must pass (otherwise the
 * tree is already red and nothing can be concluded), and once reverted, where
 * it must fail. A guard that fails unmodified is reported as an error, not a
 * catch — the revert would have "caught" a pre-existing failure.
 *
 * The revert happens in a scratch git worktree under the system temp directory,
 * with the repository's `node_modules` junctions linked in so the package's
 * bunfig preload resolves. The working tree is never touched, so a run cannot
 * corrupt the branch it is testing.
 *
 *   bun scripts/check-guards-mutation.ts            # every marked guard
 *   bun scripts/check-guards-mutation.ts --list     # markers only, no run
 *   bun scripts/check-guards-mutation.ts <file>...  # named guard files
 *   bun scripts/check-guards-mutation.ts --json     # machine-readable report
 *
 * Wiring: this is NOT part of `check:tools`. It takes minutes (one scratch
 * worktree plus a Chromium run per guard), it needs a browser, and it is a
 * statement about a guard rather than about the product — the wrong shape for
 * the pre-merge gate every developer runs. It belongs in CI on the guards a
 * change touches, which is why the script exists as a plain command: the job
 * can call it with the changed files. Run it locally after touching a guard.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface GuardMarker {
	/** Repo-relative guard test file carrying the marker. */
	file: string;
	/** 1-based line of the marker in that file, for the report. */
	markerLine: number;
	/** Repo-relative file whose line is reverted. */
	target: string;
	/** 1-based line in `target`. */
	line: number;
	/** What the line reads in the broken build; empty deletes the line. */
	defect: string;
	/** Test name to run, or null for the whole file. */
	testName: string | null;
}

export type GuardOutcome = "caught" | "unproven" | "error";

export interface GuardResult {
	marker: GuardMarker;
	outcome: GuardOutcome;
	/** One line naming what was observed. */
	detail: string;
	/** Names of the tests that failed on the reverted tree. */
	failedTests: string[];
	/** Wall time of the reverted run, in milliseconds. */
	durationMs: number;
}

/**
 * The marker grammar. Anchored on the comment so a sentence describing the
 * convention (like the block above) cannot be mistaken for a marker, and
 * requiring the pipe so a half-written marker is a parse error rather than a
 * silently ignored line.
 */
const REVERT_MARKER = /^\s*(?:\/\/|\*|\/\*)\s*@guard:\s*revert\s+(\S+):(\d+)\s*\|\s*(.*?)\s*(?:\*\/)?\s*$/;
const TEST_MARKER = /^\s*(?:\/\/|\*|\/\*)\s*@guard:\s*test\s+(.+?)\s*(?:\*\/)?\s*$/;

/**
 * Read every marker in a guard file.
 *
 * A file may carry more than one `revert` marker; each becomes its own case, so
 * a guard with two independent defects is proven twice. A `test` marker applies
 * to the `revert` marker nearest above it, which keeps a multi-case file
 * readable without an id syntax.
 */
export function parseMarkers(file: string, source: string): GuardMarker[] {
	const markers: GuardMarker[] = [];
	const lines = source.split(/\r?\n/);
	let pending: GuardMarker | null = null;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] as string;
		const revert = line.match(REVERT_MARKER);
		if (revert) {
			if (pending) markers.push(pending);
			pending = {
				file,
				markerLine: index + 1,
				target: revert[1] as string,
				line: Number(revert[2]),
				defect: (revert[3] ?? "").trim(),
				testName: null,
			};
			continue;
		}
		const named = line.match(TEST_MARKER);
		if (named && pending && pending.testName === null) {
			pending.testName = (named[1] as string).trim();
		}
	}
	if (pending) markers.push(pending);
	return markers;
}

/**
 * Apply one revert to a source text, or explain why it cannot be applied.
 *
 * The marker names only what the defect is, never what the line currently says:
 * a stored copy of the good text is a second fact that goes stale the moment
 * someone reformats the declaration, and a stale copy either blocks an honest
 * revert or — worse — rewrites the wrong line. Drift is caught downstream
 * instead: a defect that lands somewhere harmless leaves the guard green, which
 * the runner reports as **unproven** rather than caught.
 */
export function applyRevert(
	source: string,
	line: number,
	defect: string,
): { ok: true; text: string; current: string } | { ok: false; reason: string } {
	const lines = source.split("\n");
	const index = line - 1;
	if (index < 0 || index >= lines.length) {
		return { ok: false, reason: `line ${line} is outside the file (${lines.length} lines)` };
	}
	const current = (lines[index] as string).trim();
	if (current === defect) {
		return { ok: false, reason: `line ${line} already reads the defect ${JSON.stringify(defect)}` };
	}
	if (defect === "") lines.splice(index, 1);
	else {
		// Keep the line's own indentation: a marker names the code, not the
		// whitespace, and a reverted CSS declaration that lost its indent is
		// noise in a scratch diff someone may inspect with --keep.
		const indent = (lines[index] as string).match(/^\s*/)?.[0] ?? "";
		lines[index] = `${indent}${defect}`;
	}
	return { ok: true, text: lines.join("\n"), current };
}

/**
 * Classify one run.
 *
 * Bun prints `(fail) <name>` per failing test and a trailing summary. A run
 * with a failing test is a catch; a run with no failing test but a non-zero
 * exit (a build error, an unhandled module error) is a harness failure and
 * proves nothing about the guard; a timeout is unproven by definition.
 */
export function classifyRun(
	output: string,
	exitCode: number,
	timedOut: boolean,
): { outcome: GuardOutcome; failedTests: string[]; detail: string } {
	const failedTests = [...output.matchAll(/^\(fail\)\s+(.+?)(?:\s+\[[\d.]+m?s\])?$/gm)].map(match =>
		(match[1] as string).trim(),
	);
	if (timedOut) {
		return {
			outcome: "unproven",
			failedTests,
			detail: "timed out — a hanging guard proves nothing about whether it discriminates",
		};
	}
	if (failedTests.length > 0) {
		return {
			outcome: "caught",
			failedTests,
			detail: `${failedTests.length} test(s) failed on the reverted tree`,
		};
	}
	if (exitCode !== 0) {
		const firstError =
			output
				.split("\n")
				.map(line => line.trim())
				.find(line => line.startsWith("error:") || line.startsWith("# Unhandled")) ?? "non-zero exit";
		return { outcome: "error", failedTests, detail: `suite did not run: ${firstError}` };
	}
	return {
		outcome: "unproven",
		failedTests,
		detail: "suite passed on the reverted tree — the revert did not restore the defect the guard claims",
	};
}

/** Which `node_modules` directories must exist for a package test to resolve. */
function nodeModuleDirs(root: string): string[] {
	const dirs: string[] = [];
	const walk = (dir: string, depth: number): void => {
		if (depth > 3) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
			const child = path.join(dir, entry.name);
			if (fs.existsSync(path.join(child, "node_modules"))) dirs.push(path.join(child, "node_modules"));
			walk(child, depth + 1);
		}
	};
	if (fs.existsSync(path.join(root, "node_modules"))) dirs.push(path.join(root, "node_modules"));
	walk(root, 0);
	return dirs;
}

/**
 * Link the repository's installed dependencies into the scratch worktree.
 *
 * A worktree has no `node_modules`, and `bun install` there would cost a full
 * install per guard. Junctions (symlinks on POSIX) share the one install the
 * developer already has. They are created as relative-free absolute links, so
 * the scratch tree never writes into the real tree's dependency directories.
 */
function linkNodeModules(root: string, scratch: string): void {
	for (const real of nodeModuleDirs(root)) {
		const relative = path.relative(root, real);
		const link = path.join(scratch, relative);
		fs.mkdirSync(path.dirname(link), { recursive: true });
		fs.rmSync(link, { recursive: true, force: true });
		fs.symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
	}
}

function run(
	command: string[],
	cwd: string,
	timeoutMs: number,
): { output: string; exitCode: number; timedOut: boolean } {
	const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
	const timedOut = result.exitCode === null || result.exitedDueToTimeout === true;
	return {
		output: `${result.stdout.toString()}\n${result.stderr.toString()}`,
		exitCode: result.exitCode ?? -1,
		timedOut,
	};
}

/** Where a guard file's tests must run from: the nearest package with a bunfig. */
function packageDirOf(root: string, file: string): string {
	let dir = path.dirname(path.resolve(root, file));
	while (dir.startsWith(root)) {
		if (fs.existsSync(path.join(dir, "bunfig.toml"))) return path.relative(root, dir) || ".";
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return ".";
}

function bunTestArgs(file: string, testName: string | null, packageDir: string): string[] {
	const relative = path.relative(packageDir, file).split(path.sep).join("/");
	const args = ["bun", "test", relative];
	if (testName) args.push("-t", testName);
	return args;
}

export interface RunOptions {
	/** Root of the tree to test. Defaults to the repository. */
	root?: string;
	/** Per-run timeout. */
	timeoutMs?: number;
	/** Keep the scratch worktree for inspection. */
	keepScratch?: boolean;
	/** Progress line per guard. */
	log?: (line: string) => void;
}

/** Run one marker: baseline pass, then reverted run, then classify. */
export function runMarker(marker: GuardMarker, scratch: string, options: RunOptions = {}): GuardResult {
	const timeoutMs = options.timeoutMs ?? 300_000;
	const log = options.log ?? (() => {});
	const packageDir = packageDirOf(scratch, marker.file);
	const args = bunTestArgs(marker.file, marker.testName, packageDir);
	const cwd = path.join(scratch, packageDir);

	const baseline = run(args, cwd, timeoutMs);
	if (baseline.timedOut) {
		return {
			marker,
			outcome: "error",
			detail: "the guard itself timed out unmodified — nothing can be concluded",
			failedTests: [],
			durationMs: timeoutMs,
		};
	}
	const baselineFailed = classifyRun(baseline.output, baseline.exitCode, false);
	if (baselineFailed.outcome !== "unproven" || baselineFailed.failedTests.length > 0) {
		return {
			marker,
			outcome: "error",
			detail: `the guard already fails unmodified (${baselineFailed.detail}) — a catch would be meaningless`,
			failedTests: baselineFailed.failedTests,
			durationMs: 0,
		};
	}

	const targetPath = path.join(scratch, marker.target);
	if (!fs.existsSync(targetPath)) {
		return {
			marker,
			outcome: "error",
			detail: `${marker.target} does not exist`,
			failedTests: [],
			durationMs: 0,
		};
	}
	const original = fs.readFileSync(targetPath, "utf8");
	const reverted = applyRevert(original, marker.line, marker.defect);
	if (!reverted.ok) {
		return { marker, outcome: "error", detail: reverted.reason, failedTests: [], durationMs: 0 };
	}

	fs.writeFileSync(targetPath, reverted.text);
	const started = Date.now();
	try {
		const mutated = run(args, cwd, timeoutMs);
		const result = classifyRun(mutated.output, mutated.exitCode, mutated.timedOut);
		// An unproven run is usually a marker whose line drifted, so the detail
		// carries what was actually rewritten: the reader can see at once that
		// the defect landed on the wrong text.
		const detail =
			result.outcome === "unproven"
				? `${result.detail} — rewrote ${JSON.stringify(reverted.current)} to ${JSON.stringify(marker.defect || "<deleted>")}`
				: result.detail;
		log(`    reverted ${marker.target}:${marker.line} → ${result.outcome}`);
		return {
			marker,
			outcome: result.outcome,
			detail,
			failedTests: result.failedTests,
			durationMs: Date.now() - started,
		};
	} finally {
		fs.writeFileSync(targetPath, original);
	}
}

/** Guard files carrying at least one marker, in stable order. */
export function guardFiles(root: string, candidates?: readonly string[]): string[] {
	if (candidates && candidates.length > 0) return [...candidates].sort();
	const listed = run(["git", "ls-files", "-z", "--", "scripts", "apps/desktop/test"], root, 60_000);
	return listed.output
		.split("\0")
		.map(part => part.trim())
		.filter(file => /\.(ts|tsx)$/.test(file))
		.filter(file => fs.existsSync(path.join(root, file)))
		.filter(file => parseMarkers(file, fs.readFileSync(path.join(root, file), "utf8")).length > 0)
		.sort();
}

function report(results: GuardResult[]): void {
	const width = Math.max(...results.map(result => result.marker.file.length), 10);
	for (const result of results) {
		const name = result.marker.file.padEnd(width);
		const label = result.outcome.toUpperCase().padEnd(9);
		console.log(`${label} ${name} ${result.marker.target}:${result.marker.line}  ${result.detail}`);
		if (result.outcome === "caught" && result.failedTests.length > 0) {
			console.log(`          ${result.failedTests.join("\n          ")}`);
		}
	}
	const caught = results.filter(result => result.outcome === "caught").length;
	const unproven = results.filter(result => result.outcome === "unproven").length;
	const errors = results.filter(result => result.outcome === "error").length;
	console.log(
		`\nguards-mutation: ${caught} caught, ${unproven} unproven, ${errors} error (${results.length} guard(s))`,
	);
	if (unproven > 0) {
		console.log(
			"unproven is not a pass: those guards have not been shown to fail on their defect." +
				"\nA timeout is the usual cause — see `.agents/rules/testing.md` on DOM-node assertions.",
		);
	}
}

async function main(): Promise<void> {
	const root = path.resolve(import.meta.dir, "..");
	const argv = process.argv.slice(2);
	const listOnly = argv.includes("--list");
	const asJson = argv.includes("--json");
	const keepScratch = argv.includes("--keep");
	const files = argv.filter(arg => !arg.startsWith("--"));

	const candidates = guardFiles(root, files.length > 0 ? files : undefined);
	const markers = candidates.flatMap(file => parseMarkers(file, fs.readFileSync(path.join(root, file), "utf8")));
	if (markers.length === 0) {
		console.error("guards-mutation: no `@guard: revert` markers found");
		process.exit(1);
	}
	if (listOnly) {
		for (const marker of markers) {
			console.log(`${marker.file}:${marker.markerLine}  ${marker.target}:${marker.line}  ${marker.defect || "<deleted>"}`);
		}
		return;
	}

	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-guards-mutation-"));
	const results: GuardResult[] = [];
	try {
		const added = run(["git", "worktree", "add", "--detach", scratch, "HEAD"], root, 300_000);
		if (added.exitCode !== 0) throw new Error(`git worktree add failed: ${added.output.trim()}`);
		linkNodeModules(root, scratch);
		// The scratch tree is HEAD; a marker on an uncommitted guard would run the
		// committed test instead. Refuse rather than report on the wrong bytes.
		for (const marker of markers) {
			const working = fs.readFileSync(path.join(root, marker.file), "utf8");
			const committed = fs.readFileSync(path.join(scratch, marker.file), "utf8");
			if (working !== committed) {
				results.push({
					marker,
					outcome: "error",
					detail: "the guard file differs from HEAD — commit it before running mutation control",
					failedTests: [],
					durationMs: 0,
				});
				continue;
			}
			console.log(`  ${marker.file}  ${marker.target}:${marker.line}`);
			results.push(runMarker(marker, scratch));
		}
	} finally {
		run(["git", "worktree", "remove", "--force", scratch], root, 300_000);
		if (keepScratch) console.log(`scratch kept: ${scratch}`);
		else fs.rmSync(scratch, { recursive: true, force: true });
	}

	if (asJson) {
		console.log(JSON.stringify(results, null, 2));
	} else {
		report(results);
	}
	// Unproven and error both mean the guard's discrimination is unestablished,
	// so both fail the command. A local run that silently exits 0 on a timeout is
	// the exact false pass this script was written to remove.
	if (results.some(result => result.outcome !== "caught")) process.exit(1);
}

if (import.meta.main) await main();
