/**
 * WebSocket transport for the MusePi daemon — browser-reachable JSON-RPC.
 *
 * The unix socket (server.ts) is local-only; a browser GUI needs ws://. This
 * transport reuses the collab relay's hand-rolled RFC 6455 codec (FrameDecoder
 * + encodeFrame, same upgrade-parsing caveats: a plain net socket, not
 * node:http — Bun's http compatibility layer drops bytes written to an
 * upgraded socket) and bridges each complete text frame into the shared
 * JSON-RPC dispatcher (handleRpcLine in server.ts).
 */

import { createHash } from "node:crypto";
import * as net from "node:net";
import { logger } from "@musepi/pi-utils";
import {
	encodeClosePayload,
	encodeFrame,
	FrameDecoder,
	RelayProtocolError,
	type WsFrame,
} from "../collab/relay-server";
import { type DaemonConnection, MAX_REQUEST_BYTES } from "./server";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** Cap on the raw HTTP upgrade header (before the blank line). */
const MAX_REQUEST_HEADER_BYTES = 16 * 1024;
/** Server heartbeat cadence: ping each connection every 15s; destroy after
 *  three missed pongs (~45s) — mirrors the GUI client's keepalive budget. */
const WS_HEARTBEAT_MS = 15_000;
const WS_HEARTBEAT_MISSES = 3;

// Frame opcodes (subset of RFC 6455).
const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export interface DaemonWsOptions {
	port: number;
	/** Bind host. Defaults to loopback; the mobile pair endpoint passes "0.0.0.0". */
	host?: string;
	/**
	 * Required bearer token. Every connection must present it via the
	 * `Authorization: Bearer <token>` header (Node/Electron clients) or the
	 * `?token=<token>` query param on the WebSocket URL (browsers cannot set
	 * headers). Verified with a constant-time compare; rejected with 401.
	 * Absent => no auth (loopback-only transports stay compatible).
	 */
	authToken?: string;
	/** One complete text message from a client (a JSON-RPC request line). */
	onMessage(conn: DaemonConnection, text: string): void;
	/** Connection closed — drop subscriptions held by this client. */
	onClose(connId: string): void;
}

export interface DaemonWsHandle {
	/** Actual listening port (useful when port 0 was requested). */
	port: number;
	close: () => Promise<void>;
}

function acceptKey(key: string): string {
	return createHash("sha1")
		.update(key + WS_GUID)
		.digest("base64");
}

function rejectHttp(socket: net.Socket, status: number, message: string): void {
	socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
}

