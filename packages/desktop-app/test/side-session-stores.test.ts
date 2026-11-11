import { describe, expect, it } from "bun:test";
import type { StreamEvent } from "../src/lib/rpc";
import type { GuiSessionStore } from "../src/lib/session-store";
import {
	applySideSessionEvent,
	registerSideSessionStore,
	subscribeSideSessionEvents,
	unregisterSideSessionStore,
} from "../src/lib/side-session-stores";

function fakeStore(sessionId: string): { store: GuiSessionStore; applied: StreamEvent[] } {
	const applied: StreamEvent[] = [];
	const store = {
		sessionId,
		apply: (event: StreamEvent) => {
			applied.push(event);
		},
	} as unknown as GuiSessionStore;
	return { store, applied };
}

function event(sessionId: string, kind: string): StreamEvent {
	return { kind, sessionId, payload: {} } as StreamEvent;
}

describe("side-session store registry", () => {
	it("routes an envelope to the store that owns its session", () => {
		const { store, applied } = fakeStore("side-1");
		registerSideSessionStore(store);
		try {
			expect(applySideSessionEvent(event("side-1", "state"))).toBe(true);
			expect(applied).toHaveLength(1);
			expect(applied[0]?.kind).toBe("state");
		} finally {
			unregisterSideSessionStore("side-1");
		}
	});

	it("leaves envelopes for sessions without a side store to the active pump", () => {
		expect(applySideSessionEvent(event("other", "state"))).toBe(false);
	});

	it("delivers asks to the view instead of mutating the store", () => {
		const { store, applied } = fakeStore("side-2");
		const seen: StreamEvent[] = [];
		registerSideSessionStore(store);
		const unsubscribe = subscribeSideSessionEvents("side-2", e => seen.push(e));
		try {
			expect(applySideSessionEvent(event("side-2", "ask-request"))).toBe(true);
			expect(applied).toHaveLength(0);
			expect(seen.map(e => e.kind)).toEqual(["ask-request"]);
		} finally {
			unsubscribe();
			unregisterSideSessionStore("side-2");
		}
	});

	it("stops routing after the view unregisters", () => {
		const { store, applied } = fakeStore("side-3");
		registerSideSessionStore(store);
		unregisterSideSessionStore("side-3");
		expect(applySideSessionEvent(event("side-3", "state"))).toBe(false);
		expect(applied).toHaveLength(0);
	});
});
