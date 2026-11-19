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
 *   `{t:"room-closed"}` (followed by a close code) to guests when the room is
 *   gone for good. A host drop that the room may recover from closes guests
 *   with 4001 and no `room-closed`, so they retry instead of ending.
 * - Byte-transparent envelope forwarding: the 4-byte target peerId is
 *   rewritten to the sender's id before fan-out (0 = broadcast to every other
 *   peer in the room, N = directed to that peer).
 *
 * Resilience the room semantics rest on:
 *
 * - A WebSocket ping every 25 s keeps Cloudflare's idle timer from closing a
 *   quiet tunnel and drops peers that stop answering (half-open sockets).
 * - A host drop keeps the room usable for 30 s so the same roomId can reclaim
 *   it; guests closed with 4001 retry inside that window instead of dying. A
 *   host that closes normally (1000) or a relay that stops (1001) ends the
 *   room at once — the clients treat those as terminal, not as a blip.
 * - Per-address upgrade counts and new-connection rate, inbound byte rate,
 *   Origin, and connection/room caps bound one-sided abuse. Page and asset
 *   fetches are exempt from the per-address limits: one UI load opens many
 *   short connections, and behind a tunnel they all share the proxy address.
 *   A rejection keeps the existing close meanings (4004/4009/4029); overload
 *   and policy rejections use 1013/1008.
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
/**
 * One address may hold at most half the seats, so a single party cannot take
 * every guest slot. NAT'd LAN rooms (several people behind one address) need
 * this raised.
 */
const DEFAULT_MAX_GUESTS_PER_IP = DEFAULT_MAX_GUESTS / 2;
const DEFAULT_MAX_CONNECTIONS = 256;
const DEFAULT_MAX_CONNECTIONS_PER_IP = 32;
const DEFAULT_CONNECT_RATE_PER_MINUTE = 60;
const DEFAULT_MAX_ROOMS = 64;
const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_BYTES_PER_SECOND = 32 * 1024 * 1024;
/** Ping cadence; two intervals of silence drop a peer (half-open detection). */
const DEFAULT_HEARTBEAT_MS = 25_000;
/** How long a room outlives its host so the host can reclaim it. */
const DEFAULT_HOST_GRACE_MS = 30_000;
/** Cap on the raw HTTP upgrade header (before the blank line). */
const MAX_REQUEST_HEADER_BYTES = 16 * 1024;
/** A connection that never completes its upgrade header is dropped. */
const HANDSHAKE_TIMEOUT_MS = 10_000;
const CONNECT_RATE_WINDOW_MS = 60_000;
/** Same shape as @musepi/collab-proto's room path; the legacy `.<key>` suffix may be absent. */
const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})(?:\.([A-Za-z0-9_-]+))?$/;

// Close codes the CollabSocket client treats as fatal (relay contract).
const CLOSE_ROOM_CLOSED = 4001;
const CLOSE_NO_SUCH_ROOM = 4004;
const CLOSE_HOST_CONFLICT = 4009;
const CLOSE_ROOM_FULL = 4029;
const CLOSE_PROTOCOL_ERROR = 1002;
/** Policy rejection (Origin, per-address cap, byte rate): retryable. */
const CLOSE_POLICY_VIOLATION = 1008;
/** Relay-level overload (room cap): retryable. */
const CLOSE_TRY_AGAIN_LATER = 1013;
/** The relay itself is stopping: clients treat this as terminal, not a drop. */
const CLOSE_GOING_AWAY = 1001;
/** Host closed the socket on purpose (normal closure): no reclaim window. */
const CLOSE_NORMAL = 1000;

/**
 * Origins the bundled mobile shells run their UI from. The app loads its own
 * assets and then connects to the relay cross-origin, so a same-origin-only
 * check would lock every phone out.
 */
