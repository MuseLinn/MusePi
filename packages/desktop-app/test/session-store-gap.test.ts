import { describe, expect, it } from "bun:test";
import { GuiSessionStore } from "../src/lib/session-store";

/**
 * M1.4 watermark / gap-reorder contracts (GuiSessionStore).
 *
 * The daemon stamps the snapshot cursor with the journal tail and numbers
 * every kind:"event" envelope with the journal record seq. The store must:
 *
 * - apply seqs contiguously from watermark+1 and SKIP anything ≤ watermark
 *   (catchup overlap / replays) — regression: re-applying overlapped records
 *   duplicates transcript entries;
 * - hold seqs > watermark+1 in order and request catchup from the watermark —
 *   regression: applying past a hole shows state built on missing frames,
 *   and the transcript renders out of order;
 * - drain the reorder buffer strictly in seq order when the missing seqs
 *   arrive (live or via the catchup replay);
 * - escalate to onResyncRequired when the daemon answers resyncRequired.
 */

/** Sequenced kind:"event" envelope — thinking_level_changed projects to a
 *  ThinkingLevelChangeEntry carrying the payload's thinkingLevel, so entry
 *  order is observable without touching private fields. */
function seqEvent(seq: number) {
	return {
		kind: "event" as const,
		seq,
		payload: { type: "thinking_level_changed", thinkingLevel: `lvl-${seq}` },
	};
}

function levels(store: GuiSessionStore): string[] {
	return store.getSnapshot().entries.map(e => (e as { thinkingLevel?: string }).thinkingLevel ?? "?");
}

