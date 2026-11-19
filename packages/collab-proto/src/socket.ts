/**
 * Client-side WebSocket wrapper for collab live-session sharing. Generic over
 * the frame type: hosts pass their rich `CollabFrame`, guests pass the wire
 * `GuestFrame`/`HostFrame`. Pure transport — no i18n, no logging dependency,
 * no agent imports. Callers translate close reasons at the UI layer.
 *
 * Connects to a relay room, seals/opens AES-GCM frames, and reconnects with
 * exponential backoff on transient drops. Close 4001 (host dropped) is
 * transient inside the relay's host grace — see {@link shouldRetryRoomClosed}
 * — while a room that is gone (4004), stolen (4009), full (4029), the relay
 * stopping (1001), and decryption failures never reconnect. Host frames get
 * WS backpressure (send stalls past a buffered-amount threshold); guests
 * benefit from the same buffering for pending sends across reconnects.
 */
import type { RelayControlMessage } from "@musepi/pi-wire";
import { open, seal } from "./crypto";
import { packEnvelope, unpackEnvelope } from "./link";

const FATAL_CLOSE_REASONS: Record<number, string> = {
	4004: "no such room",
	4009: "a host is already connected for this room",
	4029: "room is full",
	1001: "sharing stopped",
};

/** Relay contract: the room closed because its host dropped. */
export const CLOSE_ROOM_CLOSED = 4001;
/**
 * Room-closed retry budget, shared by both collab clients (this one and the
 * coding agent's terminal client) so a guest behaves the same in a browser and
 * in a terminal. The relay keeps a room for 30 s after an unexpected host
 * drop; retries inside that budget may land back in the room, and a room that
 * is really gone answers 4004 (fatal) first anyway.
 */
export const ROOM_CLOSED_RETRY_MS = 30_000;
/** How many 4001 closes one retry streak tolerates. */
export const ROOM_CLOSED_MAX_RETRIES = 5;

export interface RoomClosedRetry {
	/** First 4001 of the current streak. */
	since: number;
	/** 4001 closes counted in the streak. */
	retries: number;
}

/**
 * Whether a guest may keep retrying after 4001. A host that stops on purpose
 * sends a sealed `bye` first (the guest ends its own session); this window only
 * covers the case where the socket vanished without one.
 */
export function shouldRetryRoomClosed(state: RoomClosedRetry, now = Date.now()): boolean {
	return now - state.since < ROOM_CLOSED_RETRY_MS && state.retries <= ROOM_CLOSED_MAX_RETRIES;
}

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
/** Max enveloped frames buffered while a reconnect is pending; overflow is dropped. */
const MAX_PENDING_SENDS = 256;
const WS_BACKPRESSURE_THRESHOLD = 64 * 1024;
const WS_BACKPRESSURE_DRAIN_THRESHOLD = 32 * 1024;
const WS_BACKPRESSURE_DRAIN_RETRY_MS = 25;

export interface CollabSocketOptions {
	/** wss://host[:port]/r/<roomId> — no query string. */
	wsUrl: string;
	role: "host" | "guest";
	/** Room key; a pending import promise is awaited inside the seal/open chains. Required unless {@link plaintext}. */
	key?: CryptoKey | PromiseLike<CryptoKey>;
	/**
	 * Guest in plaintext mode: frames are raw JSON instead of AES-GCM sealed.
	 * Only for browsers on insecure http (no crypto.subtle); the host encodes
	 * per-peer and never needs this flag.
	 */
	plaintext?: boolean;
}

export class CollabSocket<TReceive, TSend = TReceive> {
	/** Fires after every successful (re)connect. */
	onOpen?: () => void;
	onFrame?: (frame: TReceive, fromPeer: number) => void;
	onControl?: (msg: RelayControlMessage) => void;
	/**
	 * Fires once per terminal close (intentional, fatal code, or bad key).
	 * `willReconnect=true` for transient drops that will retry. `reason` is the
	 * raw English message (or the relay-provided reason string) — translate at
	 * the UI layer.
	 */
	onClose?: (reason: string, willReconnect: boolean) => void;