/** Constant-time string compare (timing-safe token check). */
function timingSafeEqualStr(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Resolve the bearer token from a request: Authorization header first, then
 * the `token` query param (browser WebSocket cannot set headers). Returns
 * null when absent.
 */
function requestToken(requestLine: string, headers: Map<string, string>): string | null {
	const auth = headers.get("authorization");
	if (auth) {
		const m = /^Bearer\s+(.+)$/i.exec(auth);
		if (m) return m[1]!.trim();
	}
	const qIdx = requestLine.indexOf("?");
	if (qIdx !== -1) {
		const query = requestLine.slice(qIdx + 1).split(" ")[0] ?? "";
		for (const pair of query.split("&")) {
			const [k, v] = pair.split("=");
			if (k === "token" && v) return decodeURIComponent(v);
		}
	}
	return null;
}

function closeWithCode(socket: net.Socket, code: number, reason: string): void {
	if (socket.destroyed) return;
	socket.write(encodeFrame(OP_CLOSE, encodeClosePayload(code, reason)));
	socket.end();
}

export async function startDaemonWs(options: DaemonWsOptions): Promise<DaemonWsHandle> {
	const decoder = new TextDecoder();
	const sockets = new Set<net.Socket>();
	let connCounter = 0;

	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => socket.destroy());

		// ── HTTP/1.1 upgrade parsing (mirrors the collab relay) ────────────
		let buf = "";
		const onData = (chunk: Buffer): void => {
			buf += chunk.toString("latin1");
			const idx = buf.indexOf("\r\n\r\n");
			if (idx === -1) {
				if (buf.length > MAX_REQUEST_HEADER_BYTES) rejectHttp(socket, 431, "request header too large");
				return;
			}
			socket.off("data", onData);
			const tail = buf.slice(idx + 4);
			buf = buf.slice(0, idx);
			if (tail) socket.unshift(Buffer.from(tail, "latin1"));
			handleRequest(socket, buf);
		};
		socket.on("data", onData);
	});

	function handleRequest(socket: net.Socket, headerText: string): void {
		const lines = headerText.split("\r\n");
		const requestLine = lines[0] ?? "";
		const [method] = requestLine.split(" ");
		if (method !== "GET") return rejectHttp(socket, 405, "method not allowed");
		const headers = new Map<string, string>();
		for (const line of lines.slice(1)) {
			const colon = line.indexOf(":");
			if (colon === -1) continue;
			headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
		}
		const upgrade = headers.get("upgrade");
		if (upgrade?.toLowerCase() !== "websocket") return rejectHttp(socket, 426, "websocket upgrade required");
		const key = headers.get("sec-websocket-key");
		if (!key) return rejectHttp(socket, 400, "missing sec-websocket-key");
		if (options.authToken) {
			const presented = requestToken(requestLine, headers);
			if (!presented || !timingSafeEqualStr(presented, options.authToken)) {
				logger.warn("ws auth rejected", { remote: socket.remoteAddress ?? null });
				return rejectHttp(socket, 401, "unauthorized");
			}
		}

		const accept = acceptKey(key);
		// The Date header is required by RFC 7231 for HTTP/1.1 responses.
		socket.write(
			"HTTP/1.1 101 Switching Protocols\r\n" +
				"Upgrade: websocket\r\n" +
				"Connection: Upgrade\r\n" +
				`Sec-WebSocket-Accept: ${accept}\r\n` +
				`Date: ${new Date().toUTCString()}\r\n\r\n`,
		);

		const conn: DaemonConnection = {
			id: `ws${++connCounter}`,
			send: message => {
				if (!socket.destroyed) {
					socket.write(encodeFrame(OP_TEXT, new TextEncoder().encode(JSON.stringify(message))));
				}
			},
			writableLength: () => socket.writableLength,
		};
		logger.debug("ws connection open", { connId: conn.id, remote: socket.remoteAddress ?? null });
		const frameDecoder = new FrameDecoder();
		let closed = false;
		let closeCode: number | null = null;
		// Heartbeat (sleep/wake fix): the daemon pings every WS_HEARTBEAT_MS and
		// destroys a connection that misses WS_HEARTBEAT_MISSES pongs — a dead
		// client (renderer torn down by macOS sleep, crashed process) would
		// otherwise keep its subscription and socket buffers forever, and the
		// GUI-side half-open socket never gets its close frame. Browsers answer
		// PING with PONG at the protocol level, so every compliant client is
		// covered without any app code.
		let pongedAt = Date.now();
		const heartbeat = setInterval(() => {
			if (socket.destroyed) {
				clearInterval(heartbeat);
				return;
			}
			if (Date.now() - pongedAt > WS_HEARTBEAT_MISSES * WS_HEARTBEAT_MS) {
				logger.info("ws heartbeat timeout — destroying connection", { connId: conn.id });
				socket.destroy();
				return;
			}
			try {
				socket.write(encodeFrame(OP_PING, new Uint8Array(0)));
			} catch {
				// write on a dying socket — the close event will clean up
			}
		}, WS_HEARTBEAT_MS);
		const teardown = (): void => {
			if (closed) return;
			closed = true;
			clearInterval(heartbeat);
			logger.info("ws connection closed", { connId: conn.id, closeCode });
			options.onClose(conn.id);
		};

		socket.on("data", (chunk: Buffer) => {
			try {
				for (const frame of frameDecoder.push(new Uint8Array(chunk))) {
					handleFrame(conn, socket, frame, teardown, code => {
						closeCode = code;
					}, () => {
						pongedAt = Date.now();
					});
				}
			} catch (err) {
				const code = err instanceof RelayProtocolError ? err.closeCode : 1002;
				closeCode = code;
				void closeWithCode(socket, code, err instanceof Error ? err.message : "protocol error");
			}
		});
		socket.on("close", teardown);
	}

	function handleFrame(
		conn: DaemonConnection,
		socket: net.Socket,
		frame: WsFrame,
		teardown: () => void,
		onCloseFrame?: (code: number) => void,
		onPong?: () => void,
	): void {
		if (frame.opcode === OP_TEXT) {
			// Frame-size fence (unix-socket parity): the decoder buffers the
			// whole frame, so an oversized payload would pin memory until
			// delivered — reject it with the JSON-RPC too-large code and
			// keep the connection usable (the frame is already complete).
			if (frame.payload.byteLength > MAX_REQUEST_BYTES) {
				conn.send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } });
				return;
			}
			options.onMessage(conn, decoder.decode(frame.payload));
			return;
		}
		if (frame.opcode === OP_PING) {
			socket.write(encodeFrame(OP_PONG, frame.payload));
			return;
		}
		if (frame.opcode === OP_PONG) {
		onPong?.();
		return;
	}
		if (frame.opcode === OP_CLOSE) {
			const code =
				frame.payload.byteLength >= 2
					? new DataView(frame.payload.buffer, frame.payload.byteOffset).getUint16(0, false)
					: 1000;
			onCloseFrame?.(code);
			// Teardown synchronously: the client's close handshake may not
			// deliver a FIN to this socket, so the 'close' event could never
			// fire teardown (same lesson as the relay's detachPeer).
			teardown();
			// Single end(data): the echo must ride the same call as the FIN.
			socket.end(encodeFrame(OP_CLOSE, encodeClosePayload(code, "")));
			return;
		}
		// Binary and other opcodes are not part of the daemon RPC protocol.
	}

	const { promise, resolve, reject } = Promise.withResolvers<DaemonWsHandle>();
	server.once("error", reject);
	server.listen(options.port, options.host ?? "127.0.0.1", () => {
		server.off("error", reject);
		const port = (server.address() as net.AddressInfo).port;
		resolve({
			port,
			close: async () => {
				for (const s of sockets) if (!s.destroyed) s.destroy();
				const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
				server.close(() => resolveClosed());
				await closed;
			},
		});
	});
	return promise;
}
