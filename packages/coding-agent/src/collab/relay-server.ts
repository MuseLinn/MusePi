/**
 * Minimal RFC 6455 WebSocket relay server for collab live-session sharing.
 *
 * Zero-dependency server side of the @musepi/collab-proto CollabSocket client:
 * HTTP upgrade handshake, a masked-client / unmasked-server frame codec
 * (fragmentation + control frames included), and the relay room semantics the
 * client treats as contract:
 *
 * - `?role=host|guest` routing on `GET /r/<roomId>`; the first host creates
 *   the room, a second host gets close 4009.
 * - Guests get close 4004 when no host is present and 4029 when the room is
 *   full; guests are numbered 1..N, the host is peer 0.
 * - JSON control messages `{t:"peer-joined"|"peer-left",peer}` to the host and
 *   `{t:"room-closed"}` (followed by close 4001) to guests when the host drops.
 * - Byte-transparent envelope forwarding: the 4-byte target peerId is
 *   rewritten to the sender's id before fan-out (0 = broadcast to every other
 *   peer in the room, N = directed to that peer).
 *
 * The relay never sees plaintext: envelopes carry AES-GCM sealed payloads, and
 * the JSON control channel carries no session data. Clients send no strings —
 * any text frames from a client are ignored.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import type { AddressInfo } from "node:net";
import * as net from "node:net";
import * as path from "node:path";
import * as tls from "node:tls";
import type { RelayControlMessage } from "./protocol";
import { rewriteEnvelopePeer, unpackEnvelope } from "./protocol";

// ── Constants ───────────────────────────────────────────────────────────────

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_MAX_GUESTS = 16;
const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** Cap on the raw HTTP upgrade header (before the blank line). */
const MAX_REQUEST_HEADER_BYTES = 16 * 1024;
/** Same shape as @musepi/collab-proto's room path; the trailing .<key> may be absent. */
const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})(?:\.([A-Za-z0-9_-]+))?$/;

// Close codes the CollabSocket client treats as fatal (relay contract).
const CLOSE_ROOM_CLOSED = 4001;
const CLOSE_NO_SUCH_ROOM = 4004;
const CLOSE_HOST_CONFLICT = 4009;
const CLOSE_ROOM_FULL = 4029;
const CLOSE_PROTOCOL_ERROR = 1002;

// Frame opcodes.
const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

// ── Frame codec ─────────────────────────────────────────────────────────────

export interface WsFrame {
	opcode: number;
	/** Unmasked payload (mask keys are consumed by the decoder). */
	payload: Uint8Array;
}

/** Protocol violation that should terminate the connection with a close code. */
export class RelayProtocolError extends Error {
	constructor(
		readonly closeCode: number,
		message: string,
	) {
		super(message);
		this.name = "RelayProtocolError";
	}
}

/** Server → client frame. Server frames are never masked. */
export function encodeFrame(opcode: number, payload: Uint8Array, fin = true): Uint8Array {
	const len = payload.byteLength;
	let headerLen = 2;
	if (len >= 126 && len < 65536) headerLen += 2;
	else if (len >= 65536) headerLen += 8;
	const out = new Uint8Array(headerLen + len);
	out[0] = (fin ? 0x80 : 0) | opcode;
	if (len < 126) {
		out[1] = len;
	} else if (len < 65536) {
		out[1] = 126;
		new DataView(out.buffer).setUint16(2, len, false);
	} else {
		out[1] = 127;
		new DataView(out.buffer).setBigUint64(2, BigInt(len), false);
	}
	out.set(payload, headerLen);
	return out;
}

/** Control-frame payload with a close code: `[2B BE code][reason bytes]`. */
export function encodeClosePayload(code: number, reason: string): Uint8Array {
	const reasonBytes = new TextEncoder().encode(reason);
	const out = new Uint8Array(2 + reasonBytes.byteLength);
	new DataView(out.buffer).setUint16(0, code, false);
	out.set(reasonBytes, 2);
	return out;
}