const APP_LOCAL_ORIGINS = new Set(["https://localhost", "capacitor://localhost", "ionic://localhost"]);

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
				this.#buffer = this.#buffer.subarray(payloadOffset + len);
				if (fin) {
					const payload = concatBytes(...this.#fragParts);
					frames.push({ opcode: this.#fragOpcode, payload });
					this.#fragOpcode = -1;
					this.#fragParts = [];
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
	/** Most simultaneous guests one client address may hold in a room; default 8 (half the seats). 0 disables. */
	maxGuestsPerIp?: number;
	/** Most simultaneous TCP connections; default 256. 0 disables. */
	maxConnections?: number;
	/** Most simultaneous WebSocket upgrades from one client address; default 32. 0 disables. */
	maxConnectionsPerIp?: number;
	/** WebSocket upgrades accepted per client address per rolling minute; default 60. 0 disables. */
	connectRatePerMinutePerIp?: number;
	/** Most rooms kept at once (host grace counts as kept); default 64. 0 disables. */
	maxRooms?: number;
	/** Per-connection inbound byte rate, 1 s burst; default 32 MiB/s. 0 disables. */
	maxBytesPerSecond?: number;
	/** Ping cadence; a peer silent for one full interval after a ping is dropped. Default 25 s. 0 disables. */
	heartbeatIntervalMs?: number;
	/** How long a room survives its host so the same roomId can reclaim it; default 30 s. 0 tears down immediately. */
	hostGraceMs?: number;
	/** Extra browser origins accepted on the upgrade, on top of same-origin and the bundled app shells. */
	allowedOrigins?: string[];
	maxFrameBytes?: number;
	/** Serve client-core static files (dist/) on plain HTTP so the same port
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

/**
 * Per-upgrade bookkeeping: whether this socket's upgrade was counted against
 * the per-address limit, so its close releases exactly one slot.
 */
interface UpgradeGate {
	counted: boolean;
}

interface Peer {
	id: number;
	role: "host" | "guest";
	socket: import("node:net").Socket;
	decoder: FrameDecoder;
	room: Room | null;
	/** Guest joined in plaintext mode (no E2E sealing): frames are raw JSON. */
	plaintext: boolean;
	/** Client address the per-address caps and the guest fairness cap key on. */
	ip: string;
	/**
	 * When the outstanding ping was written, or null when the last ping has
	 * been answered (any inbound byte counts). Only a ping that has been
	 * outstanding for a whole heartbeat interval means the peer is gone.
	 */
	awaitingPongSince: number | null;
	/** Remaining inbound bytes (token bucket, refilled at the configured rate). */
	byteBudget: number;
	byteBudgetAt: number;
}

export interface Room {
	id: string;
	host: Peer | null;
	guests: Map<number, Peer>;
	nextGuestId: number;
	/** Set while the host is gone but the room is retained for reclaim. */
	hostGraceTimer?: ReturnType<typeof setTimeout>;
}

export function startRelayServer(options: RelayServerOptions): Promise<RelayServerHandle> {
	const host = options.host ?? "0.0.0.0";
	const maxGuests = options.maxGuests ?? DEFAULT_MAX_GUESTS;
	const maxGuestsPerIp = options.maxGuestsPerIp ?? DEFAULT_MAX_GUESTS_PER_IP;
	const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
	const maxConnectionsPerIp = options.maxConnectionsPerIp ?? DEFAULT_MAX_CONNECTIONS_PER_IP;
	const connectRatePerMinutePerIp = options.connectRatePerMinutePerIp ?? DEFAULT_CONNECT_RATE_PER_MINUTE;
	const maxRooms = options.maxRooms ?? DEFAULT_MAX_ROOMS;
	const maxBytesPerSecond = options.maxBytesPerSecond ?? DEFAULT_MAX_BYTES_PER_SECOND;
	const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
	const hostGraceMs = options.hostGraceMs ?? DEFAULT_HOST_GRACE_MS;
	const allowedOrigins = new Set(options.allowedOrigins ?? []);
	const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
	const onStatus = options.onStatus;
	const staticDir = options.staticDir;
	const rooms = options.rooms ?? new Map<string, Room>();
	const sockets = new Set<net.Socket>();
	const peers = new Set<Peer>();
	/** Live upgraded connections per client address, for the per-address cap. */
	const connectionsByIp = new Map<string, number>();
	/** Recent upgrade times per client address, for the new-connection rate cap. */
	const connectTimesByIp = new Map<string, number[]>();

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
		socket.on("error", () => socket.destroy());
		// Every accepted TCP socket leaves the set, admitted or rejected, so the
		// global cap counts live sockets rather than every socket ever seen.
		socket.on("close", () => sockets.delete(socket));
		const ip = normalizeIp(socket.remoteAddress);
		if (!admitConnection(socket)) return;
		const gate: UpgradeGate = { counted: false };
		const handshakeTimer = setTimeout(() => socket.destroy(), HANDSHAKE_TIMEOUT_MS);
		handshakeTimer.unref?.();
		socket.setKeepAlive(true, DEFAULT_HEARTBEAT_MS);
		socket.on("close", () => {
			clearTimeout(handshakeTimer);
			if (gate.counted) releaseIpCount(ip);
		});
		let buf = "";
		const onData = (chunk: Buffer): void => {
			buf += chunk.toString("latin1");
			const idx = buf.indexOf("\r\n\r\n");
			if (idx === -1) {
				if (buf.length > MAX_REQUEST_HEADER_BYTES) rejectHttp(socket, 431, "request header too large");
				return;
			}
			socket.off("data", onData);
			clearTimeout(handshakeTimer);
			const tail = buf.slice(idx + 4);
			buf = buf.slice(0, idx);
			if (tail) socket.unshift(Buffer.from(tail, "latin1"));
			handleRequest(socket, buf, ip, gate);
		};
		socket.on("data", onData);
	}

	/**
	 * Global connection gate, applied before the upgrade header is parsed so a
	 * flood is rejected at the cheapest point (503). Per-address limits live on
	 * the upgrade path instead — see {@link admitUpgrade}.
	 */
	function admitConnection(socket: net.Socket): boolean {
		if (maxConnections > 0 && sockets.size > maxConnections) {
			rejectHttp(socket, 503, "relay is at capacity");
			return false;
		}
		return true;
	}

	/**
	 * Per-address gates for WebSocket upgrades: live upgraded connections and
	 * the new-connection rate (429). Page and asset fetches are deliberately
	 * excluded — one UI load opens dozens of short static connections, and
	 * behind a tunnel they all arrive from the proxy's loopback address, so
	 * counting them would spend the budget the join handshake needs. Static
	 * traffic stays bounded by the global connection cap and the handshake
	 * timeout.
	 */
	function admitUpgrade(socket: net.Socket, ip: string): boolean {
		const live = connectionsByIp.get(ip) ?? 0;
		if (maxConnectionsPerIp > 0 && live + 1 > maxConnectionsPerIp) {
			rejectHttp(socket, 429, "too many connections from this address");
			return false;
		}
		if (connectRatePerMinutePerIp > 0) {
			const now = Date.now();
			// Bounded bookkeeping: a busy relay with many client addresses must not
			// accumulate stale rate windows forever.
			if (connectTimesByIp.size > 1024) {
				for (const [address, times] of connectTimesByIp) {
					if (times.every(at => now - at >= CONNECT_RATE_WINDOW_MS)) connectTimesByIp.delete(address);
				}
			}
			const recent = (connectTimesByIp.get(ip) ?? []).filter(at => now - at < CONNECT_RATE_WINDOW_MS);
			if (recent.length >= connectRatePerMinutePerIp) {
				connectTimesByIp.set(ip, recent);
				rejectHttp(socket, 429, "connection rate limit");
				return false;
			}
			recent.push(now);
			connectTimesByIp.set(ip, recent);
		}
		connectionsByIp.set(ip, live + 1);
		return true;
	}

	function releaseIpCount(ip: string): void {
		const live = connectionsByIp.get(ip);
		if (live === undefined) return;
		if (live <= 1) connectionsByIp.delete(ip);
		else connectionsByIp.set(ip, live - 1);
	}

	function handleRequest(socket: net.Socket, headerText: string, ip: string, gate: UpgradeGate): void {
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
		if (upgrade?.toLowerCase() !== "websocket") {
			if (staticDir) return serveStatic(socket, target ?? "/", method, staticDir);
			return rejectHttp(socket, 426, "websocket upgrade required");
		}
		const key = headers.get("sec-websocket-key");
		if (!key) return rejectHttp(socket, 400, "missing sec-websocket-key");
		// Browsers attach Origin to the upgrade; non-browser clients (terminal
		// joins, native shells) do not. An Origin this relay did not serve is a
		// cross-site page driving the relay without the user's intent.
		const origin = headers.get("origin");
		if (origin !== undefined && !isAllowedOrigin(origin, headers.get("host"), allowedOrigins)) {
			return rejectHttp(socket, 403, "origin not allowed");
		}
		if (!admitUpgrade(socket, ip)) return;
		gate.counted = true;

		const url = new URL(target ?? "/", "http://localhost");
		const match = ROOM_PATH_RE.exec(url.pathname);
		if (!match) return rejectHttp(socket, 404, "no such room path");
		const role = url.searchParams.get("role");
		if (role !== "host" && role !== "guest") return rejectHttp(socket, 400, "role must be host or guest");
		// Plaintext mode is a guest-only opt-in for browsers on insecure http
		// (no crypto.subtle); hosts always seal.
		const plaintext = role === "guest" && url.searchParams.get("plaintext") === "1";
		// Tunnel and tailscale-serve front ends connect from loopback; the room
		// fairness cap must see the real guest, not the proxy's address, or one
		// proxy address would own every seat.
		const clientIp = isLoopbackAddress(ip) ? (forwardedClientIp(headers) ?? ip) : ip;

		const roomId = match[1]!;
		let room = rooms.get(roomId) ?? null;
		let reclaim = false;
		// Room gating happens before the 101 so rejections are delivered as one
		// merged write (101 + close frame). Bun's net compatibility layer drops
		// the second of two synchronous writes, so splitting them would lose the
		// fatal close code the CollabSocket client relies on.
		let reject: { code: number; reason: string } | null = null;
		if (role === "host" && !room) {
			if (maxRooms > 0 && rooms.size >= maxRooms) {
				reject = { code: CLOSE_TRY_AGAIN_LATER, reason: "relay is at capacity" };
			} else {
				room = { id: roomId, host: null, guests: new Map(), nextGuestId: 1 };
				rooms.set(roomId, room);
			}
		}
		if (!reject) {
			if (role === "host") {
				// A second host never tears the live room down: a stranger who
				// learns the roomId must not be able to evict the real host and
				// its guests. The only exception is a host socket that has already
				// missed a whole heartbeat interval — the same condition the
				// heartbeat drops sockets on — because waiting for that drop would
				// lock the real host out of its own room.
				const incumbent = room!.host;
				if (incumbent && hasMissedHeartbeat(incumbent, Date.now())) {
					incumbent.room = null;
					peers.delete(incumbent);
					incumbent.socket.destroy();
					room!.host = null;
					reclaim = true;
					onStatus?.(`collab relay: replaced unresponsive host in room ${roomId}`);
				} else if (incumbent) {
					reject = { code: CLOSE_HOST_CONFLICT, reason: "host conflict" };
				} else {
					reclaim = room!.hostGraceTimer !== undefined;
				}
			} else if (!room || (!room.host && room.hostGraceTimer === undefined)) {
				reject = { code: CLOSE_NO_SUCH_ROOM, reason: "no such room" };
			} else if (room.guests.size >= maxGuests) {
				reject = { code: CLOSE_ROOM_FULL, reason: "room is full" };
			} else if (maxGuestsPerIp > 0 && guestsFromIp(room, clientIp) >= maxGuestsPerIp) {
				reject = { code: CLOSE_POLICY_VIOLATION, reason: "too many guests from one address" };
			}
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
			ip: clientIp,
			awaitingPongSince: null,
			byteBudget: maxBytesPerSecond,
			byteBudgetAt: Date.now(),
		};
		peers.add(peer);

		if (role === "host") {
			const target = room!;
			if (target.hostGraceTimer !== undefined) {
				clearTimeout(target.hostGraceTimer);
				target.hostGraceTimer = undefined;
			}
			target.host = peer;
			peer.room = target;
			peer.id = 0;
			// Guests that joined during the grace window were told nobody, so the
			// reclaiming host learns about them now.
			if (reclaim) {
				for (const guest of target.guests.values()) {
					sendControl(peer, { t: "peer-joined", peer: guest.id, plaintext: guest.plaintext });
				}
				onStatus?.(`collab relay: host reclaimed room ${roomId}`);
			} else {
				onStatus?.(`collab relay: host joined room ${roomId}`);
			}
		} else {
			const target = room!;
			const id = target.nextGuestId++;
			peer.id = id;
			peer.room = target;
			target.guests.set(id, peer);
			sendControl(target.host, { t: "peer-joined", peer: id, plaintext: peer.plaintext });
			onStatus?.(`collab relay: guest ${id} joined room ${roomId}`);
		}

		socket.on("data", (chunk: Buffer) => {
			peer.awaitingPongSince = null;
			if (!spendByteBudget(peer, chunk.byteLength)) {
				void closeWithCode(socket, CLOSE_POLICY_VIOLATION, "byte rate limit exceeded");
				return;
			}
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
		socket.on("close", () => {
			peers.delete(peer);
			detachPeer(peer);
		});
		socket.on("error", () => {
			peers.delete(peer);
			detachPeer(peer);
		});
	}

	/** Token-bucket inbound rate: false once the peer spent its 1 s burst. */
	function spendByteBudget(peer: Peer, cost: number): boolean {
		if (maxBytesPerSecond <= 0) return true;
		const now = Date.now();
		peer.byteBudget = Math.min(
			maxBytesPerSecond,
			peer.byteBudget + ((now - peer.byteBudgetAt) / 1000) * maxBytesPerSecond,
		);
		peer.byteBudgetAt = now;
		if (peer.byteBudget < cost) return false;
		peer.byteBudget -= cost;
		return true;
	}

	/**
	 * Liveness signal shared by the heartbeat and the host-reclaim path: a ping
	 * has been outstanding for a whole interval, so the peer is gone. A ping
	 * that is merely in flight (the normal RTT case) is not a miss — otherwise
	 * a healthy host could be evicted during every heartbeat round-trip.
	 */
	function hasMissedHeartbeat(peer: Peer, now: number): boolean {
		return (
			heartbeatIntervalMs > 0 &&
			peer.awaitingPongSince !== null &&
			now - peer.awaitingPongSince >= heartbeatIntervalMs
		);
	}

	function guestsFromIp(room: Room, ip: string): number {
		let count = 0;
		for (const guest of room.guests.values()) if (guest.ip === ip) count++;
		return count;
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
			detachPeer(peer, code === CLOSE_NORMAL);
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

	function detachPeer(peer: Peer, hostStopped = false): void {
		const room = peer.room;
		if (!room) return;
		peer.room = null;
		peers.delete(peer);
		if (peer.role === "host") {
			// A socket from a host that already lost the room must not touch it.
			if (room.host !== peer) return;
			room.host = null;
			// Keep the room claimable only when the host vanished without saying
			// goodbye. A normal close means sharing stopped on purpose: the room
			// is destroyed now, so a guest retry gets 4004 instead of waiting out
			// the window for a host that is not coming back.
			const recoverable = hostGraceMs > 0 && !hostStopped;
			for (const guest of room.guests.values()) {
				guest.room = null;
				// `room-closed` is the guests' end-of-session signal, so it must
				// only ride a final teardown. While the room is retained the guest
				// is closed with 4001 alone and rejoins when the host reclaims it.
				if (recoverable) {
					closeWithCode(guest.socket, CLOSE_ROOM_CLOSED, "host disconnected");
				} else {
					sendControlAndClose(guest, { t: "room-closed" }, CLOSE_ROOM_CLOSED, "room closed");
				}
			}
			room.guests.clear();
			onStatus?.(`collab relay: host left room ${room.id}`);
			// Guests retry 4001 and land back in the same room while the grace runs.
			if (recoverable) {
				room.hostGraceTimer = setTimeout(() => destroyRoom(room), hostGraceMs);
				room.hostGraceTimer.unref?.();
				onStatus?.(`collab relay: room ${room.id} retained for ${hostGraceMs}ms`);
			} else {
				destroyRoom(room);
			}
		} else {
			room.guests.delete(peer.id);
			if (room.host) sendControl(room.host, { t: "peer-left", peer: peer.id });
			onStatus?.(`collab relay: guest ${peer.id} left room ${room.id}`);
		}
	}

	function destroyRoom(room: Room): void {
		if (room.hostGraceTimer !== undefined) {
			clearTimeout(room.hostGraceTimer);
			room.hostGraceTimer = undefined;
		}
		rooms.delete(room.id);
		for (const guest of room.guests.values()) {
			guest.room = null;
			sendControlAndClose(guest, { t: "room-closed" }, CLOSE_ROOM_CLOSED, "room closed");
		}
		room.guests.clear();
		room.host = null;
	}

	const heartbeatTimer =
		heartbeatIntervalMs > 0
			? setInterval(() => {
					const now = Date.now();
					for (const peer of peers) {
						// A ping unanswered for a whole interval means the connection
						// is half-open: the client is gone and only a TCP retransmit
						// would ever notice.
						if (hasMissedHeartbeat(peer, now)) {
							peer.socket.destroy();
							continue;
						}
						// A ping still in flight has the rest of its interval to be
						// answered; pinging again would only reset the clock.
						if (peer.awaitingPongSince !== null) continue;
						peer.awaitingPongSince = now;
						if (peer.socket.writable && !peer.socket.destroyed) {
							peer.socket.write(encodeFrame(OP_PING, new Uint8Array(0)));
						}
					}
				}, heartbeatIntervalMs)
			: undefined;
	heartbeatTimer?.unref?.();

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
				if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
				for (const room of rooms.values()) {
					if (room.hostGraceTimer !== undefined) {
						clearTimeout(room.hostGraceTimer);
						room.hostGraceTimer = undefined;
					}
					if (room.host) room.host.socket.end();
					for (const guest of room.guests.values()) {
						guest.room = null;
						sendControlAndClose(guest, { t: "room-closed" }, CLOSE_GOING_AWAY, "sharing stopped");
					}
					room.guests.clear();
					room.host = null;
				}
				rooms.clear();
				peers.clear();
				connectionsByIp.clear();
				connectTimesByIp.clear();
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

/** `::ffff:127.0.0.1` and `127.0.0.1` are the same client behind a dual-stack bind. */
function normalizeIp(address: string | undefined): string {
	if (!address) return "unknown";
	return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

/** The immediate peer is a local proxy (tunnel agent, tailscale serve). */
function isLoopbackAddress(ip: string): boolean {
	return ip === "127.0.0.1" || ip === "::1" || ip === "localhost";
}

const IP_LITERAL_RE = /^[0-9A-Fa-f:.]{3,45}$/;

/**
 * The guest address a local proxy reports. Read only for loopback peers: on a
 * LAN bind the socket address is authoritative, so a remote client cannot pick
 * its own fairness bucket by sending a header.
 */
function forwardedClientIp(headers: Map<string, string>): string | null {
	const candidate = (headers.get("cf-connecting-ip") ?? headers.get("x-forwarded-for")?.split(",")[0])?.trim();
	return candidate && IP_LITERAL_RE.test(candidate) ? candidate : null;
}

/**
 * Browser upgrade gate: the relay's own pages (same origin as the request's
 * Host), the bundled mobile shells that load their UI locally, and explicitly
 * configured origins. Clients that send no Origin at all (terminal joins,
 * native WebSocket stacks) are not browser pages and pass.
 */
function isAllowedOrigin(origin: string, requestHost: string | undefined, extra: Set<string>): boolean {
	if (extra.has(origin)) return true;
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}
	if (APP_LOCAL_ORIGINS.has(`${url.protocol}//${url.host}`)) return true;
	if (!requestHost) return false;
	return stripDefaultPort(url.host) === stripDefaultPort(requestHost);
}

/** The Host header carries no scheme, so both sides drop their default port. */
function stripDefaultPort(host: string): string {
	return host.toLowerCase().replace(/:(80|443)$/, "");
}

function copyEnvelopeWithSender(sealed: Uint8Array, senderId: number): Uint8Array {
	const copy = new Uint8Array(4 + sealed.byteLength);
	copy.set(sealed, 4);
	rewriteEnvelopePeer(copy, senderId);
	return copy;
}

function sendControl(peer: Peer | null, msg: RelayControlMessage): void {
	if (!peer?.socket.writable) return;
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
