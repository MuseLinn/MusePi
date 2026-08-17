/**
 * Contract: the in-process relay server speaks exactly the subset of RFC 6455
 * and the room semantics the @musepi/collab-proto CollabSocket client treats
 * as contract — masked client frames, unmasked server frames, fragmentation,
 * peer-joined/peer-left + room-closed control messages, fatal close codes
 * 4001/4004/4009/4029, and byte-transparent envelope forwarding with the
 * 4-byte target peerId rewritten to the sender's id (0 = broadcast).
 *
 * The E2E half drives the server through a raw TCP WebSocket client (own
 * handshake + masked frames) so the handshake, codec and close paths are
 * exercised deterministically. (Bun's bundled WebSocket client refuses any
 * hand-written 101 response, so the raw client also keeps the suite
 * Bun-runtime agnostic; the node/undici client is verified to connect by
 * handshake in a separate smoke.)
 */

import { afterAll, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	encodeClosePayload,
	encodeFrame,
	FrameDecoder,
	RelayProtocolError,
	type RelayServerHandle,
	startRelayServer,
} from "@musepi/pi-coding-agent/collab/relay-server";

const OP_CONTINUATION = 0x0;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// ── Raw WebSocket client (client side of the same protocol the server speaks) ─

interface RawMessage {
	opcode: number;
	payload: Uint8Array;
}

class RawWsClient {
	readonly messages: RawMessage[] = [];
	#socket: net.Socket;
	#buffer = new Uint8Array(0);
	#closed: Promise<{ code: number; reason: string }>;
	#resolveClosed!: (v: { code: number; reason: string }) => void;
	#fragOpcode = -1;
	#fragParts: Uint8Array[] = [];
	#closeSeen: { code: number; reason: string } | null = null;

