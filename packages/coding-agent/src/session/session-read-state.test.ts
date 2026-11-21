import { describe, expect, it } from "bun:test";
import {
	applyMarkRead,
	applyMarkUnread,
	applyTurnCompletion,
	deriveReadState,
	emptyReadRecord,
	normalizeReadRecord,
} from "./session-read-state";

const AT = "2026-11-21T10:00:00.000Z";

describe("session read state model", () => {
	it("a completion nobody watched reads unread", () => {
		const record = applyTurnCompletion(emptyReadRecord(), { failed: false, watched: false, at: AT });
		expect(deriveReadState("s1", record)).toMatchObject({
			unread: true,
			failed: false,
			completedTurn: 1,
			readTurn: 0,
		});
	});

	it("a completion of a watched session is read as it lands", () => {
		const record = applyTurnCompletion(emptyReadRecord(), { failed: true, watched: true, at: AT });
		expect(deriveReadState("s1", record)).toMatchObject({ unread: false, failed: false, readTurn: 1 });
	});

	it("failure is shown only while the failed turn is still unread", () => {
		const failed = applyTurnCompletion(emptyReadRecord(), { failed: true, watched: false, at: AT });
		expect(deriveReadState("s1", failed).failed).toBe(true);
		expect(deriveReadState("s1", applyMarkRead(failed)).failed).toBe(false);
	});

	it("manual unread pins the session and survives an automatic read", () => {
		const pinned = applyMarkUnread(emptyReadRecord());
		expect(deriveReadState("s1", pinned).unread).toBe(true);
		// The user keeps the session on screen: the next completion advances the
		// read cursor but must not clear the manual pin.
		const watched = applyTurnCompletion(pinned, { failed: false, watched: true, at: AT });
		expect(deriveReadState("s1", watched)).toMatchObject({ unread: true, manualUnread: true, readTurn: 1 });
		// Only an explicit read clears it.
		expect(deriveReadState("s1", applyMarkRead(watched))).toMatchObject({
			unread: false,
			manualUnread: false,
			readTurn: 1,
		});
	});

	it("an explicit read after several unread completions catches up to the latest", () => {
		let record = emptyReadRecord();
		record = applyTurnCompletion(record, { failed: false, watched: false, at: AT });
		record = applyTurnCompletion(record, { failed: true, watched: false, at: AT });
		expect(deriveReadState("s1", record)).toMatchObject({ unread: true, failed: true, completedTurn: 2 });
		expect(deriveReadState("s1", applyMarkRead(record))).toMatchObject({
			unread: false,
			failed: false,
			readTurn: 2,
		});
	});

	it("normalizes malformed persisted records instead of trusting them", () => {
		expect(normalizeReadRecord(null)).toEqual(emptyReadRecord());
		expect(normalizeReadRecord({ completedTurn: -3, readTurn: "x", manualUnread: "yes" })).toEqual(emptyReadRecord());
		// readTurn can never exceed completedTurn (a torn/edited journal must not
		// hide the next completion).
		expect(normalizeReadRecord({ completedTurn: 2, readTurn: 9, lastFailed: true, completedAt: AT })).toEqual({
			completedTurn: 2,
			readTurn: 2,
			lastFailed: true,
			manualUnread: false,
			completedAt: AT,
		});
	});
});
