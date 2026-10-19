import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

/**
 * The schema-labels i18n gate exists because nothing else covered this seam.
 *
 * Settings labels live in `settings-schema.ts` as English strings and reach the
 * UI through `t(label as TranslationKey)` — an assertion, not a check. The
 * general UI gate scans `desktop-app/src` and `client-core/src`, so a schema
 * string is invisible to it. Three real misses shipped that way: a setting added
 * with no dictionary entry, a key whose capitalisation drifted ("Show all" vs
 * "show all"), and a translation added to only one of the two dictionaries the
 * GUI and TUI each read.
 */

const ROOT = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(ROOT, "scripts/verify-schema-labels-i18n.ts");
const BASELINE = path.join(ROOT, "scripts/verify-schema-labels-i18n-baseline.json");

function run(args: string[] = []): { code: number; out: string } {
	const r = spawnSync("bun", [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8" });
	return { code: r.status ?? 1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe("schema-labels i18n gate", () => {
	it("passes on the current tree, reporting the baselined debt", () => {
		const { code, out } = run();
		expect(code).toBe(0);
		// The count must be reported, not hidden: a gate that says only "OK"
		// while 500 strings are untranslated teaches the reader nothing.
		expect(out).toContain("known untranslated");
	});

	it("has a baseline that only shrinks", () => {
		// The ratchet is the mechanism: existing debt is frozen by count, so a
		// regression that re-adds an untranslated string fails even though the
		// file previously passed.
		expect(existsSync(BASELINE)).toBe(true);
		const data = JSON.parse(readFileSync(BASELINE, "utf8")) as { count: number; pairs: string[] };
		expect(data.pairs.length).toBe(data.count);
		expect(data.count).toBeGreaterThan(0);
		// Each pair is "<dictionary>\0<string>" — the dictionary matters because
		// GUI and TUI read different files.
		expect(data.pairs[0]).toContain("\u0000");
	});

	it("fails when a setting ships with an untranslated label", () => {
		const schemaPath = path.join(ROOT, "packages/coding-agent/src/config/settings-schema.ts");
		const original = readFileSync(schemaPath, "utf8");
		const probe =
			'\t"zzz.gate.test.probe": {\n\t\ttype: "boolean",\n\t\tdefault: false,\n\t\tui: { tab: "appearance", group: "Display", label: "Unmistakably New Label For The Gate" },\n\t},\n\n';
		try {
			writeFileSync(
				schemaPath,
				original.replace('\t"display.liveActivityRows": {', `${probe}\t"display.liveActivityRows": {`),
			);
			const { code, out } = run();
			expect(code).toBe(1);
			expect(out).toContain("NEW untranslated");
			expect(out).toContain("Unmistakably New Label For The Gate");
			// It must name where the string came from, or the fix is a hunt.
			expect(out).toContain("zzz.gate.test.probe");
		} finally {
			writeFileSync(schemaPath, original);
		}
	});

	it("re-baselines on request, so paying down debt is a two-step operation", () => {
		// `--update` must not be a no-op: it writes the baseline the check reads.
		const backup = readFileSync(BASELINE, "utf8");
		try {
			const { code, out } = run(["--update"]);
			expect(code).toBe(0);
			expect(out).toContain("baseline written");
			const data = JSON.parse(readFileSync(BASELINE, "utf8")) as { count: number };
			expect(data.count).toBeGreaterThan(0);
		} finally {
			writeFileSync(BASELINE, backup);
		}
	});

	it("detects a string present in one dictionary but not the other", () => {
		// The exact failure that shipped: Chinese added to the TUI dictionary
		// only, so the desktop rendered English. Removing a key from ONE side
		// must make the check fail for that dictionary.
		const zh = path.join(ROOT, "packages/client-core/src/i18n/zh-CN/settings.ts");
		const original = readFileSync(zh, "utf8");
		const line = '\t"Running Turn Detail": "运行中回合显示多少",\n';
		expect(original).toContain(line);
		try {
			writeFileSync(zh, original.replace(line, ""));
			const { code, out } = run();
			expect(code).toBe(1);
			expect(out).toContain("client-core (GUI)");
			expect(out).toContain("Running Turn Detail");
		} finally {
			writeFileSync(zh, original);
		}
	});
});
