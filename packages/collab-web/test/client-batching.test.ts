import { describe, expect, it } from "bun:test";
import type { AgentSnapshot, SessionHeader, SessionState } from "@musepi/pi-wire";
import { COLLAB_PROTO, encodeBase64Url } from "@musepi/collab-proto";
import { GuestClient } from "../src/lib/client";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;

const HEADER: SessionHeader = { type: "session", id: "s1", timestamp: "2026-06-12T00:00:00Z", cwd: "/work" };
const STATE: SessionState = { isStreaming: true, queuedMessageCount: 0, cwd: "/work", participants: [] };

function liveClient(): GuestClient {
	const client = new GuestClient(LINK, "tester");
	client.applyFrameForTest({
		t: "welcome",
		proto: COLLAB_PROTO,
		header: HEADER,
		state: STATE,
		agents: [] as AgentSnapshot[],
		entryCount: 0,
	});
	return client;
}

describe("GuestClient notification batching", () => {
	it("keeps the snapshot synchronous while deferring notifications to a microtask", async () => {
		const client = liveClient();
		let notified = 0;
		client.subscribe(() => {
			notified++;
		});

		client.applyFrameForTest({ t: "event", event: { type: "notice", level: "info", message: "a", source: "bench" } });
		client.applyFrameForTest({ t: "event", event: { type: "notice", level: "info", message: "b", source: "bench" } });
		client.applyFrameForTest({ t: "event", event: { type: "notice", level: "info", message: "c", source: "bench" } });

		// Snapshot is the latest applied state immediately...
		expect(client.getSnapshot().notices.map(n => n.message)).toEqual(["a", "b", "c"]);
		expect(client.getSnapshot().phase).toBe("live");
		// ...but the notification is deferred: one window flush, not three.
		expect(notified).toBe(0);

		await Bun.sleep(25); // > BATCH_WINDOW_MS (16)

		expect(notified).toBe(1);
	});

	it("coalesces a second frame burst into its own notification", async () => {
		const client = liveClient();
		let notified = 0;
		client.subscribe(() => {
			notified++;
		});

		client.applyFrameForTest({ t: "event", event: { type: "notice", level: "info", message: "a", source: "bench" } });
		await Bun.sleep(25);
		expect(notified).toBe(1);

		client.applyFrameForTest({ t: "event", event: { type: "notice", level: "info", message: "b", source: "bench" } });
		client.applyFrameForTest({ t: "event", event: { type: "notice", level: "info", message: "c", source: "bench" } });
		await Bun.sleep(25);
		expect(notified).toBe(2);
		expect(client.getSnapshot().notices.map(n => n.message)).toEqual(["a", "b", "c"]);
	});
});