/** apply() frame-coalesces via a microtask flush — yield twice before reading. */
async function settle(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe("GuiSessionStore watermark gate (M1.4)", () => {
	it("buffers a dropped frame, requests catchup from the watermark, and drains strictly in order", async () => {
		// Regression: seq 5 arriving while 4 is missing must NOT be applied
		// (no hole-then-burst transcript) — it lands only after 4 fills the
		// gap, and the catchup request carries the watermark (3), not the
		// stranded seq.
		const gaps: number[] = [];
		const store = new GuiSessionStore("s1", { entries: [], cursor: 0 }, "/tmp", {
			onGapDetected: (afterSeq: number) => {
				gaps.push(afterSeq);
				return Promise.resolve({ resyncRequired: false });
			},
		});
		for (const n of [1, 2, 3]) store.apply(seqEvent(n));
		await settle();
		expect(levels(store)).toEqual(["lvl-1", "lvl-2", "lvl-3"]);

		store.apply(seqEvent(5));
		await settle();
		expect(levels(store)).toEqual(["lvl-1", "lvl-2", "lvl-3"]);
		expect(gaps).toEqual([3]);

		store.apply(seqEvent(4));
		await settle();
		expect(levels(store)).toEqual(["lvl-1", "lvl-2", "lvl-3", "lvl-4", "lvl-5"]);
		expect(gaps).toEqual([3]);

		// Watermark is now 5: a replay of already-applied seqs must be
		// dropped, not re-applied — regression: catchup overlap duplicates
		// transcript entries.
		store.apply(seqEvent(4));
		store.apply(seqEvent(5));
		await settle();
		expect(levels(store)).toEqual(["lvl-1", "lvl-2", "lvl-3", "lvl-4", "lvl-5"]);
		expect(gaps).toEqual([3]);
	});

	it("treats the snapshot cursor as the watermark: older seqs are dropped", async () => {
		// Regression: a client re-subscribing with cursor=10 that then
		// receives catchup records for seqs ≤ 10 would duplicate entries.
		const store = new GuiSessionStore("s1", { entries: [], cursor: 10 }, "/tmp");
		store.apply(seqEvent(5));
		store.apply(seqEvent(11));
		await settle();
		expect(levels(store)).toEqual(["lvl-11"]);
	});

	it("drains a multi-event hole in seq order when the missing seq arrives late", async () => {
		// Batch [6,7,9] then 8: 9 must not jump ahead of 8 — regression:
		// out-of-order drain corrupts entry order (messages are keyed, but
		// non-message entries append) and the watermark ends up wrong.
		const gaps: number[] = [];
		const store = new GuiSessionStore("s1", { entries: [], cursor: 5 }, "/tmp", {
			onGapDetected: (afterSeq: number) => {
				gaps.push(afterSeq);
				return Promise.resolve({ resyncRequired: false });
			},
		});
		for (const n of [6, 7, 9]) store.apply(seqEvent(n));
		await settle();
		expect(levels(store)).toEqual(["lvl-6", "lvl-7"]);
		expect(gaps).toEqual([7]);

		store.apply(seqEvent(8));
		await settle();
		expect(levels(store)).toEqual(["lvl-6", "lvl-7", "lvl-8", "lvl-9"]);
	});

	it("escalates to onResyncRequired when catchup answers resyncRequired", async () => {
		// Regression: ignoring the resyncRequired answer leaves the store
		// buffering forever — the gap is unrecoverable, the UI must fall
		// back to a whole-snapshot re-subscribe.
		let resyncs = 0;
		const store = new GuiSessionStore("s1", { entries: [], cursor: 0 }, "/tmp", {
			onGapDetected: () => Promise.resolve({ resyncRequired: true }),
			onResyncRequired: () => {
				resyncs += 1;
			},
		});
		store.apply(seqEvent(1));
		store.apply(seqEvent(3));
		await settle();
		expect(resyncs).toBe(1);
	});

	it("unsequenced legacy envelopes (seq 0) stay ungated", async () => {
		// Older daemons / test fixtures send seq 0 — gating them would freeze
		// the transcript at the watermark.
		const store = new GuiSessionStore("s1", { entries: [], cursor: 7 }, "/tmp");
		store.apply({ kind: "event", seq: 0, payload: { type: "thinking_level_changed", thinkingLevel: "legacy" } });
		await settle();
		expect(levels(store)).toEqual(["legacy"]);
	});
});

describe("P0-1: global-event envelopes never touch the journal watermark", () => {
	const globalEvent = (seq: number) => ({
		kind: "global-event" as const,
		seq,
		payload: { type: "extensions.changed", at: 1727600000000 + seq },
	});

	it("a global event before the first journal record does not get it dropped as a replay", async () => {
		// Regression (silent message loss): global broadcasts rode kind:"event"
		// with their own seq counter. On a fresh session (watermark 0) the first
		// global event carried seq 1 → watermark jumped to 1 → the real journal
		// record seq 1 was then dropped as an already-applied "replay" and the
		// transcript lost a message forever.
		const store = new GuiSessionStore("s1", { entries: [], cursor: 0 }, "/tmp");
		store.apply(globalEvent(1));
		store.apply(globalEvent(2));
		await settle();

		store.apply(seqEvent(1));
		await settle();
		expect(levels(store)).toEqual(["lvl-1"]);
	});

	it("an install-progress storm triggers no catchup and no resync", async () => {
		// Regression (resync storm): each global seq beyond watermark+1 was
		// buffered as a "hole" → catchup RPC + 10s gap timer → whole-session
		// resync. STT/TTS download progress broadcasts fired these in rapid
		// succession, repeatedly resetting every open session.
		const gaps: number[] = [];
		let resyncs = 0;
		const store = new GuiSessionStore("s1", { entries: [], cursor: 0 }, "/tmp", {
			onGapDetected: (afterSeq: number) => {
				gaps.push(afterSeq);
				return Promise.resolve({ resyncRequired: false });
			},
			onResyncRequired: () => {
				resyncs += 1;
			},
		});
		// 40 consecutive download-progress broadcasts, seqs 1..40 — with the
		// old kind:"event" every one past the watermark was a fresh "gap".
		for (let n = 1; n <= 40; n++) store.apply(globalEvent(n));
		await settle();
		expect(gaps).toEqual([]);
		expect(resyncs).toBe(0);

		// The watermark is still 0: the first journal record applies normally.
		store.apply(seqEvent(1));
		await settle();
		expect(levels(store)).toEqual(["lvl-1"]);
	});
});
