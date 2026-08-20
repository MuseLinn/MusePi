import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentPauseGate } from "@musepi/pi-agent-core";
import { pauseSidecarPath, readPauseSidecar, writePauseSidecar } from "../../src/daemon/pause-sidecar";

/**
 * Pause persistence (TUI/GUI parity): the per-session AgentPauseGate lives
 * only in memory, so an idle-archived or daemon-restarted session would
 * silently lose its pause. The daemon mirrors gate transitions to a
 * per-session sidecar (absence = not paused) and rehydrates the gate on
 * reactivation. These tests exercise the sidecar round-trip with an
 * isolated temp dir (the module default dir is the real journal).
 */

describe("pause sidecar persistence", () => {
	function tempJournalDir(): string {
		return fs.mkdtempSync(path.join(os.tmpdir(), "pause-sidecar-"));
	}

	test("write+read round-trips a paused state with its timestamp", async () => {
		const dir = tempJournalDir();
		writePauseSidecar("s-1", true, 42_000, dir);
		// Fire-and-forget write; give the microtask a tick.
		await new Promise(r => setTimeout(r, 20));
		const state = await readPauseSidecar("s-1", dir);
		expect(state).toEqual({ paused: true, pausedAt: 42_000 });
	});

	test("a missing or corrupt sidecar reads as not paused", async () => {
		const dir = tempJournalDir();
		expect(await readPauseSidecar("s-missing", dir)).toEqual({ paused: false, pausedAt: null });
		fs.writeFileSync(pauseSidecarPath("s-corrupt", dir), "{not json");
		expect(await readPauseSidecar("s-corrupt", dir)).toEqual({ paused: false, pausedAt: null });
	});

	test("a false transition removes the sidecar (absence = running)", async () => {
		const dir = tempJournalDir();
		writePauseSidecar("s-2", true, 1, dir);
		await new Promise(r => setTimeout(r, 20));
		expect(fs.existsSync(pauseSidecarPath("s-2", dir))).toBe(true);
		writePauseSidecar("s-2", false, null, dir);
		await new Promise(r => setTimeout(r, 20));
		expect(fs.existsSync(pauseSidecarPath("s-2", dir))).toBe(false);
		expect(await readPauseSidecar("s-2", dir)).toEqual({ paused: false, pausedAt: null });
	});

	test("gate rehydration from the sidecar restores the pause (archive cycle)", async () => {
		const dir = tempJournalDir();
		const pausedAt = Date.now() - 5_000;
		writePauseSidecar("s-3", true, pausedAt, dir);
		await new Promise(r => setTimeout(r, 20));
		// This is what resumeSession does on reactivation.
		const gate = new AgentPauseGate(await readPauseSidecar("s-3", dir));
		expect(gate.paused).toBe(true);
		expect(gate.pausedAt).toBe(pausedAt);
		const duration = gate.resume();
		expect(duration).toBeGreaterThanOrEqual(5_000);
		expect(duration).toBeLessThan(60_000);
	});
});
