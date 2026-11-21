import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionReadStateService } from "./session-read-state-service";

const dirs: string[] = [];

function newStore(): { service: SessionReadStateService; storePath: string } {
	const dir = mkdtempSync(join(tmpdir(), "musepi-read-state-"));
	dirs.push(dir);
	const storePath = join(dir, "session-read-state.json");
	return { service: new SessionReadStateService({ storePath }), storePath };
}

afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs.length = 0;
});

describe("SessionReadStateService", () => {
	it("records a completed turn as unread and list exposes it", async () => {
		const { service } = newStore();
		await service.recordCompletion({ sessionId: "s1", failed: false, watched: false, at: "2026-11-21T10:00:00Z" });
		expect(service.stateOf("s1")).toMatchObject({ unread: true, failed: false });
		const { states } = await service.list();
		expect(states).toEqual([expect.objectContaining({ sessionId: "s1", unread: true })]);
		// A session with no completion is read, not "unknown".
		expect(service.stateOf("never-ran")).toMatchObject({ unread: false, failed: false });
	});

	it("keeps the state across a daemon restart", async () => {
		const { service, storePath } = newStore();
		await service.recordCompletion({ sessionId: "s1", failed: true, watched: false });
		await service.mark({ sessionId: "s2", unread: true });
		await service.recordCompletion({ sessionId: "s3", failed: false, watched: true });

		const restarted = new SessionReadStateService({ storePath });
		expect(restarted.stateOf("s1")).toMatchObject({ unread: true, failed: true, completedTurn: 1 });
		expect(restarted.stateOf("s2")).toMatchObject({ unread: true, manualUnread: true });
		expect(restarted.stateOf("s3")).toMatchObject({ unread: false });
	});

	it("mark read clears unread and the failure marker; mark unread pins", async () => {
		const { service } = newStore();
		await service.recordCompletion({ sessionId: "s1", failed: true, watched: false });
		expect(await service.mark({ sessionId: "s1", read: true })).toMatchObject({ unread: false, failed: false });
		expect(await service.mark({ sessionId: "s1", unread: true })).toMatchObject({ unread: true, failed: true });
		// The pin outlives a watched completion (automatic read must not clear it).
		await service.recordCompletion({ sessionId: "s1", failed: false, watched: true });
		expect(service.stateOf("s1")).toMatchObject({ unread: true, manualUnread: true, failed: false });
		expect(await service.mark({ sessionId: "s1", read: true })).toMatchObject({ unread: false, manualUnread: false });
	});

	it("mark all read clears every tracked session, including manual pins", async () => {
		const { service } = newStore();
		await service.recordCompletion({ sessionId: "s1", failed: false, watched: false });
		await service.mark({ sessionId: "s2", unread: true });
		await service.recordCompletion({ sessionId: "s3", failed: true, watched: false });
		expect(await service.markAll({ sessionIds: ["s1", "s2", "s3", "never-ran"] })).toEqual({ marked: 3 });
		expect(service.stateOf("s1").unread).toBe(false);
		expect(service.stateOf("s2")).toMatchObject({ unread: false, manualUnread: false });
		expect(service.stateOf("s3")).toMatchObject({ unread: false, failed: false });
		// Nothing tracked → no write is needed and the answer says zero.
		expect(await service.markAll()).toEqual({ marked: 0 });
	});

	it("two clients marking the same session: the later mark is the answer", async () => {
		const { service } = newStore();
		await service.recordCompletion({ sessionId: "s1", failed: false, watched: false });
		// Desktop marks read, phone marks unread right after (and vice versa):
		// one in-memory record means the last call wins for every client.
		await service.mark({ sessionId: "s1", read: true });
		await service.mark({ sessionId: "s1", unread: true });
		expect(service.stateOf("s1").unread).toBe(true);
		await service.mark({ sessionId: "s1", read: true });
		expect(service.stateOf("s1").unread).toBe(false);
		const { states } = await service.list();
		expect(states.find(state => state.sessionId === "s1")?.unread).toBe(false);
	});

	it("rejects ambiguous or incomplete marks", async () => {
		const { service } = newStore();
		expect(await service.mark({})).toEqual({ error: "sessionId required" });
		expect(await service.mark({ sessionId: "s1" })).toEqual({ error: "exactly one of read/unread required" });
		expect(await service.mark({ sessionId: "s1", read: true, unread: true })).toEqual({
			error: "exactly one of read/unread required",
		});
	});
});
