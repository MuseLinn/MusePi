/**
 * E2E: the LAN share path end to end — LocalShareManager boots a relay on the
 * machine's routable address, a collab link is formatted from its origin, a
 * guest parses the link and connects with the production CollabSocket, and
 * sealed frames round-trip across the relay. This is the exact wiring
 * `/collab lan` performs, minus the TUI context.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import * as tls from "node:tls";
import {
	CollabSocket,
	formatCollabLink,
	generateRoomId,
	generateRoomKey,
	importRoomKey,
	parseCollabLink,
} from "@musepi/collab-proto";
import { LocalShareManager } from "@musepi/pi-coding-agent/collab/local-share";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * Minimal raw WebSocket client over TLS (self-signed cert accepted). Bun's
 * bundled WebSocket refuses both hand-written 101s and untrusted certs, so
 * the browser-side path is exercised with a raw client instead.
 */
class RawTlsWsClient {
	readonly messages: { opcode: number; payload: Uint8Array }[] = [];
	readonly closeFrame: Promise<{ code: number; reason: string } | null>;
	#socket: tls.TLSSocket;
	#buffer = new Uint8Array(0);

	private constructor(socket: tls.TLSSocket) {
		this.#socket = socket;
		this.closeFrame = new Promise(resolve => {
			const onFrame = (frames: { opcode: number; payload: Uint8Array }[]) => {
				for (const f of frames) {
					if (f.opcode === 0x8) {
						const code =
							f.payload.byteLength >= 2
								? new DataView(f.payload.buffer, f.payload.byteOffset).getUint16(0, false)
								: 1000;
						resolve({ code, reason: new TextDecoder().decode(f.payload.subarray(2)) });
					}
				}
			};
			// Frame decoding starts only after the HTTP handshake (the 101 header
			// bytes are not a WS frame); connect() installs this listener.
			this.#onData = (chunk: Uint8Array) => {
				const frames = this.#parse(chunk);
				this.messages.push(...frames);
				onFrame(frames);
				return frames;
			};
			socket.on("close", () => resolve(null));
		});
	}

	#onData: (chunk: Uint8Array) => { opcode: number; payload: Uint8Array }[] = () => [];

	#parse(chunk: Uint8Array): { opcode: number; payload: Uint8Array }[] {
		this.#buffer = concat(this.#buffer, chunk);
		const out: { opcode: number; payload: Uint8Array }[] = [];
		for (;;) {
			if (this.#buffer.byteLength < 2) return out;
			const opcode = this.#buffer[0]! & 0x0f;
			const masked = (this.#buffer[1]! & 0x80) !== 0;
			if (masked) throw new Error("server frames must not be masked");
			let len = this.#buffer[1]! & 0x7f;
			let headerLen = 2;
			if (len === 126) {
				if (this.#buffer.byteLength < 4) return out;
				len = new DataView(this.#buffer.buffer, this.#buffer.byteOffset).getUint16(2, false);
				headerLen = 4;
			} else if (len === 127) {
				if (this.#buffer.byteLength < 10) return out;
				len = Number(new DataView(this.#buffer.buffer, this.#buffer.byteOffset).getBigUint64(2, false));
				headerLen = 10;
			}
			if (this.#buffer.byteLength < headerLen + len) return out;
			out.push({ opcode, payload: this.#buffer.slice(headerLen, headerLen + len) });
			this.#buffer = this.#buffer.subarray(headerLen + len);
		}
	}

	static connect(wssUrl: string, roomId: string): Promise<RawTlsWsClient> {
		return new Promise((resolve, reject) => {
			const url = new URL(wssUrl);
			// IP literals cannot carry SNI (Node rejects servername for IPs); the
			// self-signed cert is accepted via rejectUnauthorized: false.
			const socket = tls.connect({ host: url.hostname, port: Number(url.port), rejectUnauthorized: false }, () => {
				const key = randomBytes(16).toString("base64");
				const client = new RawTlsWsClient(socket);
				socket.write(
					`GET /r/${roomId}?role=guest HTTP/1.1\r\n` +
						`Host: ${url.hostname}:${url.port}\r\n` +
						"Connection: Upgrade\r\n" +
						"Upgrade: websocket\r\n" +
						"Sec-WebSocket-Version: 13\r\n" +
						`Sec-WebSocket-Key: ${key}\r\n\r\n`,
				);
				let head = "";
				const onChunk = (chunk: Buffer) => {
					head += chunk.toString("binary");
					const idx = head.indexOf("\r\n\r\n");
					if (idx === -1) return;
					socket.off("data", onChunk);
					const header = head.slice(0, idx);
					const expected = createHash("sha1")
						.update(key + WS_GUID)
						.digest("base64");
					if (!header.includes("101")) return reject(new Error(`handshake rejected: ${header.split("\r\n")[0]}`));
					if (!header.includes(`Sec-WebSocket-Accept: ${expected}`)) {
						return reject(new Error("bad accept key"));
					}
					// Frame decoding starts only after the 101 (the header bytes are
					// not a WS frame), but a fatal close (4004 etc.) rides the same
					// TCP segment right after the header — parse those tail bytes.
					const tail = Buffer.from(head.slice(idx + 4), "binary");
					socket.on("data", (chunk: Buffer) => {
						const frames = client.#onData(new Uint8Array(chunk));
						for (const f of frames) void f;
					});
					if (tail.byteLength > 0) {
						const frames = client.#onData(new Uint8Array(tail));
						for (const f of frames) void f;
					}
					resolve(client);
				};
				socket.on("data", onChunk);
			});
			socket.on("error", reject);
		});
	}
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(a.byteLength + b.byteLength);
	out.set(a, 0);
	out.set(b, a.byteLength);
	return out;
}

const managers: LocalShareManager[] = [];

afterAll(async () => {
	for (const m of managers) await m.stop().catch(() => {});
});

describe("LAN share end-to-end", () => {
	it("skips the live cloudflared tunnel path when cloudflared is absent (covered by tunnel.test fake binary)", async () => {
		const { execFileSync } = await import("node:child_process");
		let hasCloudflared = true;
		try {
			execFileSync("cloudflared", ["--version"], { stdio: "ignore" });
		} catch {
			hasCloudflared = false;
		}
		if (!hasCloudflared) return; // real tunnel E2E needs cloudflared; lifecycle is tested with a fake binary
		const manager = new LocalShareManager({ port: 0 });
		managers.push(manager);
		const urls = await manager.startTunnel();
		expect(urls.joinUrl).toMatch(/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/);
		await manager.stop();
	});
	it("startTunnel('ngrok') forwards the provider through LocalShareManager", async () => {
		// Drive the full /collab tunnel ngrok path: relay + provider selection +
		// fake ngrok found via PATH.
		const { chmodSync, mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "lan-ngrok-fake-"));
		const prevPath = process.env.PATH;
		try {
			writeFileSync(
				join(dir, "ngrok"),
				`#!/usr/bin/env node\nprocess.stdout.write('{"url":"https://fake123.ngrok-free.app"}\\n');\nsetInterval(() => {}, 1000);\n`,
			);
			chmodSync(join(dir, "ngrok"), 0o755);
			process.env.PATH = `${dir}:${prevPath}`;
			const manager = new LocalShareManager({ port: 0 });
			managers.push(manager);
			const urls = await manager.startTunnel("ngrok");
			expect(urls.joinUrl).toBe("https://fake123.ngrok-free.app");
			expect(urls.webJoinUrl).toBe("https://fake123.ngrok-free.app");
		} finally {
			if (prevPath === undefined) delete process.env.PATH;
			else process.env.PATH = prevPath;
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("host + guest exchange sealed frames over a LAN share link", async () => {
		const manager = new LocalShareManager({ port: 0 });
		managers.push(manager);
		const urls = await manager.startLan();
		const relayUrl = urls.joinUrl;
		expect(relayUrl).toMatch(/^ws:\/\/\d+\.\d+\.\d+\.\d+:\d+$/);
		expect(urls.webUrl).toMatch(/^https:\/\/\d+\.\d+\.\d+\.\d+:\d+$/);
		expect(urls.webJoinUrl).toMatch(/^wss:\/\/\d+\.\d+\.\d+\.\d+:\d+$/);

		const roomId = generateRoomId();
		const rawKey = generateRoomKey();
		const link = formatCollabLink(relayUrl, roomId, rawKey);
		const parsed = parseCollabLink(link);
		if ("error" in parsed) throw new Error(parsed.error);
		expect(parsed.wsUrl).toBe(`${relayUrl}/r/${roomId}`);
		const key = await importRoomKey(rawKey);

		const host = new CollabSocket<unknown>({ wsUrl: parsed.wsUrl, role: "host", key });
		const guest = new CollabSocket<unknown>({ wsUrl: parsed.wsUrl, role: "guest", key });
		const hostFrames: { frame: unknown; fromPeer: number }[] = [];
		const guestFrames: { frame: unknown; fromPeer: number }[] = [];
		host.onFrame = (frame, fromPeer) => hostFrames.push({ frame, fromPeer });
		guest.onFrame = (frame, fromPeer) => guestFrames.push({ frame, fromPeer });
		const opened = (socket: CollabSocket<unknown>): Promise<void> =>
			new Promise<void>(resolve => {
				socket.onOpen = () => resolve();
				socket.connect();
			});
		await opened(host);
		await opened(guest);

		host.send({ hello: "lan" });
		await waitFor(() => guestFrames.length === 1);
		expect(guestFrames[0]).toEqual({ frame: { hello: "lan" }, fromPeer: 0 });

		guest.send({ reply: "guest" });
		await waitFor(() => hostFrames.length === 1);
		expect(hostFrames[0]).toEqual({ frame: { reply: "guest" }, fromPeer: 1 });

		host.close();
		guest.close();
	});
	it("browser guest on the TLS instance finds the host on the plaintext instance", async () => {
		// The exact user flow: the host terminal joins the plaintext relay, the
		// browser opens the https deep link whose fragment points at the TLS
		// relay. The two relay instances must share one room registry or the
		// guest is rejected with 4004 "no such room" — the "会话已结束 房间不存在"
		// report.
		const manager = new LocalShareManager({ port: 0 });
		managers.push(manager);
		const urls = await manager.startLan();

		const roomId = generateRoomId();
		const rawKey = generateRoomKey();
		const key = await importRoomKey(rawKey);

		// User flow: the host terminal is already online (room registered on the
		// plaintext instance) when the browser opens the https deep link.
		const host = new CollabSocket<unknown>({ wsUrl: `${urls.joinUrl}/r/${roomId}`, role: "host", key });
		const hostFrames: { frame: unknown; fromPeer: number }[] = [];
		host.onFrame = (frame, fromPeer) => hostFrames.push({ frame, fromPeer });
		await new Promise<void>(resolve => {
			host.onOpen = () => resolve();
			host.connect();
		});

		const guest = await RawTlsWsClient.connect(urls.webJoinUrl, roomId);
		// The TLS instance must accept the guest (no 4004) and route host → guest.
		const close = await Promise.race([guest.closeFrame, new Promise<null>(r => setTimeout(() => r(null), 3_000))]);
		expect(close).toBeNull();

		host.send({ ping: "cross-instance" });
		await waitFor(() => guest.messages.some(m => m.opcode === 0x2));
		const binary = guest.messages.find(m => m.opcode === 0x2)!.payload;
		// Envelope: [4B peerId=0][sealed payload]. The sealed payload is opaque
		// here — the relay only routes bytes — but its length must be non-zero.
		expect(binary.byteLength).toBeGreaterThan(4);
		expect(new DataView(binary.buffer).getUint32(0, false)).toBe(0);

		host.close();
	});
});

async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!cond()) {
		if (Date.now() > deadline) throw new Error("waitFor timeout");
		await new Promise(r => setTimeout(r, 10));
	}
}
