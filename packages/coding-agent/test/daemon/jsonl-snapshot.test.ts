/**
 * Contract tests for the canonical jsonl → session-snapshot projection
 * (src/daemon/jsonl-snapshot.ts, P0-5 in docs/review/0.5.1-defect-handoff.md).
 *
 * Failure modes defended — all observed on real sessions whose transcripts
 * carry far more than `message` rows:
 *  ① recovering an archived / never-journalled session silently dropped every
 *    non-message record family (custom advisor cards, custom_message,
 *    compaction, model_change …), so compaction dividers and advisor cards
 *    vanished from the GUI and trajectory/transcript comparisons broke;
 *  ② entry ids/parentIds stayed in the SDK hex space instead of the view key
 *    space (messageKey / type:tsMs), so branchChildren / breadcrumb / leafPath
 *    lookups silently missed — or, with same-ms same-role collisions, children
 *    reparented onto the wrong duplicate;
 *  ③ parentId pointed at a non-message entry (model_change/custom), which
 *    tree consumers cannot link through — it must resolve to the nearest
 *    MESSAGE ancestor's (suffixed) view id;
 *  ④ snapshot.cursor received the entry count instead of the journal seq
 *    tail, so the GUI's M1.4 watermark seeded below every live record and
 *    live frames were dropped as "replays";
 *  ⑤ the 256-byte title slot line never reached header.title, so recovered
 *    sessions lost their display name.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { snapshotFromJsonl } from "../../src/daemon/jsonl-snapshot";

const dirs: string[] = [];

afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function writeTranscript(lines: string[]): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-snapshot-test-"));
	dirs.push(d);
	const file = path.join(d, "session.jsonl");
	fs.writeFileSync(file, lines.join("\n") + "\n");
	return file;
}

interface Rec {
	type: string;
	id: string;
	parentId?: string | null;
	timestamp: string;
	message?: { role: string; timestamp: number; content?: unknown };
	[key: string]: unknown;
}

/** The snapshot schema types entries as unknown[] (forward-compat); tests
 *  assert the concrete projection contract, so narrow once per snapshot. */
interface SnapshotEntry {
	id: string;
	parentId: string | null;
	type: string;
	message?: { content?: unknown };
}

function entriesOf(snap: { entries: unknown[] }): SnapshotEntry[] {
	return snap.entries as unknown as SnapshotEntry[];
}

function msg(id: string, parentId: string | null, role: string, tsMs: number): Rec {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(tsMs).toISOString(),
		message: { role, timestamp: tsMs, content: `content-${id}` },
	};
}

/** One entry per surviving record family, hex ids, mixed parent chains —
 * including non-message parents and a same-ms same-type collision. */
function fullFamilyTranscript(): string[] {
	const t0 = Date.parse("2026-09-27T10:00:00.000Z");
	const sameMs = Date.parse("2026-09-27T10:05:00.000Z");
	const recs: Rec[] = [
		msg("hex-u1", null, "user", t0),
		msg("hex-a1", "hex-u1", "assistant", t0 + 1000),
		{
			type: "custom",
			id: "hex-c1",
			parentId: "hex-a1",
			timestamp: new Date(t0 + 2000).toISOString(),
			customType: "advisor",
		},
		{ type: "custom_message", id: "hex-cm1", parentId: "hex-c1", timestamp: new Date(t0 + 3000).toISOString() },
		{ type: "compaction", id: "hex-k1", parentId: "hex-cm1", timestamp: new Date(t0 + 4000).toISOString() },
		{
			type: "model_change",
			id: "hex-m1",
			parentId: "hex-k1",
			timestamp: new Date(t0 + 5000).toISOString(),
			modelId: "k2",
		},
		{ type: "custom", id: "hex-cu1", parentId: "hex-m1", timestamp: new Date(sameMs).toISOString() },
		{ type: "custom", id: "hex-cu2", parentId: "hex-cu1", timestamp: new Date(sameMs).toISOString() },
	];
	return [
		JSON.stringify({ type: "session", id: "sess-1", timestamp: new Date(t0).toISOString(), cwd: "C:\\proj" }),
		`{"type":"title","title":"Quarterly Review"}${" ".repeat(220)}`,
		...recs.map(r => JSON.stringify(r)),
	];
}

