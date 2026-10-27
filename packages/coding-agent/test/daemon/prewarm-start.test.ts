import { afterAll, beforeAll, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { startDaemon } from "../../src/daemon/server";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

let isolatedAgentDir = "";

beforeAll(async () => {
	isolatedAgentDir = await isolateAgentDirForTest("musepi-daemon-prewarm-agent-");
}, 30_000);

afterAll(async () => {
	await restoreAgentDirForTest(isolatedAgentDir);
}, 30_000);

test("starts SDK prewarming only when the client asks after first paint", async () => {
	const daemon = await startDaemon({
		socketPath: path.join(os.tmpdir(), `musepi-prewarm-${process.pid}.sock`),
		wsPort: 0,
	});
	const ws = new WebSocket(`ws://127.0.0.1:${daemon.wsPort}`);
	const pending = new Map<
		number,
		{ resolve(value: { ready?: boolean; started?: boolean }): void; reject(error: Error): void }
	>();
	let nextId = 1;
	ws.addEventListener("message", event => {
		const message = JSON.parse(String(event.data)) as {
			id?: number;
			result?: { ready?: boolean; started?: boolean };
			error?: { message?: string };
		};
		const request = pending.get(message.id ?? -1);
		if (!request) return;
		pending.delete(message.id ?? -1);
		if (message.error) request.reject(new Error(message.error.message ?? "RPC failed"));
		else request.resolve(message.result ?? {});
	});
	const request = (method: string): Promise<{ ready?: boolean; started?: boolean }> => {
		const { promise, resolve, reject } = Promise.withResolvers<{ ready?: boolean; started?: boolean }>();
		const id = nextId++;
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }));
		return promise;
	};
	try {
		await new Promise<void>((resolve, reject) => {
			ws.addEventListener("open", () => resolve(), { once: true });
			ws.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true });
		});
		expect((await request("system.prewarmStatus")).ready).toBe(false);
		expect((await request("system.prewarmStart")).started).toBe(true);
		const deadline = Date.now() + 30_000;
		for (;;) {
			if ((await request("system.prewarmStatus")).ready === true) break;
			if (Date.now() >= deadline) throw new Error("SDK prewarm did not finish");
			await Bun.sleep(100);
		}
	} finally {
		ws.close();
		await daemon.close();
	}
}, 60_000);
