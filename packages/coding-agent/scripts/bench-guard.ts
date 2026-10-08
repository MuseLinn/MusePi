#!/usr/bin/env bun
/**
 * Boot-time regression guard (Phase A1 of the boot/TUI perf work).
 *
 * Re-runs the `PI_TIMING=x` cold-boot benchmark under hyperfine and fails when
 * the median regresses past `baseline * THRESHOLD`. `PI_TIMING=x` runs the full
 * pre-paint chain in `runRootCommand` and then `process.exit(0)`, so the
 * never-exiting interactive launch becomes a terminating, benchmarkable boot.
 *
 * The threshold is set from measured noise rather than from what a regression
 * would ideally look like: on an unchanged tree, three consecutive measurements
 * spanned 2086–2705ms, so a 5% budget reports a regression about as often as it
 * reports a real one. The measurement is repeated and the median taken so the
 * comparison means something; the budget sits above the noise it has to clear.
 *
 * Boot wall-clock is MACHINE-RELATIVE: a baseline captured on one machine is
 * meaningless on another (and on CI). This is a LOCAL guard — regenerate the
 * baseline on the machine you measure on, then compare on that same machine.
 * It is intentionally NOT wired into CI for that reason.
 *
 *   bun scripts/bench-guard.ts --update   # capture/refresh the baseline
 *   bun scripts/bench-guard.ts            # measure + compare; exit 1 on regression
 *
 * Requires `hyperfine` on PATH.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Regression budget.
 *
 * Set from measurement, not taste. Three consecutive runs of an unchanged tree
 * on this machine spanned 2086–2705ms — 29% — so a budget tight enough to catch
 * a real regression (5%) also reports one roughly every other run, and a guard
 * that cries wolf gets ignored, which is worse than having none. 25% sits above
 * the noise and below a change anyone would notice.
 */
const THRESHOLD = 1.25;
/**
 * Whole measurements to take, and report the median of.
 *
 * One hyperfine invocation is 10 boots, but boot cost here carries run-to-run
 * variance well beyond that. Repeating the whole measurement and taking the
 * median of medians is what makes the comparison mean something.
 */
const REPEATS = 3;
const BASELINE_PATH = path.join(import.meta.dir, "..", "bench", "boot-baseline.json");
/**
 * The command under measurement, as one shell string.
 *
 * hyperfine takes a command line, not an argv: given `bun` and `src/cli.ts` as
 * two arguments it benchmarks the first and then fails on the second, reporting
 * a command it never ran. So the words stay joined — but the environment prefix
 * does not, because a string like `PI_TIMING=x bun src/cli.ts` is only meaningful
 * to a POSIX shell, and this guard is run on Windows too. The variables go
 * through `spawn`'s own environment instead.
 */
const BENCH_COMMAND = "bun src/cli.ts";
const BENCH_ENV: Record<string, string> = { PI_TIMING: "x", PI_STRICT_EDIT_MODE: "1" };
const cwd = path.join(import.meta.dir, "..");

function medianOf(hyperfineJson: string): number {
	const parsed = JSON.parse(hyperfineJson) as { results: Array<{ mean: number; median?: number }> };
	const result = parsed.results[0];
	if (!result) throw new Error("hyperfine produced no result");
	return result.median ?? result.mean;
}

async function measure(): Promise<{ seconds: number; raw: string }> {
	// In the OS temp directory rather than the bench directory: hyperfine writes
	// this before the run it measures, so a failed or interrupted run leaves the
	// file behind, and a scratch artifact inside the repo is one `git status`
	// away from being committed.
	const tmp = path.join(os.tmpdir(), `musepi-boot-run-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
	const proc = Bun.spawn(["hyperfine", "--warmup", "3", "--min-runs", "10", "--export-json", tmp, BENCH_COMMAND], {
		cwd,
		env: { ...process.env, ...BENCH_ENV },
		stdout: "inherit",
		stderr: "inherit",
	});
	try {
		const code = await proc.exited;
		if (code !== 0) throw new Error(`hyperfine exited ${code}`);
		const raw = await Bun.file(tmp).text();
		return { seconds: medianOf(raw), raw };
	} finally {
		fs.rmSync(tmp, { force: true });
	}
}

const update = process.argv.includes("--update");

const samples: number[] = [];
let representativeRaw = "";
for (let round = 0; round < REPEATS; round++) {
	const measured = await measure();
	samples.push(measured.seconds);
	// The last raw comes from the round that produced the median, so the stored
	// baseline describes the same thing the reported number does.
	if (round === REPEATS - 1) representativeRaw = measured.raw;
}
samples.sort((a, b) => a - b);
const seconds = samples[Math.floor(samples.length / 2)] as number;

if (update) {
	fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
	await Bun.write(BASELINE_PATH, representativeRaw);
	console.log(`Baseline updated: ${(seconds * 1000).toFixed(0)}ms median of ${REPEATS} -> ${BASELINE_PATH}`);
	process.exit(0);
}

if (!fs.existsSync(BASELINE_PATH)) {
	console.error("No baseline found. Run `bun scripts/bench-guard.ts --update` on this machine first.");
	process.exit(2);
}

const baseline = medianOf(await Bun.file(BASELINE_PATH).text());
const ratio = seconds / baseline;
const verdict = ratio > THRESHOLD ? "REGRESSION" : "ok";
console.log(
	`boot median: ${(seconds * 1000).toFixed(0)}ms vs baseline ${(baseline * 1000).toFixed(0)}ms ` +
		`(${((ratio - 1) * 100).toFixed(1)}%, budget ${((THRESHOLD - 1) * 100).toFixed(0)}%) -> ${verdict}`,
);
process.exit(ratio > THRESHOLD ? 1 : 0);