describe("snapshotFromJsonl", () => {
	test("preserves every record family and skips corrupt lines (fail-soft)", async () => {
		const lines = fullFamilyTranscript();
		lines.splice(3, 0, "not-json{{{", JSON.stringify({ noType: true }));
		const snap = await snapshotFromJsonl(writeTranscript(lines), "sess-1", 42);
		const entries = entriesOf(snap);
		const types = entries.map(e => e.type);
		for (const family of ["message", "custom", "custom_message", "compaction", "model_change"]) {
			expect(types.filter(t => t === family).length).toBeGreaterThanOrEqual(1);
		}
		// 8 real records; the corrupt and type-less lines contributed nothing.
		expect(entries).toHaveLength(8);
	});

	test("rekeys message ids into messageKey view space with collision suffixes", async () => {
		const snap = await snapshotFromJsonl(writeTranscript(fullFamilyTranscript()), "sess-1", 42);
		const entries = entriesOf(snap);
		const ids = entries.map(e => e.id);
		expect(new Set(ids).size).toBe(ids.length);
		const u1 = entries.find(e => e.message?.content === "content-hex-u1");
		expect(u1).toBeDefined();
		expect(u1?.id).toMatch(/^user:\d+$/);
		// Same-ms same-type pair: second one must carry a #n suffix, both unique.
		const customs = entries.filter(e => e.type === "custom");
		expect(customs).toHaveLength(3);
		const suffixed = customs.filter(e => /#\d+$/.test(e.id));
		expect(suffixed).toHaveLength(1);
	});

	test("parentId resolves to the nearest message ancestor's suffixed view id (never dangling)", async () => {
		const snap = await snapshotFromJsonl(writeTranscript(fullFamilyTranscript()), "sess-1", 42);
		const entries = entriesOf(snap);
		const idSet = new Set(entries.map(e => e.id));
		// Records keep transcript order in the snapshot (header/title lines are
		// consumed, corrupt lines contribute nothing) — so the original hex
		// order indexes the projected entries directly.
		const ORIG_ORDER = ["hex-u1", "hex-a1", "hex-c1", "hex-cm1", "hex-k1", "hex-m1", "hex-cu1", "hex-cu2"];
		const byOrig = (orig: string) => entries[ORIG_ORDER.indexOf(orig)];
		const viewIdOf = (orig: string): string => byOrig(orig).id;
		const parentOf = (orig: string): string | null => byOrig(orig).parentId;

		expect(parentOf("hex-u1")).toBeNull();
		// Message child of message: direct link.
		expect(parentOf("hex-a1")).toBe(viewIdOf("hex-u1"));
		// Non-message children chain UP to the nearest message ancestor (a1),
		// not to their literal non-message parent.
		expect(parentOf("hex-c1")).toBe(viewIdOf("hex-a1"));
		expect(parentOf("hex-cm1")).toBe(viewIdOf("hex-a1"));
		expect(parentOf("hex-k1")).toBe(viewIdOf("hex-a1"));
		expect(parentOf("hex-m1")).toBe(viewIdOf("hex-a1"));
		// Every parentId is null or resolves inside this snapshot — no hex
		// leftovers, no dangles.
		for (const e of entries) {
			if (e.parentId !== null) expect(idSet.has(e.parentId)).toBe(true);
		}
	});

	test("cursor is the caller's journal tail, not the entry count", async () => {
		const snap = await snapshotFromJsonl(writeTranscript(fullFamilyTranscript()), "sess-1", 987);
		expect(entriesOf(snap)).toHaveLength(8);
		expect(snap.cursor).toBe(987);
	});

	test("harvests the title slot line into header.title", async () => {
		const snap = await snapshotFromJsonl(writeTranscript(fullFamilyTranscript()), "sess-1", 0);
		const header = snap.header as { title?: string; cwd?: string };
		expect(header.title).toBe("Quarterly Review");
		expect(header.cwd).toBe("C:\\proj");
	});

	test("unknown future record types pass through untouched", async () => {
		const lines = fullFamilyTranscript();
		lines.splice(
			2,
			0,
			JSON.stringify({
				type: "future_thing",
				id: "hex-f1",
				parentId: null,
				timestamp: "2026-09-27T10:00:30.000Z",
				payload: 1,
			}),
		);
		const snap = await snapshotFromJsonl(writeTranscript(lines), "sess-1", 0);
		const future = entriesOf(snap).find(e => e.type === "future_thing");
		expect(future).toBeDefined();
		expect((future as { payload?: number }).payload).toBe(1);
	});
});
