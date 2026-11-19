import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { CollabHost } from "@musepi/pi-coding-agent/collab/host";
import type { InteractiveModeContext } from "@musepi/pi-coding-agent/modes/types";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

function makeHostContext(): InteractiveModeContext {
	return {
		settings: { get: () => "" },
		sessionManager: {
			getSessionId: () => "sess-1",
			getCwd: () => "/tmp",
			snapshotForReplication: () => ({ header: { type: "session", id: "sess-1" }, entries: [] }),
			onEntryAppended: undefined,
		},
		session: {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "test",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: () => () => {},
			emitNotice: () => {},
			promptCustomMessage: () => Promise.resolve(),
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	} as unknown as InteractiveModeContext;
}

describe("CollabHost end notification", () => {
	beforeAll(() => installInMemoryRelay());
	afterAll(() => uninstallInMemoryRelay());

	it("reports stopped and calls onEnded exactly once", async () => {
		const host = new CollabHost(makeHostContext());
		await host.start("ws://localhost:8787");
		const reasons: string[] = [];
		host.onEnded = reason => reasons.push(reason);
		expect(host.stopped).toBe(false);

		await host.stop("stopped from gui");
		expect(host.stopped).toBe(true);
		expect(reasons).toEqual(["stopped from gui"]);

		// A second stop is a no-op: the owner's cleanup must not run twice.
		await host.stop("again");
		expect(reasons).toEqual(["stopped from gui"]);
	});

	it("stopping a host that never connected still notifies its owner once", async () => {
		const host = new CollabHost(makeHostContext());
		let ended = 0;
		host.onEnded = () => ended++;
		await host.stop("never started");
		expect(host.stopped).toBe(true);
		expect(ended).toBe(1);
	});
});
