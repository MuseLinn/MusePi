import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { presetsDir } from "../src/presets/locations";

/**
 * Contract: preset files live in exactly one directory, `~/.musepi/presets`.
 *
 * The directory used to be `~/.musepi/modes`, which reads as the approval mode
 * (`tools.approvalMode`) although it only ever held agent presets. A second,
 * fallback location was considered and rejected: with two read paths "which
 * file wins" becomes a question, and a stale copy can shadow a live preset.
 */
describe("preset location", () => {
	const previous = process.env.MUSEPI_MODES_DIR;

	afterEach(() => {
		if (previous === undefined) delete process.env.MUSEPI_MODES_DIR;
		else process.env.MUSEPI_MODES_DIR = previous;
	});

	it("resolves to the presets directory, not the old modes one", () => {
		delete process.env.MUSEPI_MODES_DIR;
		const home = mkdtempSync(join(tmpdir(), "preset-loc-"));
		try {
			expect(presetsDir(home)).toBe(join(home, ".musepi", "presets"));
			expect(presetsDir(home)).not.toContain(`${join(home, ".musepi", "modes")}`);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("lets an explicit override win, so harnesses can isolate themselves", () => {
		const home = mkdtempSync(join(tmpdir(), "preset-loc-"));
		try {
			process.env.MUSEPI_MODES_DIR = join(home, "isolated");
			expect(presetsDir(home)).toBe(join(home, "isolated"));
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
