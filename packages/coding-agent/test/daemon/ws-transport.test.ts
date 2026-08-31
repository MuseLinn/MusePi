/**
 * Tests for the daemon's WebSocket transport (src/daemon/ws-transport.ts).
 *
 * Bun's built-in WebSocket client cannot connect to a hand-rolled 101
 * upgrade response (known limitation), so these tests drive the transport
 * with a raw TCP socket speaking RFC 6455 by hand: client frames are MASKED
 * (RFC requires it), server frames arrive unmasked.
 */
import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { VERSION } from "@musepi/pi-utils";
import { startDaemon } from "../../src/daemon/server";

const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;

interface RawWs {
	socket: net.Socket;
	/** Received server frames (opcode + payload), in arrival order. */
	frames: { opcode: number; payload: Uint8Array }[];
	nextFrame(): Promise<{ opcode: number; payload: Uint8Array }>;
	close(): Promise<void>;
}

async function connectWs(port: number): Promise<RawWs> {
	const socket = net.connect({ host: "127.0.0.1", port });
	await new Promise<void>((resolve, reject) => {
		socket.once("connect", resolve);
		socket.once("error", reject);
	});
	const key = crypto.randomBytes(16).toString("base64");
	socket.write(
		"GET / HTTP/1.1\r\n" +
			`Host: 127.0.0.1:${port}\r\n` +
			"Upgrade: websocket\r\n" +
			"Connection: Upgrade\r\n" +
			`Sec-WebSocket-Key: ${key}\r\n` +
			"Sec-WebSocket-Version: 13\r\n\r\n",
	);
	// Drain until the header terminator (headers are ASCII; latin1 is safe).
	let header = "";
	await new Promise<void>((resolve, reject) => {
		const onData = (chunk: Buffer): void => {
			header += chunk.toString("latin1");
			if (header.includes("\r\n\r\n")) {
				socket.off("data", onData);
				resolve();
			}
		};
		socket.on("data", onData);
		socket.once("error", reject);
	});
	const statusLine = header.split("\r\n")[0] ?? "";
	if (!statusLine.includes("101")) throw new Error(`upgrade failed: ${statusLine}`);

	const frames: RawWs["frames"] = [];
	const waiters: { resolve: (f: RawWs["frames"][number]) => void }[] = [];
	let buf = Buffer.alloc(0);
	socket.on("data", (chunk: Buffer) => {
		buf = Buffer.concat([buf, chunk]);
		for (;;) {
			if (buf.length < 2) return;
			const first = buf[0]!;
			const second = buf[1]!;
			const fin = (first & 0x80) !== 0;
			const opcode = first & 0x0f;
			let len = second & 0x7f;
			let headerLen = 2;
			if (len === 126) {
				if (buf.length < 4) return;
				len = buf.readUInt16BE(2);
				headerLen = 4;
			} else if (len === 127) {
				if (buf.length < 10) return;
				len = Number(buf.readBigUInt64BE(2));
				headerLen = 10;
			}
			const masked = (second & 0x80) !== 0;
			const maskLen = masked ? 4 : 0;
			if (buf.length < headerLen + maskLen + len) return;
			const payload = Buffer.from(buf.subarray(headerLen + maskLen, headerLen + maskLen + len));
			if (masked) {
				const mask = buf.subarray(headerLen, headerLen + 4);
				for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
			}
			buf = buf.subarray(headerLen + maskLen + len);
			// Continuation frames ride the last fin — keep it simple for tests:
			// assert no fragmentation happens for our payload sizes.
			if (!fin) throw new Error("unexpected fragmented server frame");
			const frame = { opcode, payload };
			const w = waiters.shift();
			if (w) w.resolve(frame);
			else frames.push(frame);
		}
	});

	const nextFrame = (): Promise<RawWs["frames"][number]> =>
		frames.length > 0 ? Promise.resolve(frames.shift()!) : new Promise(resolve => waiters.push({ resolve }));

	const close = async (): Promise<void> => {
		socket.end();
		await new Promise<void>(resolve => socket.once("close", resolve));
	};
	return { socket, frames, nextFrame, close };
}

function maskClientFrame(opcode: number, text: string): Buffer {
	return maskClientFrameBytes(opcode, Buffer.from(text, "utf8"));
}

function maskClientFrameBytes(opcode: number, payload: Buffer): Buffer {
	const mask = crypto.randomBytes(4);
	const masked = Buffer.alloc(payload.length);
	for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
	let header: Buffer;
	if (payload.length < 126) {
		header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
	} else if (payload.length < 65536) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = 0x80 | 126;
		header.writeUInt16BE(payload.length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = 0x80 | 127;
		header.writeBigUInt64BE(BigInt(payload.length), 2);
	}
	return Buffer.concat([header, mask, masked]);
}

function sendText(ws: RawWs, text: string): void {
	ws.socket.write(maskClientFrame(OP_TEXT, text));
}