	private constructor(socket: net.Socket) {
		this.#socket = socket;
		this.#closed = new Promise(resolve => {
			this.#resolveClosed = resolve;
		});
		// No data listener until the handshake completes; #expectAccept installs it.
		socket.on("close", () => {
			this.#resolveClosed(this.#closeSeen ?? { code: 1006, reason: "tcp closed" });
		});
	}

	static connect(port: number, role: "host" | "guest"): Promise<RawWsClient> {
		return new Promise((resolve, reject) => {
			const socket = net.connect(port, "127.0.0.1", () => {
				const key = randomBytes(16).toString("base64");
				const client = new RawWsClient(socket);
				socket.write(
					`GET /r/${"a".repeat(16)}?role=${role} HTTP/1.1\r\n` +
						`Host: 127.0.0.1:${port}\r\n` +
						"Connection: Upgrade\r\n" +
						"Upgrade: websocket\r\n" +
						"Sec-WebSocket-Version: 13\r\n" +
						`Sec-WebSocket-Key: ${key}\r\n\r\n`,
				);
				client.#expectAccept(key).then(
					() => resolve(client),
					err => reject(err),
				);
			});
			socket.on("error", reject);
		});
	}

	#expectAccept(key: string): Promise<void> {
		const expected = createHash("sha1")
			.update(key + WS_GUID)
			.digest("base64");
		return new Promise((resolve, reject) => {
			let data = "";
			const onChunk = (chunk: Buffer) => {
				data += chunk.toString("binary");
				const idx = data.indexOf("\r\n\r\n");
				if (idx === -1) return;
				this.#socket.off("data", onChunk);
				const header = data.slice(0, idx);
				const head = data.slice(idx + 4);
				if (!header.includes("101")) return reject(new Error(`handshake rejected: ${header.split("\r\n")[0]}`));
				if (!header.includes(`Sec-WebSocket-Accept: ${expected}`)) {
					return reject(new Error(`bad accept key: ${header}`));
				}
				this.#socket.on("data", this.#onDataBound);
				if (head) this.#onData(Buffer.from(head, "binary"));
				resolve();
			};
			this.#socket.on("data", onChunk);
		});
	}

	#onDataBound = (chunk: Buffer): void => this.#onData(new Uint8Array(chunk));

	#onData(chunk: Uint8Array): void {
		this.#buffer = concat(this.#buffer, chunk);
		for (;;) {
			if (this.#buffer.byteLength < 2) return;
			const first = this.#buffer[0]!;
			const second = this.#buffer[1]!;
			const fin = (first & 0x80) !== 0;
			const opcode = first & 0x0f;
			const masked = (second & 0x80) !== 0;
			if (masked) throw new Error("server frames must not be masked");
			let len = second & 0x7f;
			let headerLen = 2;
			if (len === 126) {
				if (this.#buffer.byteLength < 4) return;
				len = new DataView(this.#buffer.buffer, this.#buffer.byteOffset).getUint16(2, false);
				headerLen = 4;
			} else if (len === 127) {
				if (this.#buffer.byteLength < 10) return;
				len = Number(new DataView(this.#buffer.buffer, this.#buffer.byteOffset).getBigUint64(2, false));
				headerLen = 10;
			}
			if (this.#buffer.byteLength < headerLen + len) return;
			const payload = this.#buffer.slice(headerLen, headerLen + len);
			this.#buffer = this.#buffer.subarray(headerLen + len);
			const isControl = (opcode & 0x08) !== 0;
			if (isControl) {
				this.messages.push({ opcode, payload });
				if (opcode === OP_CLOSE) {
					const code =
						payload.byteLength >= 2 ? new DataView(payload.buffer, payload.byteOffset).getUint16(0, false) : 1000;
					this.#closeSeen = { code, reason: new TextDecoder().decode(payload.subarray(2)) };
				}
			} else if (fin && this.#fragOpcode === -1) {
				this.messages.push({ opcode, payload });
			} else if (opcode === OP_CONTINUATION) {
				this.#fragParts.push(payload);
				if (fin) {
					this.messages.push({ opcode: this.#fragOpcode, payload: concat(...this.#fragParts) });
					this.#fragOpcode = -1;
					this.#fragParts = [];
				}
			} else {
				this.#fragOpcode = opcode;
				this.#fragParts = [payload];
			}
		}
	}

	#mask(bytes: Uint8Array): Uint8Array {
		const key = randomBytes(4);
		const out = new Uint8Array(4 + bytes.byteLength);
		out.set(key, 0);
		for (let i = 0; i < bytes.byteLength; i++) out[4 + i] = bytes[i]! ^ key[i & 3]!;
		return out;
	}

	/** Send an envelope-shaped payload with an explicit 4-byte target peerId. */
	sendBinary(targetPeer: number, payload: Uint8Array): void {
		const head = new Uint8Array(4);
		new DataView(head.buffer).setUint32(0, targetPeer, false);
		const frame = concat(head, payload);
		const body = this.#mask(frame);
		const header = new Uint8Array(2);
		header[0] = 0x80 | OP_BINARY;
		// Length field counts the data bytes, not the 4-byte mask key.
		header[1] = 0x80 | frame.byteLength;
		this.#socket.write(concat(header, body));
	}

	sendText(text: string): void {
		const bytes = new TextEncoder().encode(text);
		const body = this.#mask(bytes);
		const header = new Uint8Array(2);
		header[0] = 0x80 | 0x1;
		header[1] = 0x80 | bytes.byteLength;
		this.#socket.write(concat(header, body));
	}

	get readyState(): "open" | "closed" {
		return this.#socket.destroyed ? "closed" : "open";
	}

	/**
	 * Close the TCP side; resolves with the server's close code/reason once the
	 * socket fully closes — 4004/4009/4029 for fatal rejections, 4001 on host
	 * drop, and 1006 if the connection dies without a close frame.
	 */
	close(): Promise<{ code: number; reason: string }> {
		this.#socket.end();
		return this.#closed;
	}

	waitFor(pred: () => boolean, timeoutMs = 2_000, label = ""): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		return new Promise((resolve, reject) => {
			const tick = (): void => {
				if (pred()) return resolve();
				if (Date.now() > deadline) return reject(new Error(`waitFor timeout: ${label}`));
				setTimeout(tick, 10);
			};
			tick();
		});
	}
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	let total = 0;
	for (const p of parts) total += p.byteLength;
	const out = new Uint8Array(total);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.byteLength;
	}
	return out;
}

function envelopeFrom(msg: RawMessage): { targetOrSender: number; payload: Uint8Array } {
	const targetOrSender = new DataView(msg.payload.buffer, msg.payload.byteOffset).getUint32(0, false);
	return { targetOrSender, payload: msg.payload.subarray(4) };
}

const servers: RelayServerHandle[] = [];
async function startServer(): Promise<RelayServerHandle> {
	const handle = await startRelayServer({ port: 0, host: "127.0.0.1" });
	servers.push(handle);
	return handle;
}

afterAll(async () => {
	for (const handle of servers) await handle.close().catch(() => {});
});

// ── Frame codec ─────────────────────────────────────────────────────────────

describe("frame codec", () => {
	it("round-trips a masked binary frame through the decoder", () => {
		const decoder = new FrameDecoder();
		const frames = decoder.push(clientFrame(OP_BINARY, new Uint8Array([1, 2, 3, 4, 5])));
		expect(frames).toHaveLength(1);
		expect(frames[0]!.opcode).toBe(OP_BINARY);
		expect([...frames[0]!.payload]).toEqual([1, 2, 3, 4, 5]);
	});

	it("handles 126-length (16-bit) and 127-length (64-bit) frames", () => {
		const decoder = new FrameDecoder();
		const mid = new Uint8Array(200).fill(7);
		const big = new Uint8Array(70_000).fill(9);
		const frames = decoder.push(concat(clientFrame(OP_BINARY, mid), clientFrame(OP_BINARY, big)));
		expect(frames).toHaveLength(2);
		expect(frames[0]!.payload.byteLength).toBe(200);
		expect(frames[1]!.payload.byteLength).toBe(70_000);
	});

	it("reassembles a fragmented binary message", () => {
		const decoder = new FrameDecoder();
		const first = new Uint8Array(2 + 4 + 3);
		first[0] = OP_BINARY; // fin=0
		first[1] = 0x80 | 3;
		first[2] = 0;
		first[3] = 0;
		first[4] = 0;
		first[5] = 0;
		first[6] = 1;
		first[7] = 2;
		first[8] = 3;
		const cont = new Uint8Array(2 + 4 + 2);
		cont[0] = 0x80 | OP_CONTINUATION; // fin=1
		cont[1] = 0x80 | 2;
		cont[6] = 4;
		cont[7] = 5;
		const frames = decoder.push(concat(first, cont));
		expect(frames).toHaveLength(1);
		expect(frames[0]!.opcode).toBe(OP_BINARY);
		expect([...frames[0]!.payload]).toEqual([1, 2, 3, 4, 5]);
	});

	it("surfaces close/ping control frames without reassembly", () => {
		const decoder = new FrameDecoder();
		const close = clientFrame(OP_CLOSE, encodeClosePayload(4004, "no such room"));
		const ping = clientFrame(OP_PING, new TextEncoder().encode("hi"));
		const frames = decoder.push(concat(close, ping));
		expect(frames.map(f => f.opcode)).toEqual([OP_CLOSE, OP_PING]);
		expect(new DataView(frames[0]!.payload.buffer).getUint16(0, false)).toBe(4004);
	});

	it("rejects unmasked client frames as protocol errors", () => {
		const decoder = new FrameDecoder();
		expect(() => decoder.push(encodeFrame(OP_BINARY, new Uint8Array(4)))).toThrow(RelayProtocolError);
	});

	it("rejects a continuation without a started fragment", () => {
		const decoder = new FrameDecoder();
		const cont = new Uint8Array(2 + 4);
		cont[0] = 0x80 | OP_CONTINUATION;
		cont[1] = 0x80 | 0;
		expect(() => decoder.push(cont)).toThrow(RelayProtocolError);
	});

	it("rejects oversized control frames", () => {
		const decoder = new FrameDecoder();
		expect(() => decoder.push(clientFrame(OP_PING, new Uint8Array(126)))).toThrow(RelayProtocolError);
	});
});

function clientFrame(opcode: number, payload: Uint8Array): Uint8Array {
	const maskKey = [0x12, 0x34, 0x56, 0x78];
	const len = payload.byteLength;
	let headerLen = 2;
	if (len >= 126 && len < 65536) headerLen += 2;
	else if (len >= 65536) headerLen += 8;
	const out = new Uint8Array(headerLen + 4 + len);
	out[0] = 0x80 | opcode;
	if (len < 126) {
		out[1] = 0x80 | len;
	} else if (len < 65536) {
		out[1] = 0x80 | 126;
		new DataView(out.buffer).setUint16(2, len, false);
	} else {
		out[1] = 0x80 | 127;
		new DataView(out.buffer).setBigUint64(2, BigInt(len), false);
	}
	for (let i = 0; i < 4; i++) out[headerLen + i] = maskKey[i]!;
	for (let i = 0; i < len; i++) out[headerLen + 4 + i] = payload[i]! ^ maskKey[i & 3]!;
	return out;
}

// ── Room semantics (E2E over raw WebSocket) ─────────────────────────────────

describe("relay server rooms", () => {
	it("rejects a guest with 4004 when no host is present", async () => {
		const server = await startServer();
		const guest = await RawWsClient.connect(server.port, "guest");
		const { code, reason } = await guest.close();
		expect(code).toBe(4004);
		expect(reason).toBe("no such room");
	});

	it("rejects a second host with 4009 and leaves the first host untouched", async () => {
		const server = await startServer();
		const host = await RawWsClient.connect(server.port, "host");
		const second = await RawWsClient.connect(server.port, "host");
		const { code, reason } = await second.close();
		expect(code).toBe(4009);
		expect(reason).toBe("host conflict");
		expect(host.readyState).toBe("open");
		await host.close();
	});

	it("numbers guests 1..N, notifies the host of joins/leaves, and routes envelopes", async () => {
		const server = await startServer();
		const host = await RawWsClient.connect(server.port, "host");
		const guestA = await RawWsClient.connect(server.port, "guest");
		const guestB = await RawWsClient.connect(server.port, "guest");

		// Host heard both peer-joined controls.
		await host.waitFor(() => host.messages.filter(m => m.opcode === 0x1).length >= 2, 2_000, "peer-joined x2");
		const texts = host.messages.filter(m => m.opcode === 0x1).map(m => new TextDecoder().decode(m.payload));
		const joins = texts.map(t => JSON.parse(t) as { t: string; peer: number });
		expect(
			joins
				.filter(j => j.t === "peer-joined")
				.map(j => j.peer)
				.sort(),
		).toEqual([1, 2]);

		// Broadcast from host → both guests, peerId rewritten to sender (0).
		host.sendBinary(0, new Uint8Array([1, 2, 3]));
		await guestA.waitFor(() => guestA.messages.length === 1, 2_000, "ga broadcast");
		await guestB.waitFor(() => guestB.messages.length === 1, 2_000, "gb broadcast");
		for (const guest of [guestA, guestB]) {
			const msg = guest.messages[0]!;
			expect(msg.opcode).toBe(OP_BINARY);
			const env = envelopeFrom(msg);
			expect(env.targetOrSender).toBe(0);
			expect([...env.payload]).toEqual([1, 2, 3]);
		}

		// Guest → host: peerId rewritten to the guest's number.
		guestA.sendBinary(0, new Uint8Array([4, 5]));
		await host.waitFor(() => host.messages.filter(m => m.opcode === OP_BINARY).length === 1, 2_000, "host fromA");
		const fromA = envelopeFrom(host.messages.filter(m => m.opcode === OP_BINARY)[0]!);
		expect(fromA.targetOrSender).toBe(1);
		expect([...fromA.payload]).toEqual([4, 5]);

		// Guest A does not receive guest B's frames (guests never peer).
		guestB.sendBinary(0, new Uint8Array([6]));
		await host.waitFor(() => host.messages.filter(m => m.opcode === OP_BINARY).length === 2, 2_000, "host fromB");
		expect(guestA.messages.filter(m => m.opcode === OP_BINARY)).toHaveLength(1);

		// Directed frame from host → guest 2 only.
		host.sendBinary(2, new Uint8Array([7, 7]));
		await guestB.waitFor(
			() => guestB.messages.filter(m => m.opcode === OP_BINARY).length === 2,
			2_000,
			"gb directed",
		);
		expect(guestA.messages.filter(m => m.opcode === OP_BINARY)).toHaveLength(1);
		const directed = envelopeFrom(guestB.messages.filter(m => m.opcode === OP_BINARY)[1]!);
		expect(directed.targetOrSender).toBe(0);
		expect([...directed.payload]).toEqual([7, 7]);

		// Guest leaves → host hears peer-left.
		guestA.close();
		await host.waitFor(() => {
			const t = host.messages.filter(m => m.opcode === 0x1).map(m => new TextDecoder().decode(m.payload));
			return t.some(x => x === JSON.stringify({ t: "peer-left", peer: 1 }));
		});

		await guestA.close();
		await host.close();
		await guestB.close();
	});

	it("fills a room and reports 4029", async () => {
		const server = await startServer();
		const host = await RawWsClient.connect(server.port, "host");
		const guests: RawWsClient[] = [];
		for (let i = 0; i < 16; i++) guests.push(await RawWsClient.connect(server.port, "guest"));
		const overflow = await RawWsClient.connect(server.port, "guest");
		const { code, reason } = await overflow.close();
		expect(code).toBe(4029);
		expect(reason).toBe("room is full");
		for (const g of guests) await g.close();
		await host.close();
	});

	it("closes all guests with 4001 + room-closed when the host drops", async () => {
		const server = await startServer();
		const host = await RawWsClient.connect(server.port, "host");
		const guest = await RawWsClient.connect(server.port, "guest");
		await host.close();
		// The merged room-closed + close frame arrives asynchronously; wait for
		// it before tearing the guest side down so the close code is captured.
		await guest.waitFor(() => guest.messages.some(m => m.opcode === OP_CLOSE));
		const { code, reason } = await guest.close();
		expect(code).toBe(4001);
		expect(reason).toBe("room closed");
		// Guest got the room-closed control before the socket closed.
		const texts = guest.messages.filter(m => m.opcode === 0x1).map(m => new TextDecoder().decode(m.payload));
		expect(texts).toContain(JSON.stringify({ t: "room-closed" }));
	});

	it("rejects a non-websocket request with 426", async () => {
		const server = await startServer();
		const res = await fetch(`http://127.0.0.1:${server.port}/r/${"a".repeat(16)}`, {
			headers: { connection: "close" },
		});
		expect(res.status).toBe(426);
	});

	it("serves desktop-web static files and guards path traversal", async () => {
		const dir = mkdtempSync(join(tmpdir(), "relay-static-"));
		writeFileSync(join(dir, "index.html"), "<html>collab-ui</html>");
		writeFileSync(join(dir, "app.js"), "console.log(1)");
		const handle = await startRelayServer({ port: 0, host: "127.0.0.1", staticDir: dir });
		servers.push(handle);
		const base = `http://127.0.0.1:${handle.port}`;
		const index = await fetch(`${base}/`, { headers: { connection: "close" } });
		expect(index.status).toBe(200);
		expect(await index.text()).toContain("collab-ui");
		expect(index.headers.get("content-type")).toContain("text/html");
		const js = await fetch(`${base}/app.js`, { headers: { connection: "close" } });
		expect(js.status).toBe(200);
		expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		const traversal = await fetch(`${base}/..%2Fpackage.json`, { headers: { connection: "close" } });
		expect(traversal.status).toBe(403);
		const missing = await fetch(`${base}/r/not-a-room`, { headers: { connection: "close" } });
		expect(missing.status).toBe(404);
		// SPA fallback: unknown non-relay routes serve the app shell.
		const spa = await fetch(`${base}/nope`, { headers: { connection: "close" } });
		expect(spa.status).toBe(200);
		expect(await spa.text()).toContain("collab-ui");
		rmSync(dir, { recursive: true, force: true });
	});
});
