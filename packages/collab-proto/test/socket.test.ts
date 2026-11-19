/**
 * Contract: both collab clients (browser and terminal) share one room-closed
 * retry budget, so a host blip is survivable in exactly the same way in both.
 * The relay retains a dropped host's room for 30 s; a guest may retry 4001
 * inside that budget, and after it 4001 turns fatal — a room that is really
 * gone answers 4004 first anyway.
 */
import { describe, expect, it } from "bun:test";
import {
	CLOSE_ROOM_CLOSED,
	ROOM_CLOSED_MAX_RETRIES,
	ROOM_CLOSED_RETRY_MS,
	shouldRetryRoomClosed,
} from "../src/index.ts";

describe("room-closed retry budget", () => {
	it("pins the relay contract code", () => {
		expect(CLOSE_ROOM_CLOSED).toBe(4001);
		expect(ROOM_CLOSED_RETRY_MS).toBe(30_000);
		expect(ROOM_CLOSED_MAX_RETRIES).toBe(5);
	});

	it("allows retries inside the window", () => {
		expect(shouldRetryRoomClosed({ since: 0, retries: 1 }, 0)).toBe(true);
		expect(shouldRetryRoomClosed({ since: 0, retries: ROOM_CLOSED_MAX_RETRIES }, ROOM_CLOSED_RETRY_MS - 1)).toBe(
			true,
		);
	});

	it("stops at the window edge", () => {
		expect(shouldRetryRoomClosed({ since: 0, retries: 1 }, ROOM_CLOSED_RETRY_MS)).toBe(false);
		expect(shouldRetryRoomClosed({ since: 0, retries: 1 }, ROOM_CLOSED_RETRY_MS + 1)).toBe(false);
	});

	it("stops after the retry count", () => {
		expect(shouldRetryRoomClosed({ since: 0, retries: ROOM_CLOSED_MAX_RETRIES + 1 }, 1)).toBe(false);
	});
});
