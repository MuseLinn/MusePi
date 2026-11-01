import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { EventBatcher } from "../../src/daemon/event-batcher";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";
import * as downloader from "../../src/tts/downloader";

let gate = Promise.withResolvers<void>();
let workerError: string | null = null;

beforeEach(() => {
	gate = Promise.withResolvers<void>();
	workerError = null;
	vi.spyOn(downloader, "downloadTtsModel").mockImplementation(async (_key, onProgress, _signal, onError) => {
		onProgress?.({ stage: "stub", percent: 40 });
		await gate.promise;
		if (workerError) {
			onError?.(workerError);
			return false;
		}
		return true;
	});
	vi.spyOn(downloader, "isTtsModelCached").mockResolvedValue(false);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function makeHarness() {
	const sent: string[] = [];
	const batcher = new EventBatcher(message => sent.push(JSON.stringify(message)));
	const host = {
		cwd: () => "/tmp",
		get: () => undefined,
		emitEvent: (_conn: DaemonConnection, event: Parameters<EventBatcher["push"]>[0]) => batcher.push(event),
		setCollabToolProvider: () => {},
		setScheduledTaskProvider: () => {},
		setOnExtensionNotification: () => {},
	} as unknown as DaemonSessionHost;
	const server = new DaemonServer(host);
	const conn = { id: "test" } as unknown as DaemonConnection;
	const rpc = (method: string, params?: Record<string, unknown>): Promise<unknown> =>
		server.handle(method, params, conn);
	return { rpc, sent, flush: () => batcher.flushNow() };
}

async function waitUntilReleased(
	rpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
): Promise<void> {
	for (;;) {
		const status = (await rpc("tts.modelStatus", {})) as { downloads: string[] };
		if (status.downloads.length === 0) return;
	}
}

describe("tts.modelDownload RPC", () => {
	test("emits the worker failure text instead of only a generic download error", async () => {
		workerError = "Failed to download date.fst: HTTP 404";
		const { rpc, sent, flush } = makeHarness();
		await rpc("events.subscribe", {});
		await expect(rpc("tts.modelDownload", { modelKey: "melotts-zh" })).resolves.toEqual({ ok: true });
		gate.resolve();
		await waitUntilReleased(rpc);
		flush();
		const all = sent.join("\n");
		expect(all).toContain('"tts.downloadError"');
		expect(all).toContain("Failed to download date.fst: HTTP 404");
		expect(all).not.toContain("TTS model download failed");
		expect(all).not.toContain('"tts.downloadDone"');
	});
});
