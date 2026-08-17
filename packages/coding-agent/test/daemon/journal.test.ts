/**
 * Unit tests for the daemon's append journal + compaction
 * (src/daemon/journal.ts).
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent } from "@musepi/pi-wire";
import { AppendJournal } from "../../src/daemon/journal";

const dirs: string[] = [];

function tempDir(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "journal-test-"));
	dirs.push(d);
	return d;
}

afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function event(type: string, n: number): AgentEvent {
	return { type, thinkingLevel: `lvl-${n}` } as unknown as AgentEvent;
}

describe("AppendJournal", () => {
	test("append + readAll round-trips in order with monotonic seqs", async () => {
		const j = new AppendJournal(tempDir(), "s1");
		await j.open();
		for (let i = 0; i < 5; i++) j.append(event("thinking_level_changed", i));
		const records = await j.readAll();
		expect(records).toHaveLength(5);
		expect(records.map(r => r.seq)).toEqual([1, 2, 3, 4, 5]);
		expect(records.map(r => (r.event as { thinkingLevel: string }).thinkingLevel)).toEqual([
			"lvl-0",
			"lvl-1",
			"lvl-2",
			"lvl-3",
			"lvl-4",
		]);
		await j.close();
	});

	test("readAll tolerates a torn trailing line (crash)", async () => {
		const dir = tempDir();
		const j = new AppendJournal(dir, "s1");
		await j.open();
		j.append(event("thinking_level_changed", 1));
		j.append(event("thinking_level_changed", 2));
		await j.close();
		// simulate a crash mid-write: append a partial line
		fs.appendFileSync(j.filePath, `{"seq":3,"ts":"x","event":`);
		const records = await j.readAll();
		expect(records).toHaveLength(2);
	});

	test("readAll on a missing file returns empty", async () => {
		const j = new AppendJournal(tempDir(), "ghost");
		expect(await j.readAll()).toEqual([]);
	});

	test("compact folds events into a checkpoint and trims the journal", async () => {
		const dir = tempDir();
		const j = new AppendJournal(dir, "s1");
		await j.open();
		for (let i = 0; i < 6; i++) j.append(event("thinking_level_changed", i));
		await j.close();

		await j.compact(4, { folded: true, entries: 4 });
		// checkpoint persisted
		const ckpt = await AppendJournal.readCheckpoint(j.filePath);
		expect(ckpt).toMatchObject({ seq: 4, snapshot: { folded: true, entries: 4 } });
		// journal trimmed to increments only
		const remaining = await j.readAll();
		expect(remaining.map(r => r.seq)).toEqual([5, 6]);
	});

	test("replaySource = checkpoint + increments above it", async () => {
		const dir = tempDir();
		const j = new AppendJournal(dir, "s1");
		await j.open();
		for (let i = 0; i < 6; i++) j.append(event("thinking_level_changed", i));
		await j.close();
		await j.compact(4, { folded: true });

		const { checkpoint, events } = await j.replaySource();
		expect(checkpoint!.seq).toBe(4);
		expect(events).toHaveLength(2);
		expect((events[0] as { thinkingLevel: string }).thinkingLevel).toBe("lvl-4");
	});

	test("replaySource without checkpoint returns all events", async () => {
		const dir = tempDir();
		const j = new AppendJournal(dir, "s1");
		await j.open();
		for (let i = 0; i < 3; i++) j.append(event("thinking_level_changed", i));
		await j.close();
		const { checkpoint, events } = await j.replaySource();
		expect(checkpoint).toBeNull();
		expect(events).toHaveLength(3);
	});

	test("shouldCompact crosses the event threshold", async () => {
		const dir = tempDir();
		const j = new AppendJournal(dir, "s1");
		await j.open();
		expect(await j.shouldCompact()).toBe(false);
		// threshold constant import is awkward in tests; drive via many appends
		for (let i = 0; i < 2000; i++) j.append(event("thinking_level_changed", i));
		expect(await j.shouldCompact()).toBe(true);
		await j.close();
	});

	test("compact is idempotent on an already-compacted journal (increments kept)", async () => {
		const dir = tempDir();
		const j = new AppendJournal(dir, "s1");
		await j.open();
		for (let i = 0; i < 10; i++) j.append(event("thinking_level_changed", i));
		await j.close();
		await j.compact(4, { v: 1 });
		await j.compact(7, { v: 2 });
		const ckpt = await AppendJournal.readCheckpoint(j.filePath);
		expect(ckpt!.seq).toBe(7);
		const remaining = await j.readAll();
		expect(remaining.map(r => r.seq)).toEqual([8, 9, 10]);
	});
});
