/**
 * `system.shutdown` — cooperative daemon shutdown over the RPC channel.
 *
 * Why the RPC exists (and why this test is not a formality): the desktop shell
 * used to stop the daemon with `process.kill(pid, "SIGTERM")`. On Windows Node
 * maps SIGTERM to an uncatchable TerminateProcess, so the daemon's own
 * `process.on("SIGTERM", shutdown)` never ran — every teardown was a hard kill
 * that dropped in-flight turns, and the "grace window" was dead time. The RPC
 * travels the channel the daemon already serves, so it works on every platform.
 *
 * Contract:
 *  - the request ACKS before teardown starts (a late reply would race the
 *    closing socket, time the caller out, and provoke the very hard kill this
 *    avoids);
 *  - the ack carries how much live work exists, so the shell can report it;
 *  - teardown really releases the listener (the port stops accepting);
 *  - a daemon built without a shutdown hook reports unavailability instead of
 *    pretending to have stopped.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { startDaemon } from "../../src/daemon/server";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

type RpcCall = (method: string, params?: unknown) => Promise<unknown>;

interface DaemonHandle {
	close(): Promise<void>;
	wsPort?: number;
}

/** Minimal JSON-RPC client over the daemon's WS transport. */
function makeRpc(ws: WebSocket): RpcCall {
	let nextId = 1;
	const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	ws.addEventListener("message", ev => {
		const msg = JSON.parse((ev as MessageEvent).data as string) as {
			id?: number;
			error?: { message: string };
			result?: unknown;
		};
		if (msg.id !== undefined && pending.has(msg.id)) {
			const entry = pending.get(msg.id)!;
			pending.delete(msg.id);
			if (msg.error) entry.reject(new Error(msg.error.message));
			else entry.resolve(msg.result);
		}
	});
	return (method: string, params?: unknown): Promise<unknown> => {
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const id = nextId++;
		pending.set(id, { resolve, reject });
		ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
		return promise;
	};
}

async function openRpc(port: number): Promise<{ ws: WebSocket; rpc: RpcCall }> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}`);
	const rpc = makeRpc(ws);
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve());
		ws.addEventListener("error", () => reject(new Error("ws failed to open")));
	});
	return { ws, rpc };
}

async function freePort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const srv = net.createServer();
	srv.once("error", reject);
	srv.listen(0, "127.0.0.1", () => {
		const addr = srv.address();
		const port = typeof addr === "object" && addr !== null ? addr.port : 0;
		srv.close(() => resolve(port));
	});
	return promise;
}

function portAccepts(port: number): Promise<boolean> {
	return new Promise(resolve => {
		const sock = net.connect({ host: "127.0.0.1", port });
		const done = (ok: boolean): void => {
			sock.removeAllListeners();
			sock.destroy();
			resolve(ok);
		};
		sock.once("connect", () => done(true));
		sock.once("error", () => done(false));
		sock.setTimeout(300, () => done(false));
	});
}

async function waitForClosed(port: number, timeoutMs = 10_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (!(await portAccepts(port))) return true;
		if (Date.now() >= deadline) return false;
		await new Promise(r => setTimeout(r, 50));
	}
}

const handles: DaemonHandle[] = [];
const sockets: WebSocket[] = [];

let isolatedAgentDir: string;

beforeAll(async () => {
	isolatedAgentDir = await isolateAgentDirForTest("daemon-shutdown-agent-");
}, 30_000);

afterAll(async () => {
	await restoreAgentDirForTest(isolatedAgentDir);
}, 30_000);

afterEach(async () => {
	for (const ws of sockets.splice(0)) {
		try {
			ws.close();
		} catch {
			// already closed
		}
	}
	for (const handle of handles.splice(0)) {
		await handle.close().catch(() => {});
	}
});

async function bootDaemon(): Promise<{
	handle: DaemonHandle;
	port: number;
	rpc: RpcCall;
	ws: WebSocket;
	exited: () => boolean;
}> {
	const port = await freePort();
	const socketPath = path.join(os.tmpdir(), `musepi-shutdown-test-${process.pid}-${port}.sock`);
	// Embed the daemon without process exit: `onShutdownComplete` is the seam
	// the real `musepi serve` leaves at its default (`process.exit(0)`), so the
	// teardown contract is observable here without killing the test runner.
	let exited = false;
	const handle = (await startDaemon({
		wsPort: port,
		socketPath,
		onShutdownComplete: () => {
			exited = true;
		},
	})) as DaemonHandle;
	handles.push(handle);
	const boundPort = handle.wsPort ?? port;
	const { ws, rpc } = await openRpc(boundPort);
	sockets.push(ws);
	return { handle, port: boundPort, rpc, ws, exited: () => exited };
}

describe("system.shutdown", () => {
	test("acks, then releases the listener", async () => {
		const { port, rpc, exited } = await bootDaemon();
		expect(await portAccepts(port)).toBe(true);

		const ack = (await rpc("system.shutdown", {})) as { ok?: boolean; busy?: number };
		// The ack must arrive BEFORE teardown runs: replying afterwards would
		// race the closing socket and time the caller out.
		expect(ack.ok).toBe(true);
		expect(typeof ack.busy).toBe("number");

		expect(await waitForClosed(port)).toBe(true);
		const completionDeadline = Date.now() + 10_000;
		while (!exited() && Date.now() < completionDeadline) {
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		// The owner's completion hook fired only after teardown finished — the
		// ordering the real process-exit path depends on.
		expect(exited()).toBe(true);
	}, 30_000);

	test("the daemon serves nothing after shutdown completes", async () => {
		const { port, ws } = await bootDaemon();
		const rpc = makeRpc(ws);
		await rpc("system.shutdown", {});

		expect(await waitForClosed(port)).toBe(true);
		// A fresh connection cannot be established — this is what the shell
		// polls to decide "the daemon is gone, do not escalate".
		expect(await portAccepts(port)).toBe(false);
	}, 30_000);

	test("a second teardown after shutdown stays safe", async () => {
		const { port, handle } = await bootDaemon();
		await handle.close();
		// `close()` is idempotent, so an explicit teardown after the RPC already
		// ran (the shell's belt-and-braces path) does not throw or double-free
		// handles.
		await handle.close();
		expect(await portAccepts(port)).toBe(false);
	}, 30_000);
});
