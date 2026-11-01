import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getTtsLocalModelSpec, sherpaTtsRequiredFiles } from "./models";
import type { TtsTransport, TtsWorkerInbound, TtsWorkerOutbound } from "./tts-protocol";
import { ensureSherpaTtsFiles, startTtsWorker } from "./tts-worker";

function createTransport(sent: TtsWorkerOutbound[] = []): TtsTransport {
	return {
		send: message => sent.push(message),
		sendAndFlush: async message => {
			sent.push(message);
		},
		onMessage: () => () => {},
	};
}

/**
 * Worker error-channel contract: a failed request must produce an outbound
 * `error` message carrying the failure text — never drop the request silently
 * or die with an unhandled rejection. Unknown model keys are the cheap,
 * native-free failure path (`loadModel` throws before any engine loads), so
 * they pin the contract without dragging a 170 MB ONNX into the test.
 */
function createHarness() {
	const sent: TtsWorkerOutbound[] = [];
	let handler: ((message: TtsWorkerInbound) => void) | null = null;
	const transport = createTransport(sent);
	transport.onMessage = h => {
		handler = h;
		return () => {
			handler = null;
		};
	};
	startTtsWorker(transport);
	return {
		sent,
		send: (message: TtsWorkerInbound) => handler?.(message),
	};
}

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for worker output");
		await Bun.sleep(5);
	}
}

describe("sherpa TTS file downloads", () => {
	it("downloads every manifest file, including the Chinese rule FSTs", async () => {
		const spec = getTtsLocalModelSpec("melotts-zh");
		if (spec?.engine !== "sherpa") throw new Error("expected the MeloTTS sherpa manifest");
		const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-tts-files-"));
		const downloaded: string[] = [];
		try {
			const files = await ensureSherpaTtsFiles(spec, "melotts-zh", createTransport(), "files", {
				cacheDir,
				downloadFile: async (_repo, filename, dest) => {
					downloaded.push(filename);
					await Bun.write(dest, filename);
				},
			});
			const required = sherpaTtsRequiredFiles(spec);
			expect(downloaded).toEqual(required);
			for (const filename of required) {
				const dest = path.join(cacheDir, ...spec.repo.split("/"), ...filename.split("/"));
				expect((await fs.stat(dest)).size).toBeGreaterThan(0);
			}
			expect(files.ruleFsts?.split(",")).toEqual(
				spec.ruleFsts?.map(filename => path.join(cacheDir, spec.repo, filename)),
			);
		} finally {
			await fs.rm(cacheDir, { recursive: true, force: true });
		}
	});
});

describe("tts worker error channel", () => {
	it("answers a streaming session for an unknown model with an error message, not silence", async () => {
		const { sent, send } = createHarness();
		send({ type: "stream-start", id: "s1", modelKey: "bogus" as never });
		await until(() => sent.some(m => m.type === "error" && m.id === "s1"));
		const error = sent.find(m => m.type === "error" && m.id === "s1");
		if (error?.type !== "error") throw new Error("expected error message");
		expect(error.error).toContain("Unknown local TTS model");
		// No audio may accompany the failure.
		expect(sent.some(m => m.type === "audio-chunk" && m.id === "s1")).toBe(false);
		expect(sent.some(m => m.type === "stream-done" && m.id === "s1")).toBe(false);
	});

	it("answers an unknown-model download with an error message", async () => {
		const { sent, send } = createHarness();
		send({ type: "download", id: "r2", modelKey: "bogus" as never });
		await until(() => sent.some(m => m.type === "error" && m.id === "r2"));
		const error = sent.find(m => m.type === "error" && m.id === "r2");
		if (error?.type !== "error") throw new Error("expected error message");
		expect(error.error).toContain("Unknown local TTS model");
		expect(sent.some(m => m.type === "downloaded" && m.id === "r2")).toBe(false);
	});

	it("pongs pings (worker liveness contract)", async () => {
		const { sent, send } = createHarness();
		send({ type: "ping", id: "p1" });
		await until(() => sent.some(m => m.type === "pong" && m.id === "p1"));
	});
});
