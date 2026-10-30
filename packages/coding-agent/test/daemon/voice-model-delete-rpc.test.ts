import { afterEach, describe, expect, it, vi } from "bun:test";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";
import * as sttDownloader from "../../src/stt/downloader";
import * as ttsDownloader from "../../src/tts/downloader";

function harness() {
	const host = {
		cwd: () => "/tmp",
		get: () => undefined,
		emitEvent: () => {},
		setCollabToolProvider: () => {},
		setScheduledTaskProvider: () => {},
		setOnExtensionNotification: () => {},
	} as unknown as DaemonSessionHost;
	const server = new DaemonServer(host);
	const conn = { id: "test" } as unknown as DaemonConnection;
	return (method: string, params?: Record<string, unknown>) => server.handle(method, params, conn);
}

afterEach(() => vi.restoreAllMocks());

describe("local speech model deletion", () => {
	it("deletes STT and TTS caches through their owning services", async () => {
		const rpc = harness();
		const stt = vi.spyOn(sttDownloader, "deleteSttModel").mockResolvedValue();
		const tts = vi.spyOn(ttsDownloader, "deleteTtsModel").mockResolvedValue();
		expect(await rpc("stt.modelDelete", { modelKey: "fast" })).toEqual({ ok: true });
		expect(await rpc("tts.modelDelete", { modelKey: "kokoro" })).toEqual({ ok: true });
		expect(stt).toHaveBeenCalledWith("fast");
		expect(tts).toHaveBeenCalledWith("kokoro");
	});

	it("rejects deletion while any model download is active", async () => {
		const rpc = harness();
		vi.spyOn(sttDownloader, "downloadSttModel").mockReturnValue(new Promise<void>(() => {}));
		const remove = vi.spyOn(sttDownloader, "deleteSttModel").mockResolvedValue();
		await rpc("stt.modelDownload", { modelKey: "fast" });
		await expect(rpc("stt.modelDelete", { modelKey: "balanced" })).rejects.toThrow("download");
		expect(remove).not.toHaveBeenCalled();
	});

	it("rejects unknown model keys instead of deleting a fallback directory", async () => {
		const rpc = harness();
		const stt = vi.spyOn(sttDownloader, "deleteSttModel").mockResolvedValue();
		const tts = vi.spyOn(ttsDownloader, "deleteTtsModel").mockResolvedValue();
		await expect(rpc("stt.modelDelete", { modelKey: "../other" })).rejects.toThrow("unknown speech model");
		await expect(rpc("tts.modelDelete", { modelKey: "../other" })).rejects.toThrow("unknown TTS model");
		expect(stt).not.toHaveBeenCalled();
		expect(tts).not.toHaveBeenCalled();
	});
});
