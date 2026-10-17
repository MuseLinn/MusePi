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
 *  ③ parentId keeps the DIRECT hex parent's view id (chain fidelity):
 *    skipping non-message nodes (nearest-message-ancestor) forked phantom
 *    sibling branches in the map — the post-advisor assistant reparented
 *    under the pre-advisor one (real session 01a13e95 "3-1/3-2").
 *    Message-only tree consumers walk up through non-message nodes
 *    themselves; every parentId is still null-or-resolving;
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
import { readSdkNewestTimestamp, snapshotFromJsonl } from "../../src/daemon/jsonl-snapshot";

const dirs: string[] = [];

afterEach(() => {
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function writeTranscript(lines: string[]): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "jsonl-snapshot-test-"));
	dirs.push(d);
	const file = path.join(d, "session.jsonl");
	fs.writeFileSync(file, `${lines.join("\n")}\n`);
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

	test("parentId keeps the direct hex parent's suffixed view id (never dangling, never skipping)", async () => {
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
		// Direct linkage down the whole chain — non-message nodes stay on
		// it (c1 under a1, cm1 under c1, k1 under cm1, m1 under k1).
		expect(parentOf("hex-c1")).toBe(viewIdOf("hex-a1"));
		expect(parentOf("hex-cm1")).toBe(viewIdOf("hex-c1"));
		expect(parentOf("hex-k1")).toBe(viewIdOf("hex-cm1"));
		expect(parentOf("hex-m1")).toBe(viewIdOf("hex-k1"));
		// Every parentId is null or resolves inside this snapshot — no hex
		// leftovers, no dangles.
		for (const e of entries) {
			if (e.parentId !== null) expect(idSet.has(e.parentId)).toBe(true);
		}
	});

	test("keeps non-message nodes on the parent chain (advisor is not forked, real session 01a13e95)", async () => {
		// The map/trajectory read parent chains: skipping non-message nodes
		// (nearest-message-ancestor remap) silently reparented the post-
		// advisor assistant UNDER the pre-advisor one, so the advisor card
		// and the next user message shared one parent turn-start and rendered
		// as phantom sibling branches "3-1/3-2" on two lanes. Direct parents
		// keep the advisor on the chain: every parentId resolves in-snapshot
		// and the user's ancestry includes the advisor card.
		const t0 = Date.parse("2026-10-15T08:03:00.000Z");
		const advTs = t0 + 123627;
		const lines = [
			JSON.stringify({ type: "session", id: "sess-adv", timestamp: new Date(t0).toISOString(), cwd: "C:\\proj" }),
			JSON.stringify(msg("hex-u1", null, "user", t0)),
			JSON.stringify(msg("hex-a1", "hex-u1", "assistant", t0 + 1000)),
			JSON.stringify({
				type: "custom_message",
				id: "hex-adv",
				parentId: "hex-a1",
				timestamp: new Date(advTs).toISOString(),
				customType: "advisor",
				display: true,
				details: { notes: [{ note: "capability list note" }] },
			}),
			JSON.stringify(msg("hex-a2", "hex-adv", "assistant", t0 + 3000)),
			JSON.stringify({
				type: "thinking_level_change",
				id: "hex-tlc",
				parentId: "hex-a2",
				timestamp: new Date(t0 + 4000).toISOString(),
			}),
			JSON.stringify(msg("hex-u2", "hex-tlc", "user", t0 + 5000)),
		];
		const snap = await snapshotFromJsonl(writeTranscript(lines), "sess-adv", 7);
		const entries = entriesOf(snap);
		const byId = new Map(entries.map(e => [e.id, e]));
		const adv = entries.find(e => e.type === "custom_message");
		const a2 = entries.find(e => e.type === "message" && e.message?.content === "content-hex-a2");
		const u2 = entries.find(e => e.type === "message" && e.message?.content === "content-hex-u2");
		const tlc = entries.find(e => e.type === "thinking_level_change");
		if (!adv || !a2 || !u2 || !tlc) throw new Error("fixture entries missing");
		// Direct linkage: post-advisor assistant hangs off the advisor card,
		// the next user message off the level-change node — nothing skipped.
		expect(a2.parentId).toBe(adv.id);
		expect(u2.parentId).toBe(tlc.id);
		// The user's ancestry walks THROUGH the advisor card (no phantom fork).
		const ancestors: string[] = [];
		let cur: string | null = u2.parentId ?? null;
		while (cur !== null) {
			ancestors.push(cur);
			cur = byId.get(cur)?.parentId ?? null;
		}
		expect(ancestors).toContain(adv.id);
		for (const e of entries) {
			if (e.parentId !== null) expect(byId.has(e.parentId)).toBe(true);
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

describe("readSdkNewestTimestamp", () => {
	test("returns the tail entry timestamp, skipping torn/corrupt tail lines", async () => {
		const t0 = Date.parse("2026-09-27T10:00:00.000Z");
		const file = writeTranscript([
			JSON.stringify({
				type: "session",
				id: "s",
				timestamp: new Date(t0).toISOString(),
				cwd: "C:\\x",
			}),
			JSON.stringify(msg("a", null, "user", t0)),
			JSON.stringify(msg("b", "a", "assistant", t0 + 5000)),
			"{corrupt tail",
		]);
		// The corrupt tail line is skipped; the newest COMPLETE record wins.
		expect(await readSdkNewestTimestamp(file)).toBe(t0 + 5000);
	});

	test("returns null for missing or timestamp-less files", async () => {
		expect(await readSdkNewestTimestamp(path.join(os.tmpdir(), "jsonl-snapshot-nope.jsonl"))).toBeNull();
		const file = writeTranscript(['{"type":"session","id":"s"}']);
		expect(await readSdkNewestTimestamp(file)).toBeNull();
	});
});
// probe-marker-12345