	readonly #opts: CollabSocketOptions;
	#ws: WebSocket | null = null;
	#retryTimer: Timer | undefined;
	#backpressureDrainTimer: Timer | undefined;
	#attempt = 0;
	/** Terminal state: intentional close or fatal failure. Cleared by connect(). */
	#closed = false;
	/** 4001 retry streak state; reset by every successful open. */
	#roomClosed: RoomClosedRetry | undefined;
	/** Serializes seal() so frames hit the wire in send() order. */
	#sendChain: Promise<void> = Promise.resolve();
	/** Serializes open() so frames are delivered in arrival order. */
	#recvChain: Promise<void> = Promise.resolve();
	/** Envelopes sealed while disconnected, flushed on the next open. */
	#pendingSends: Uint8Array<ArrayBuffer>[] = [];

	constructor(opts: CollabSocketOptions) {
		this.#opts = opts;
	}

	get isOpen(): boolean {
		return this.#ws?.readyState === WebSocket.OPEN;
	}

	connect(): void {
		if (this.#ws || this.#retryTimer) return;
		this.#closed = false;
		this.#attempt = 0;
		this.#roomClosed = undefined;
		this.#openSocket();
	}

	send(frame: TSend, targetPeer = 0): void {
		this.#sendChain = this.#sendChain
			.then(async () => {
				if (this.#closed) return;
				const payload = this.#opts.plaintext
					? new TextEncoder().encode(JSON.stringify(frame))
					: await seal(await this.#opts.key!, frame);
				const envelope = packEnvelope(targetPeer, payload) as Uint8Array<ArrayBuffer>;
				const ws = this.#ws;
				if (ws && ws.readyState === WebSocket.OPEN) {
					this.#sendEnvelope(ws, envelope);
					return;
				}
				if (this.#pendingSends.length >= MAX_PENDING_SENDS) return;
				this.#pendingSends.push(envelope);
			})
			.catch(() => {
				// dropped frame; the socket-level close path reports actionable failures
			});
	}

	/** Intentional close: clears any retry timer, suppresses reconnect. A later connect() starts fresh. */
	close(): void {
		const hadActivity = this.#ws !== null || this.#retryTimer !== undefined;
		this.#clearRetry();
		this.#clearBackpressure();
		const wasClosed = this.#closed;
		this.#closed = true;
		this.#pendingSends.length = 0;
		const ws = this.#ws;
		this.#ws = null;
		if (ws) {
			try {
				ws.close(1000);
			} catch {
				// already closing/closed
			}
		}
		if (hadActivity && !wasClosed) this.onClose?.("closed", false);
	}

	#openSocket(): void {
		const url = new URL(this.#opts.wsUrl);
		url.searchParams.set("role", this.#opts.role);
		if (this.#opts.plaintext) url.searchParams.set("plaintext", "1");
		const ws = new WebSocket(url.toString());
		ws.binaryType = "arraybuffer";
		this.#ws = ws;
		ws.onopen = () => {
			if (this.#ws !== ws) return;
			this.#attempt = 0;
			// The relay admitted the room, so any room-closed streak is over.
			this.#roomClosed = undefined;
			for (const envelope of this.#pendingSends) ws.send(envelope);
			this.#pendingSends.length = 0;
			this.onOpen?.();
		};
		ws.onmessage = (event: MessageEvent) => {
			if (this.#ws !== ws) return;
			this.#handleMessage(ws, event.data);
		};
		ws.onerror = () => {
			// The paired close event carries the actionable state; nothing to do here.
		};
		ws.onclose = (event: CloseEvent) => {
			if (this.#ws !== ws) return;
			this.#ws = null;
			this.#handleClose(event.code, event.reason);
		};
	}

	#handleMessage(ws: WebSocket, data: unknown): void {
		if (typeof data === "string") {
			try {
				this.onControl?.(JSON.parse(data) as RelayControlMessage);
			} catch {
				console.warn("collab: ignoring malformed control message");
			}
			return;
		}
		const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data instanceof Uint8Array ? data : null;
		if (!bytes) {
			console.warn("collab: ignoring binary message of unexpected shape");
			return;
		}
		const envelope = unpackEnvelope(bytes);
		if (!envelope) {
			console.warn("collab: ignoring truncated envelope");
			return;
		}
		this.#recvChain = this.#recvChain
			.then(async () => {
				if (this.#ws !== ws) return;
				let frame: TReceive;
				if (this.#opts.plaintext) {
					try {
						frame = JSON.parse(new TextDecoder().decode(envelope.payload)) as TReceive;
					} catch {
						this.#failFatal("bad key or corrupted frame");
						return;
					}
				} else {
					try {
						frame = (await open(await this.#opts.key!, envelope.payload)) as TReceive;
					} catch {
						this.#failFatal("bad key or corrupted frame");
						return;
					}
				}
				if (this.#ws !== ws) return;
				this.onFrame?.(frame, envelope.peerId);
			})
			.catch(() => {
				// listener threw; keep the receive chain alive
			});
	}

	#handleClose(code: number, reason: string): void {
		if (this.#closed) return;
		const fatalReason = FATAL_CLOSE_REASONS[code];
		if (fatalReason !== undefined) {
			this.#closed = true;
			this.#pendingSends.length = 0;
			this.onClose?.(fatalReason, false);
			return;
		}
		if (code === CLOSE_ROOM_CLOSED) {
			const now = Date.now();
			this.#roomClosed ??= { since: now, retries: 0 };
			this.#roomClosed.retries++;
			if (!shouldRetryRoomClosed(this.#roomClosed, now)) {
				this.#closed = true;
				this.#pendingSends.length = 0;
				this.onClose?.("room closed", false);
				return;
			}
			// Host dropped, relay still holds the room: rejoin instead of dying.
			this.onClose?.("room closed, waiting for the host", true);
			this.#scheduleRetry();
			return;
		}
		this.onClose?.(reason || `connection lost (code ${code})`, true);
		this.#scheduleRetry();
	}

	/** Decryption failure: wrong key or corrupted frame. Never reconnect. */
	#failFatal(reason: string): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#clearRetry();
		this.#clearBackpressure();
		this.#pendingSends.length = 0;
		const ws = this.#ws;
		this.#ws = null;
		if (ws) {
			try {
				ws.close(1000);
			} catch {
				// already closing/closed
			}
		}
		this.onClose?.(reason, false);
	}

	#scheduleRetry(): void {
		const base = Math.min(BACKOFF_BASE_MS * 2 ** this.#attempt, BACKOFF_MAX_MS);
		this.#attempt++;
		const delay = base * (0.75 + Math.random() * 0.5);
		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = undefined;
			if (this.#closed) return;
			this.#openSocket();
		}, delay);
	}

	#clearRetry(): void {
		if (this.#retryTimer !== undefined) {
			clearTimeout(this.#retryTimer);
			this.#retryTimer = undefined;
		}
	}

	#clearBackpressure(): void {
		if (this.#backpressureDrainTimer !== undefined) {
			clearTimeout(this.#backpressureDrainTimer);
			this.#backpressureDrainTimer = undefined;
		}
	}

	/** Buffered-amount backpressure: stall sends while the socket is backed up. */
	#sendEnvelope(ws: WebSocket, envelope: Uint8Array<ArrayBuffer>): void {
		if (ws.bufferedAmount > WS_BACKPRESSURE_THRESHOLD) {
			this.#backpressureDrainTimer ??= setTimeout(() => {
				this.#backpressureDrainTimer = undefined;
				if (this.#ws === ws && this.#ws?.bufferedAmount <= WS_BACKPRESSURE_DRAIN_THRESHOLD) {
					ws.send(envelope);
				} else {
					this.#sendEnvelope(ws, envelope);
				}
			}, WS_BACKPRESSURE_DRAIN_RETRY_MS);
			return;
		}
		ws.send(envelope);
	}
}