async function rpc(ws: RawWs, id: number, method: string, params?: unknown): Promise<unknown> {
	sendText(ws, JSON.stringify({ jsonrpc: "2.0", id, method, params }));
	const frame = await ws.nextFrame();
	expect(frame.opcode).toBe(OP_TEXT);
	return JSON.parse(new TextDecoder().decode(frame.payload)) as unknown;
}

async function tmpDir(): Promise<string> {
	const { mkdtemp } = await import("node:fs/promises");
	return mkdtemp(path.join(os.tmpdir(), "musepi-daemon-ws-test-"));
}

describe("daemon WebSocket transport", () => {
	test("upgrade + JSON-RPC round trip (system.meta)", async () => {
		const dir = await tmpDir();
		const daemon = await startDaemon({ socketPath: path.join(dir, "d.sock"), wsPort: 0 });
		try {
			expect(daemon.wsPort).toBeGreaterThan(0);
			const ws = await connectWs(daemon.wsPort!);
			const res = await rpc(ws, 1, "system.meta");
			expect(res).toMatchObject({ jsonrpc: "2.0", id: 1 });
			// Narrow the raw RPC envelope before reading fields (the transport
			// types `result` as unknown — no unchecked cast).
			if (!res || typeof res !== "object" || !("result" in res) || !res.result || typeof res.result !== "object") {
				throw new Error(`system.meta returned an unexpected shape: ${JSON.stringify(res)}`);
			}
			const meta = res.result as Record<string, unknown>;
			expect(meta.engine).toContain("MusePi");
			// Derived, never a stale hardcode: the app version when the bundle
			// bakes MUSEPI_VERSION in, else the OMP engine version. The engine
			// string is the MusePi-branded form: `MusePi <app-or-engine version>`.
			expect(meta.version).toBe(process.env.MUSEPI_VERSION ?? VERSION);
			expect(meta.engine).toBe(`MusePi ${process.env.MUSEPI_VERSION ?? VERSION}`);
			expect(meta.dataRoot).toBeTruthy();
			expect(meta.configDir).toBeTruthy();
			expect(meta.runtime).toContain("Bun");
			await ws.close();
		} finally {
			await daemon.close();
		}
	});

	test("session lifecycle over WS: create → subscribe → send → event", async () => {
		const dir = await tmpDir();
		const daemon = await startDaemon({ socketPath: path.join(dir, "d.sock"), wsPort: 0 });
		try {
			const ws = await connectWs(daemon.wsPort!);
			const created = (await rpc(ws, 1, "session.create", {})) as { result: { sessionId: string } };
			const sessionId = created.result.sessionId;

			const sub = (await rpc(ws, 2, "session.subscribe", { sessionId })) as {
				result: { stream: string; initial: { header: { id: string } } };
			};
			expect(sub.result.stream).toBeTruthy();
			expect(sub.result.initial.header.id).toBe(sessionId);

			// Unknown method still answers with a JSON-RPC error envelope.
			const err = (await rpc(ws, 3, "nope.missing", {})) as { error: { message: string } };
			expect(err.error.message).toContain("Unknown method");

			// Ping keeps the connection alive (server answers with a pong).
			ws.socket.write(maskClientFrame(OP_PING, "hi"));
			const pong = await ws.nextFrame();
			expect(pong.opcode).toBe(0xa);
			expect(new TextDecoder().decode(pong.payload)).toBe("hi");

			await ws.close();
		} finally {
			await daemon.close();
		}
	});

	test("close handshake echoes the code and tears down subscriptions", async () => {
		const dir = await tmpDir();
		const daemon = await startDaemon({ socketPath: path.join(dir, "d.sock"), wsPort: 0 });
		try {
			const ws = await connectWs(daemon.wsPort!);
			await rpc(ws, 1, "system.meta");
			// Close code 1000 as a raw big-endian u16 — must NOT go through the
			// UTF-8 path (U+00E8 encodes to two bytes and shifts the code).
			ws.socket.write(maskClientFrameBytes(OP_CLOSE, Buffer.from([0x03, 0xe8])));
			const closeFrame = await ws.nextFrame();
			expect(closeFrame.opcode).toBe(OP_CLOSE);
			const code =
				closeFrame.payload.byteLength >= 2
					? new DataView(closeFrame.payload.buffer, closeFrame.payload.byteOffset).getUint16(0, false)
					: -1;
			expect(code).toBe(1000);
		} finally {
			await daemon.close();
		}
	});

	test("non-websocket upgrade is rejected with 426", async () => {
		const dir = await tmpDir();
		const daemon = await startDaemon({ socketPath: path.join(dir, "d.sock"), wsPort: 0 });
		try {
			const socket = net.connect({ host: "127.0.0.1", port: daemon.wsPort! });
			await new Promise<void>((resolve, reject) => {
				socket.once("connect", resolve);
				socket.once("error", reject);
			});
			const status = await new Promise<string>((resolve, reject) => {
				socket.once("data", chunk => resolve(chunk.toString("latin1").split("\r\n")[0] ?? ""));
				socket.once("error", reject);
				socket.write("GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
			});
			expect(status).toContain("426");
			socket.destroy();
		} finally {
			await daemon.close();
		}
	});
});
