import { describe, expect, it } from "bun:test";
import { COLLAB_PROTO, encodeBase64Url } from "@musepi/collab-proto";
import type { AgentSnapshot, SessionHeader, SessionState } from "@musepi/pi-wire";
import { GuestClient } from "../src/lib/client";

const LINK = `roomroomroom1234#${encodeBase64Url(new Uint8Array(32))}`;
const BAD_LINK = "not-a-collab-link";

const HEADER: SessionHeader = { type: "session", id: "s1", timestamp: "2026-06-12T00:00:00Z", cwd: "/work" };
const STATE: SessionState = { isStreaming: false, queuedMessageCount: 0, cwd: "/work", participants: [] };
const AGENTS: AgentSnapshot[] = [];

function welcomeFrame(): Parameters<GuestClient["applyFrameForTest"]>[0] {
	return { t: "welcome", proto: COLLAB_PROTO, header: HEADER, state: STATE, agents: AGENTS, entryCount: 0 };
}

describe("GuestClient onWelcome — connection-success persistence hook", () => {
	it("fires exactly once when the first welcome frame lands (connect succeeded)", () => {
		const client = new GuestClient(LINK, "tester");
		let fired = 0;
		client.onWelcome = () => fired++;
		client.applyFrameForTest(welcomeFrame());
		expect(fired).toBe(1);
	});

	it("does NOT re-fire on a reconnect welcome (already welcomed — no duplicate record)", () => {
		const client = new GuestClient(LINK, "tester");
		let fired = 0;
		client.onWelcome = () => fired++;
		client.applyFrameForTest(welcomeFrame());
		// Reconnect streams a fresh welcome for the same session.
		client.applyFrameForTest(welcomeFrame());
		expect(fired).toBe(1);
	});

	it("never fires without a welcome — a stuck/timed-out connect records nothing", () => {
		const client = new GuestClient(LINK, "tester");
		let fired = 0;
		client.onWelcome = () => fired++;
		// Only a snapshot chunk arrives (no welcome) — nothing to persist.
		client.applyFrameForTest({ t: "snapshot-chunk", entries: [], final: true });
		expect(fired).toBe(0);
	});

	it("a malformed link throws at construction — App catches it and never reaches onWelcome", () => {
		// Mirrors App.connect: the GuestClient constructor validates the link
		// before any frame can arrive, so a bad link can never fire onWelcome.
		expect(() => new GuestClient(BAD_LINK, "tester")).toThrow();
	});
});