/**
 * Incremental decoder for masked client frames. Reassembles fragmented
 * messages and surfaces control frames as they complete. Throws
 * {@link RelayProtocolError} on protocol violations.
 */
export class FrameDecoder {
	#buffer = new Uint8Array(0);
	#fragOpcode = -1;
	#fragParts: Uint8Array[] = [];
	#fragLen = 0;

	push(chunk: Uint8Array): WsFrame[] {
		this.#buffer = concatBytes(this.#buffer, chunk);
		const frames: WsFrame[] = [];
		// Process as many complete frames as the buffer holds.
		for (;;) {
			if (this.#buffer.byteLength < 2) return frames;
			const first = this.#buffer[0]!;
			const second = this.#buffer[1]!;
			const fin = (first & 0x80) !== 0;
			const opcode = first & 0x0f;
			const masked = (second & 0x80) !== 0;
			if (!masked) throw new RelayProtocolError(CLOSE_PROTOCOL_ERROR, "client frame must be masked");
			let len = second & 0x7f;
			let headerLen = 2;
			if (len === 126) {
				if (this.#buffer.byteLength < 4) return frames;
				len = new DataView(this.#buffer.buffer, this.#buffer.byteOffset).getUint16(2, false);
				headerLen = 4;
			} else if (len === 127) {
				if (this.#buffer.byteLength < 10) return frames;
				const big = new DataView(this.#buffer.buffer, this.#buffer.byteOffset).getBigUint64(2, false);
				if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
					throw new RelayProtocolError(CLOSE_PROTOCOL_ERROR, "frame length too large");
				}
				len = Number(big);
				headerLen = 10;
			}
			const maskOffset = headerLen;
			const payloadOffset = headerLen + 4;
			if (this.#buffer.byteLength < payloadOffset + len) return frames;

			const isControl = (opcode & 0x08) !== 0;
			if (isControl && (!fin || len > 125)) {
				throw new RelayProtocolError(CLOSE_PROTOCOL_ERROR, "invalid control frame");
			}
			if (isControl) {
				const payload = unmask(this.#buffer, payloadOffset, len, maskOffset);
				this.#buffer = this.#buffer.subarray(payloadOffset + len);
				frames.push({ opcode, payload });
				continue;
			}

			if (opcode === OP_CONTINUATION) {
				if (this.#fragOpcode === -1) {
					throw new RelayProtocolError(CLOSE_PROTOCOL_ERROR, "unexpected continuation frame");
				}
				this.#fragParts.push(unmask(this.#buffer, payloadOffset, len, maskOffset));
				this.#fragLen += len;
				this.#buffer = this.#buffer.subarray(payloadOffset + len);
				if (fin) {
					const payload = concatBytes(...this.#fragParts);
					frames.push({ opcode: this.#fragOpcode, payload });
					this.#fragOpcode = -1;
					this.#fragParts = [];
					this.#fragLen = 0;
				}
				continue;
			}

			if (opcode !== OP_TEXT && opcode !== OP_BINARY) {
				throw new RelayProtocolError(CLOSE_PROTOCOL_ERROR, `unsupported opcode ${opcode}`);
			}
			const payload = unmask(this.#buffer, payloadOffset, len, maskOffset);
			this.#buffer = this.#buffer.subarray(payloadOffset + len);
			if (fin) {
				frames.push({ opcode, payload });
			} else {
				if (this.#fragOpcode !== -1) {
					throw new RelayProtocolError(CLOSE_PROTOCOL_ERROR, "nested fragmented message");
				}
				this.#fragOpcode = opcode;
				this.#fragParts = [payload];
				this.#fragLen = len;
			}
		}
	}
}

function unmask(buffer: Uint8Array, payloadOffset: number, len: number, maskOffset: number): Uint8Array {
	const out = new Uint8Array(len);
	for (let i = 0; i < len; i++) {
		out[i] = buffer[payloadOffset + i]! ^ buffer[maskOffset + (i & 3)]!;
	}
	return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	let total = 0;
	for (const part of parts) total += part.byteLength;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

// ── Relay server ────────────────────────────────────────────────────────────

export interface RelayServerOptions {
	/** Bind host; default "0.0.0.0". LAN links use the machine's routable address, not this. */
	host?: string;
	/** Port to listen on; 0 picks a free port. */
	port: number;
	maxGuests?: number;
	maxFrameBytes?: number;
	/** Serve desktop-web static files (dist/) on plain HTTP so the same port
	 *  hosts both the browser UI and the WebSocket relay (LAN/tunnel mode). */
	staticDir?: string;
	/** TLS key/cert PEM. When set the server accepts wss:// (and https:// for
	 *  the static UI); the LAN share uses a self-signed certificate so the
	 *  browser page runs in a secure context (WebCrypto). */
	tls?: { key: string; cert: string };
	/** Shared room registry. When several relay instances serve one share
	 *  (LAN: plaintext + TLS), they must share a registry or a guest joining
	 *  one instance never finds the host that registered on the other
	 *  (4004 "no such room"). Defaults to an instance-private map. */
	rooms?: Map<string, Room>;
	onStatus?: (line: string) => void;
}

export interface RelayServerHandle {
	/** Actual listening port (useful when port 0 was requested). */
	port: number;
	/** `ws://host:port` origin clients connect to. */
	origin: string;
	close: () => Promise<void>;
	roomCount: () => number;
}

interface Peer {
	id: number;
	role: "host" | "guest";
	socket: import("node:net").Socket;
	decoder: FrameDecoder;
	room: Room | null;
	/** Guest joined in plaintext mode (no E2E sealing): frames are raw JSON. */
	plaintext: boolean;
}

export interface Room {
	id: string;
	host: Peer | null;
	guests: Map<number, Peer>;
	nextGuestId: number;
}

export function startRelayServer(options: RelayServerOptions): Promise<RelayServerHandle> {
	const host = options.host ?? "0.0.0.0";
	const maxGuests = options.maxGuests ?? DEFAULT_MAX_GUESTS;
	const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
	const onStatus = options.onStatus;
	const staticDir = options.staticDir;
	const rooms = options.rooms ?? new Map<string, Room>();
	const sockets = new Set<net.Socket>();

	const server = options.tls
		? tls.createServer({ key: options.tls.key, cert: options.tls.cert }, socket => {
				try {
					handleConnection(socket);
				} catch {
					socket.destroy();
				}
			})
		: net.createServer(socket => {
				try {
					handleConnection(socket);
				} catch {
					socket.destroy();
				}
			});

	/**
	 * Raw HTTP/1.1 upgrade parsing. Deliberately not node:http — Bun's http
	 * compatibility layer drops bytes written to an upgraded socket (bun 1.3.14),
	 * while a plain net socket behaves identically on both runtimes.
	 */
	function handleConnection(socket: net.Socket): void {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
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
		socket.on("error", () => socket.destroy());
	}

	function handleRequest(socket: net.Socket, headerText: string): void {
		const lines = headerText.split("\r\n");
		const requestLine = lines[0] ?? "";
		const [method, target] = requestLine.split(" ");
		if (method !== "GET") return rejectHttp(socket, 405, "method not allowed");
		const headers = new Map<string, string>();
		for (const line of lines.slice(1)) {
			const colon = line.indexOf(":");
			if (colon === -1) continue;
			headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
		}
		const upgrade = headers.get("upgrade");
		if (!upgrade || upgrade.toLowerCase() !== "websocket") {
			if (staticDir) return serveStatic(socket, target ?? "/", method, staticDir);
			return rejectHttp(socket, 426, "websocket upgrade required");
		}
		const key = headers.get("sec-websocket-key");
		if (!key) return rejectHttp(socket, 400, "missing sec-websocket-key");

		const url = new URL(target ?? "/", "http://localhost");
		const match = ROOM_PATH_RE.exec(url.pathname);
		if (!match) return rejectHttp(socket, 404, "no such room path");
		const role = url.searchParams.get("role");
		if (role !== "host" && role !== "guest") return rejectHttp(socket, 400, "role must be host or guest");
		// Plaintext mode is a guest-only opt-in for browsers on insecure http
		// (no crypto.subtle); hosts always seal.
		const plaintext = role === "guest" && url.searchParams.get("plaintext") === "1";

		const roomId = match[1]!;
		let room = rooms.get(roomId);
		if (!room) {
			room = { id: roomId, host: null, guests: new Map(), nextGuestId: 1 };
			rooms.set(roomId, room);
		}

		// Room gating happens before the 101 so rejections are delivered as one
		// merged write (101 + close frame). Bun's net compatibility layer drops
		// the second of two synchronous writes, so splitting them would lose the
		// fatal close code the CollabSocket client relies on.
		let reject: { code: number; reason: string } | null = null;
		if (role === "host") {
			if (room.host) {
				rooms.delete(roomId);
				reject = { code: CLOSE_HOST_CONFLICT, reason: "host conflict" };
			}
		} else if (!room.host) {
			rooms.delete(roomId);
			reject = { code: CLOSE_NO_SUCH_ROOM, reason: "no such room" };
		} else if (room.guests.size >= maxGuests) {
			reject = { code: CLOSE_ROOM_FULL, reason: "room is full" };
		}
		const accept = acceptKey(key);
		// The Date header is required by RFC 7231 for HTTP/1.1 responses and Bun's
		// WebSocket client rejects a 101 without it (node/undici accept either).
		const handshake = new TextEncoder().encode(
			"HTTP/1.1 101 Switching Protocols\r\n" +
				"Upgrade: websocket\r\n" +
				"Connection: Upgrade\r\n" +
				`Sec-WebSocket-Accept: ${accept}\r\n` +
				`Date: ${new Date().toUTCString()}\r\n\r\n`,
		);
		if (reject) {
			// 101 first (the client's HTTP stack must see a successful upgrade),
			// then the fatal WS close frame, in a single write + end.
			socket.write(concatBytes(handshake, encodeFrame(OP_CLOSE, encodeClosePayload(reject.code, reject.reason))));
			socket.end();
			return;
		}
		socket.write(handshake);

		const peer: Peer = {
			id: 0,
			role,
			socket,
			decoder: new FrameDecoder(),
			room: null,
			plaintext,
		};

		if (role === "host") {
			room.host = peer;
			peer.room = room;
			peer.id = 0;
			onStatus?.(`collab relay: host joined room ${roomId}`);
		} else {
			const id = room.nextGuestId++;
			peer.id = id;
			peer.room = room;
			room.guests.set(id, peer);
			sendControl(room.host, { t: "peer-joined", peer: id, plaintext: peer.plaintext });
			onStatus?.(`collab relay: guest ${id} joined room ${roomId}`);
		}

		socket.on("data", (chunk: Buffer) => {
			try {
				for (const frame of peer.decoder.push(new Uint8Array(chunk))) {
					handleFrame(peer, frame);
				}
			} catch (err) {
				if (err instanceof RelayProtocolError) {
					void closeWithCode(socket, err.closeCode, err.message);
				} else {
					void closeWithCode(socket, CLOSE_PROTOCOL_ERROR, "protocol error");
				}
			}
		});
		socket.on("close", () => detachPeer(peer));
		socket.on("error", () => detachPeer(peer));
	}

	function handleFrame(peer: Peer, frame: WsFrame): void {
		const room = peer.room;
		if (frame.opcode === OP_TEXT) {
			// Clients never send strings; ignore any (defensive).
			return;
		}
		if (frame.opcode === OP_PING) {
			peer.socket.write(encodeFrame(OP_PONG, frame.payload));
			return;
		}
		if (frame.opcode === OP_PONG) {
			return;
		}
		if (frame.opcode === OP_CLOSE) {
			const code =
				frame.payload.byteLength >= 2
					? new DataView(frame.payload.buffer, frame.payload.byteOffset).getUint16(0, false)
					: 1000;
			// Teardown synchronously: the client's close handshake may not deliver
			// a FIN to this socket (Bun's WebSocket stack releases the connection
			// without one), so the socket 'close' event would never fire detachPeer.
			detachPeer(peer);
			// Single end(data): the echo must ride the same call as the FIN.
			peer.socket.end(encodeFrame(OP_CLOSE, encodeClosePayload(code, "")));
			return;
		}
		if (frame.opcode !== OP_BINARY || !room) return;
		if (frame.payload.byteLength > maxFrameBytes) {
			void closeWithCode(peer.socket, 1009, "frame too large");
			return;
		}
		const envelope = unpackEnvelope(frame.payload);
		if (!envelope) {
			void closeWithCode(peer.socket, CLOSE_PROTOCOL_ERROR, "truncated envelope");
			return;
		}
		routeEnvelope(room, peer, envelope.payload, envelope.peerId);
	}

	function routeEnvelope(room: Room, sender: Peer, sealed: Uint8Array, target: number): void {
		if (target === 0) {
			// Broadcast to every other peer: host → all guests, guest → host.
			const recipients: Peer[] = [];
			if (sender.role === "host") {
				for (const guest of room.guests.values()) recipients.push(guest);
			} else if (room.host && room.host !== sender) {
				recipients.push(room.host);
			}
			for (const recipient of recipients) {
				const copy = copyEnvelopeWithSender(sealed, sender.id);
				if (recipient.socket.writable) recipient.socket.write(encodeFrame(OP_BINARY, copy));
			}
			return;
		}
		const recipient = room.guests.get(target);
		if (!recipient) return;
		const copy = copyEnvelopeWithSender(sealed, sender.id);
		if (recipient.socket.writable) recipient.socket.write(encodeFrame(OP_BINARY, copy));
	}

	function detachPeer(peer: Peer): void {
		const room = peer.room;
		if (!room) return;
		if (peer.role === "host") {
			rooms.delete(room.id);
			for (const guest of room.guests.values()) {
				guest.room = null;
				sendControlAndClose(guest, { t: "room-closed" }, CLOSE_ROOM_CLOSED, "room closed");
			}
			room.guests.clear();
			onStatus?.(`collab relay: host left room ${room.id}`);
		} else {
			room.guests.delete(peer.id);
			if (room.host) sendControl(room.host, { t: "peer-left", peer: peer.id });
			onStatus?.(`collab relay: guest ${peer.id} left room ${room.id}`);
		}
		peer.room = null;
	}

	const { promise, resolve, reject } = Promise.withResolvers<RelayServerHandle>();
	const srv = server as unknown as tls.Server;
	srv.once("error", reject);
	srv.listen({ port: options.port, host }, () => {
		srv.off("error", reject);
		const port = (srv.address() as AddressInfo).port;
		resolve({
			port,
			origin: `${options.tls ? "wss" : "ws"}://${host}:${port}`,
			roomCount: () => rooms.size,
			close: async () => {
				for (const room of rooms.values()) {
					if (room.host) room.host.socket.end();
					for (const guest of room.guests.values()) {
						guest.room = null;
						sendControlAndClose(guest, { t: "room-closed" }, CLOSE_ROOM_CLOSED, "room closed");
					}
					room.guests.clear();
					room.host = null;
				}
				rooms.clear();
				// Destroy any stragglers so server.close() always settles even if
				// a peer never finished its close handshake.
				for (const s of sockets) if (!s.destroyed) s.destroy();
				const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>();
				server.close(() => resolveClosed());
				await closed;
			},
		});
	});
	return promise;
}

function copyEnvelopeWithSender(sealed: Uint8Array, senderId: number): Uint8Array {
	const copy = new Uint8Array(4 + sealed.byteLength);
	copy.set(sealed, 4);
	rewriteEnvelopePeer(copy, senderId);
	return copy;
}

function sendControl(peer: Peer | null, msg: RelayControlMessage): void {
	if (!peer || !peer.socket.writable) return;
	peer.socket.write(encodeFrame(OP_TEXT, new TextEncoder().encode(JSON.stringify(msg))));
}

/**
 * One merged write of the control message + fatal close frame. Bun's net
 * compatibility layer drops the second of two synchronous writes, so control
 * + close must share a single write when fired from the same tick (host drop,
 * server shutdown).
 */
function sendControlAndClose(peer: Peer, msg: RelayControlMessage, code: number, reason: string): void {
	if (!peer.socket.writable) return;
	const payload = concatBytes(
		encodeFrame(OP_TEXT, new TextEncoder().encode(JSON.stringify(msg))),
		encodeFrame(OP_CLOSE, encodeClosePayload(code, reason)),
	);
	peer.socket.write(payload);
	peer.socket.end();
}

function closeWithCode(socket: import("node:net").Socket, code: number, reason: string): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	if (socket.destroyed) {
		resolve();
		return promise;
	}
	// Single end(data): the close frame must ride the same call as the FIN
	// (Bun drops the second of two synchronous writes, and its WebSocket
	// client waits for the close echo before releasing the connection).
	socket.end(encodeFrame(OP_CLOSE, encodeClosePayload(code, reason)));
	resolve();
	return promise;
}

const STATIC_CONTENT_TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".webmanifest": "application/manifest+json",
	".woff2": "font/woff2",
	".map": "application/json",
};

/** Serve a file from {@link RelayServerOptions.staticDir} with path traversal protection. */
function serveStatic(socket: import("node:net").Socket, target: string, method: string, staticDir: string): void {
	if (method !== "GET" && method !== "HEAD") return rejectHttp(socket, 405, "method not allowed");
	const root = path.resolve(staticDir);
	let pathname: string;
	try {
		pathname = decodeURIComponent(new URL(target, "http://localhost").pathname);
	} catch {
		return rejectHttp(socket, 400, "bad request");
	}
	const rel = pathname === "/" ? "index.html" : pathname.slice(1);
	const resolved = path.resolve(root, rel);
	if (resolved !== root && !resolved.startsWith(root + path.sep)) {
		return rejectHttp(socket, 403, "forbidden");
	}
	let body: Buffer | null = null;
	try {
		body = fs.readFileSync(resolved);
	} catch {
		// SPA fallback: unknown routes serve the app shell (except /r/ which is
		// the relay's own namespace).
		if (pathname.startsWith("/r/")) return rejectHttp(socket, 404, "not found");
		try {
			body = fs.readFileSync(path.join(root, "index.html"));
		} catch {
			return rejectHttp(socket, 404, "not found");
		}
	}
	const ext = path.extname(resolved).toLowerCase();
	const type = STATIC_CONTENT_TYPES[ext] ?? "application/octet-stream";
	const header = Buffer.from(
		`HTTP/1.1 200 OK\r\n` +
			`content-type: ${type}\r\n` +
			`content-length: ${body.byteLength}\r\n` +
			`cache-control: no-cache\r\n` +
			"connection: close\r\n\r\n",
	);
	// One merged write: Bun's net compatibility layer drops the second of two
	// synchronous writes to the same socket.
	socket.write(Buffer.concat([header, method === "GET" ? body : Buffer.alloc(0)]));
	socket.end();
}

function rejectHttp(socket: import("node:net").Socket, status: number, message: string): void {
	const body = `${status} ${message}`;
	socket.write(
		`HTTP/1.1 ${status} ${message}\r\n` +
			"content-type: text/plain\r\n" +
			`content-length: ${Buffer.byteLength(body)}\r\n` +
			`Date: ${new Date().toUTCString()}\r\n` +
			"connection: close\r\n\r\n" +
			body,
	);
	socket.end();
}

function acceptKey(key: string): string {
	return createHash("sha1")
		.update(key + WS_GUID)
		.digest("base64");
}
