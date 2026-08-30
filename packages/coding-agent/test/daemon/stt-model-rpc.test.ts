import { describe, expect, mock, test } from "bun:test";
import { EventBatcher } from "../../src/daemon/event-batcher";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";

/**
 * stt.modelStatus / stt.modelDownload RPC tests: the downloader is mocked so
 * no real model fetch (network / native worker) is attempted. Under test are
 * the RPC-layer contracts the GUI voice page depends on:
 *  - unknown/missing modelKey is rejected (resolveSttModelSpec would silently
 *    fall back to the default tier and download a GB-scale model unasked);
 *  - a second request while a tier is mid-download is idempotent (dedup), it
 *    must NOT start a parallel fetch into the same cache directory;
 *  - both terminal outcomes ride global events as stt.downloadDone /
 *    stt.downloadError, and the in-flight slot is released afterwards.
 */

// ── Mocked downloader state (reset per test) ──
let gate = Promise.withResolvers<void>();
let failWith: Error | null = null;
let downloadCalls = 0;

function resetDownloader(): void {
	gate = Promise.withResolvers<void>();
	failWith = null;
	downloadCalls = 0;
}

mock.module("../../src/stt/downloader", () => ({
	downloadSttModel: async (
		_key: string,
		onProgress?: (p: { status: string; percent: number; loaded: number; total: number; label: string }) => void,
	) => {
		downloadCalls++;
		onProgress?.({ status: "progress", percent: 40, loaded: 40, total: 100, label: "mock" });
		await gate.promise;
		if (failWith) throw failWith;
	},
	isSttModelCached: async () => false,
}));

function makeHarness() {
	const sent: string[] = [];
	// Real EventBatcher behind the stub host's emitEvent so stt.* events land
	// in `sent` (the server delegates emission to the host); flushNow() makes
	// assertion timing deterministic — no coalescing-window sleeps.
	const batcher = new EventBatcher(message => sent.push(JSON.stringify(message)));
	const host = {
		cwd: () => "/tmp",
		get: () => undefined,
		emitEvent: (_conn: DaemonConnection, event: Parameters<EventBatcher["push"]>[0]) => batcher.push(event),
		setCollabToolProvider: () => {},
		setOnExtensionNotification: () => {},
	} as unknown as DaemonSessionHost;
	const server = new DaemonServer(host);
	const conn = { id: "test" } as unknown as DaemonConnection;
	const rpc = (method: string, params?: Record<string, unknown>): Promise<unknown> =>
		server.handle(method, params, conn);
	return { rpc, sent, flush: () => batcher.flushNow() };
}

/** Deterministic wait for the in-flight slot release: poll modelStatus (each
 *  iteration awaits real async work) instead of guessing a sleep duration. */
async function waitUntilReleased(
	rpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
	for (;;) {
		const status = (await rpc("stt.modelStatus", {})) as { downloads: string[] };
		if (status.downloads.length === 0) return;
	}
}

describe("stt.modelDownload / stt.modelStatus RPCs", () => {
	test("rejects a missing or unknown modelKey instead of falling back to the default tier", async () => {
		resetDownloader();
		const { rpc } = makeHarness();
		await expect(rpc("stt.modelDownload", {})).rejects.toThrow("modelKey required");
		await expect(rpc("stt.modelDownload", { modelKey: "not-a-tier" })).rejects.toThrow("unknown speech model");
		expect(downloadCalls).toBe(0);
	});

	test("stt.modelStatus lists models and in-flight downloads", async () => {
		resetDownloader();
		const { rpc } = makeHarness();
		const idle = (await rpc("stt.modelStatus", {})) as {
			models: Array<{ key: string; label: string; cached: boolean }>;
			downloads: string[];
		};
		expect(idle.models.length).toBeGreaterThan(0);
		expect(
			idle.models.every(m => typeof m.key === "string" && typeof m.label === "string" && m.cached === false),
		).toBe(true);
		expect(idle.downloads).toEqual([]);

		await rpc("events.subscribe", {});
		const run = rpc("stt.modelDownload", { modelKey: "fast" });
		// Resolving {ok:true} means the slot is reserved and the fetch started.
		await expect(run).resolves.toEqual({ ok: true });
		const midFlight = (await rpc("stt.modelStatus", {})) as { downloads: string[] };
		expect(midFlight.downloads).toEqual(["fast"]);
		gate.resolve();
		await waitUntilReleased(rpc);
	});

	test("concurrent duplicate requests dedupe into one fetch and emit done", async () => {
		resetDownloader();
		const { rpc, sent, flush } = makeHarness();
		await rpc("events.subscribe", {});
		const first = rpc("stt.modelDownload", { modelKey: "fast" });
		const second = rpc("stt.modelDownload", { modelKey: "fast" });
		const results = (await Promise.all([first, second])) as Array<{ alreadyRunning?: boolean }>;
		// Exactly one request starts the fetch; the other reports alreadyRunning.
		expect(results.filter(r => r.alreadyRunning === undefined)).toHaveLength(1);
		expect(results.filter(r => r.alreadyRunning === true)).toHaveLength(1);
		expect(downloadCalls).toBe(1);

		gate.resolve();
		await waitUntilReleased(rpc);
		flush(); // drain the coalescing window deterministically
		const all = sent.join("\n");
		expect(all).toContain('"stt.downloadProgress"');
		expect(all).toContain('"stt.downloadDone"');
		expect(all).not.toContain('"stt.downloadError"');
	});

	test("a failed fetch emits stt.downloadError with the daemon message and releases its slot", async () => {
		resetDownloader();
		failWith = new Error("network unreachable");
		const { rpc, sent, flush } = makeHarness();
		await rpc("events.subscribe", {});
		await expect(rpc("stt.modelDownload", { modelKey: "fast" })).resolves.toEqual({ ok: true });
		gate.resolve();
		await waitUntilReleased(rpc);
		flush();
		const all = sent.join("\n");
		expect(all).toContain('"stt.downloadError"');
		expect(all).toContain("network unreachable");
		expect(all).not.toContain('"stt.downloadDone"');

		// The slot was released: a retry may start a fresh fetch.
		await rpc("stt.modelDownload", { modelKey: "fast" });
		expect(downloadCalls).toBe(2);
		gate.resolve();
	});
});
