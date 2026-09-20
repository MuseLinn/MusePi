import { logger } from "@musepi/pi-utils";
import { chunkText } from "./chunk";
import type { ChannelAdapter, ChannelHost, ChannelInboundSink, ChannelSendPayload, ChannelStatus } from "./types";

interface DiscordMessage {
	id?: string;
	author?: { id?: string; bot?: boolean };
	channel_id?: string;
	content?: string;
	attachments?: { url?: string; content_type?: string; filename?: string }[];
}

/** Minimal Discord bot adapter — no discord.js dependency. Implements the
 *  gateway v10 subset (hello/heartbeat/identify + MESSAGE_CREATE receive)
 *  and the REST message-send path. Incoming messages route through the
 *  registry's command handler; replies go back to the source channel. */
export class DiscordChannel implements ChannelAdapter {
	readonly kind = "discord" as const;
	#token = "";
	#state: ChannelStatus["state"] = "off";
	#detail: string | undefined;
	#socket: WebSocket | null = null;
	#heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	#lastSeq: number | null = null;
	#selfId = "";
	/** Gateway session identity — needed to RESUME (op 6) instead of burning a
	 *  fresh IDENTIFY (which is rate-limited). */
	#sessionId = "";
	#resumeUrl = "";
	/** Heartbeat-ack watchdog: a beat that is never acked means the socket is a
	 *  zombie and must be torn down (Discord's documented requirement). */
	#awaitingAck = false;
	#reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	#reconnectAttempts = 0;
	/** Distinguishes an intentional stop() from a dropped socket — only the
	 *  latter schedules a reconnect. */
	#stopped = false;
	/** Injected by the registry at construction: (kind, from, text, images). */
	#onMessage: ChannelInboundSink | null = null;

	static readonly GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
	static readonly TEXT_CHUNK = 2000;
	static readonly REST = "https://discord.com/api/v10";
	/** Discord's typing indicator expires after 10s. */
	static readonly TYPING_REFRESH_MS = 8_000;
	/** GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT.
	 *  MESSAGE_CONTENT (1<<15) is a privileged intent: WITHOUT it every guild
	 *  message that does not @mention the bot arrives with an EMPTY `content`
	 *  (only DMs and @mentions are exempt), which silently kills the bot in
	 *  group channels. It must also be toggled on in the Developer Portal or
	 *  IDENTIFY is rejected with 4014 Disallowed Intents. */
	static readonly INTENTS = (1 << 9) | (1 << 12) | (1 << 15);
	/** Per-channel typing heartbeats — cleared in stopTyping()/stop(). */
	#typingTimers = new Map<string, ReturnType<typeof setInterval>>();

	async configure(config: Record<string, unknown>): Promise<void> {
		this.#token = typeof config.token === "string" ? config.token : "";
	}

	async start(): Promise<void> {
		if (!this.#token) {
			this.#state = "error";
			this.#detail = "missing bot token — configure the channel first";
			throw new Error(this.#detail);
		}
		this.#stopped = false;
		this.#state = "connecting";
		this.#detail = "connecting…";
		try {
			await this.#connect();
		} catch (err) {
			this.#state = "error";
			this.#detail = err instanceof Error ? err.message : String(err);
			throw err;
		}
	}

	/** Open (or reopen) the gateway socket. Resolves on READY / RESUMED. A
	 *  dropped socket reconnects on its own with capped exponential backoff —
	 *  without that, one network blip left the bot permanently offline until a
	 *  manual restart. RESUME (op 6) when a session id survives, IDENTIFY (op 2)
	 *  only when it does not (IDENTIFY is rate-limited per day). */
	#connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(this.#resumeUrl || DiscordChannel.GATEWAY_URL);
			this.#socket = ws;
			let handshake = false;
			ws.onopen = () => {
				// wait for Hello
			};
			ws.onmessage = e => {
				let msg: { op?: number; t?: string; d?: unknown; s?: number | null };
				try {
					msg = JSON.parse(String(e.data)) as typeof msg;
				} catch {
					return;
				}
				if (typeof msg.s === "number") this.#lastSeq = msg.s;
				if (msg.op === 10) {
					// Hello — start the heartbeat, then IDENTIFY or RESUME.
					const hello = msg.d as { heartbeat_interval?: number };
					this.#startHeartbeat(hello.heartbeat_interval ?? 41250);
					if (this.#sessionId) this.#resume();
					else this.#identify();
					return;
				}
				if (msg.op === 1) {
					// Server-requested heartbeat — answer immediately.
					this.#sendOp(1, this.#lastSeq);
					return;
				}
				if (msg.op === 11) {
					this.#awaitingAck = false;
					return;
				}
				if (msg.op === 7) {
					// Reconnect requested — onclose reschedules.
					ws.close(4004, "gateway requested reconnect");
					return;
				}
				if (msg.op === 9) {
					// Invalid Session: d=true is resumable, d=false needs a fresh IDENTIFY.
					if (msg.d !== true) {
						this.#sessionId = "";
						this.#lastSeq = null;
					}
					ws.close(4009, "invalid session");
					return;
				}
				if (msg.op === 0 && msg.t === "READY") {
					const ready = msg.d as {
						user?: { id?: string };
						session_id?: string;
						resume_gateway_url?: string;
					};
					this.#selfId = ready.user?.id ?? "";
					this.#sessionId = ready.session_id ?? "";
					if (ready.resume_gateway_url) this.#resumeUrl = ready.resume_gateway_url;
					handshake = true;
					this.#markConnected();
					resolve();
					return;
				}
				if (msg.op === 0 && msg.t === "RESUMED") {
					handshake = true;
					this.#markConnected();
					resolve();
					return;
				}
				if (msg.op === 0 && msg.t === "MESSAGE_CREATE") {
					void this.#handleMessage(msg.d as DiscordMessage).catch(() => {});
				}
			};
			ws.onerror = () => {
				if (!handshake) reject(new Error("gateway connection failed"));
			};
			ws.onclose = () => {
				this.#stopHeartbeat();
				this.#socket = null;
				this.#state = "off";
				this.#detail = "disconnected";
				if (!this.#stopped) this.#scheduleReconnect();
			};
		});
	}

	#markConnected(): void {
		this.#reconnectAttempts = 0;
		this.#state = "connected";
		this.#detail = "connected";
	}

	#identify(): void {
		this.#sendOp(2, {
			token: this.#token,
			intents: DiscordChannel.INTENTS,
			properties: { os: "linux", browser: "musepi", device: "musepi" },
		});
	}

	#resume(): void {
		this.#sendOp(6, { token: this.#token, session_id: this.#sessionId, seq: this.#lastSeq });
	}

	#startHeartbeat(interval: number): void {
		this.#stopHeartbeat();
		this.#awaitingAck = false;
		this.#heartbeatTimer = setInterval(() => this.#beat(), interval);
		this.#heartbeatTimer.unref?.();
	}

	#stopHeartbeat(): void {
		if (this.#heartbeatTimer) {
			clearInterval(this.#heartbeatTimer);
			this.#heartbeatTimer = null;
		}
		this.#awaitingAck = false;
	}

	/** One heartbeat — a beat that was never acked means the socket is a zombie
	 *  (Discord's documented rule), so tear it down and let onclose reconnect. */
	#beat(): void {
		if (this.#awaitingAck) {
			this.#socket?.close(4000, "heartbeat ack timeout");
			return;
		}
		this.#awaitingAck = true;
		this.#sendOp(1, this.#lastSeq);
	}

	/** Reconnect with capped exponential backoff (1s → 2s → 4s … 60s). */
	#scheduleReconnect(): void {
		if (this.#stopped || this.#reconnectTimer) return;
		const wait = Math.min(1000 * 2 ** this.#reconnectAttempts, 60_000);
		this.#reconnectAttempts++;
		this.#state = "connecting";
		this.#detail = `reconnecting in ${Math.round(wait / 1000)}s…`;
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = null;
			void this.#connect().catch(() => {});
		}, wait);
		this.#reconnectTimer.unref?.();
	}

	#sendOp(op: number, d: unknown): void {
		const ws = this.#socket;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		ws.send(JSON.stringify({ op, d }));
	}

	/** Route an incoming Discord message: ignore bots/self, download image
	 *  attachments, forward (text + images) to the command handler. */
	async #handleMessage(m: DiscordMessage): Promise<void> {
		if (!m.author || m.author.bot || m.author.id === this.#selfId) return;
		const from = m.channel_id ?? "unknown";
		const images: { data: string; mimeType: string }[] = [];
		const notes: string[] = [];
		for (const a of m.attachments ?? []) {
			if (!a.url) continue;
			if (a.content_type?.startsWith("image/")) {
				try {
					const res = await fetch(a.url);
					if (!res.ok) continue;
					const bytes = Buffer.from(await res.arrayBuffer());
					if (bytes.length > 20 * 1024 * 1024) {
						notes.push(`📎 ${a.filename ?? "file"}（超过 20MB，已跳过）`);
						continue;
					}
					images.push({ data: bytes.toString("base64"), mimeType: a.content_type });
				} catch {
					// skip unreadable attachment
				}
			} else {
				// Non-image attachments are not representable as session content —
				// surface the file name so nothing arrives silently.
				notes.push(`📎 ${a.filename ?? "file"}`);
			}
		}
		const body = notes.length > 0 ? [m.content ?? "", ...notes].filter(Boolean).join("\n") : (m.content ?? "");
		await this.#onMessage?.(this.kind, from, body, images.length > 0 ? images : undefined, {
			messageId: m.id,
		});
	}

	async stop(): Promise<void> {
		// Marked before close() so onclose does not schedule a reconnect.
		this.#stopped = true;
		if (this.#reconnectTimer) {
			clearTimeout(this.#reconnectTimer);
			this.#reconnectTimer = null;
		}
		for (const timer of this.#typingTimers.values()) clearInterval(timer);
		this.#typingTimers.clear();
		this.#stopHeartbeat();
		this.#socket?.close();
		this.#socket = null;
		this.#sessionId = "";
		this.#resumeUrl = "";
		this.#lastSeq = null;
		this.#state = "off";
		this.#detail = undefined;
	}

	status(): ChannelStatus {
		return {
			kind: this.kind,
			state: this.#state,
			detail: this.#detail,
			config: { token: this.#token ? `••••${this.#token.slice(-4)}` : "" },
		};
	}

	async send(payload: ChannelSendPayload): Promise<void> {
		if (this.#state !== "connected") throw new Error("discord channel not connected");
		const to = payload.to;
		if (!to) throw new Error("discord send needs a target channel id");
		const url = `${DiscordChannel.REST}/channels/${to}/messages`;
		// Chunked, not truncated — an attachment used to drag the text back
		// into a silent slice() (Discord caps a message at 2000 chars).
		const chunks = chunkText(payload.text, DiscordChannel.TEXT_CHUNK);
		const images = payload.images ?? [];
		const files = payload.files ?? [];
		if (images.length > 0 || files.length > 0) {
			const form = new FormData();
			form.append("content", chunks[0] ?? "");
			// Indices must stay contiguous across both attachment kinds.
			for (const [idx, img] of images.entries()) {
				const ext = img.mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
				form.append(
					`files[${idx}]`,
					new Blob([Buffer.from(img.data, "base64")], { type: img.mimeType }),
					`musepi-${Date.now()}-${idx}.${ext}`,
				);
			}
			for (const [idx, file] of files.entries()) {
				form.append(
					`files[${images.length + idx}]`,
					new Blob([Buffer.from(file.data, "base64")], { type: file.mimeType }),
					file.name,
				);
			}
			await this.#postMessage(url, form);
			for (const chunk of chunks.slice(1)) {
				await this.#postMessage(url, JSON.stringify({ content: chunk }), "application/json");
			}
			return;
		}
		for (const chunk of chunks) {
			await this.#postMessage(url, JSON.stringify({ content: chunk }), "application/json");
		}
	}

	async #postMessage(url: string, body: string | FormData, contentType?: string): Promise<void> {
		const headers: Record<string, string> = { Authorization: `Bot ${this.#token}` };
		if (contentType) headers["Content-Type"] = contentType;
		const res = await fetch(url, { method: "POST", headers, body });
		if (!res.ok)
			throw new Error(`discord send failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`);
	}

	/** Native typing indicator (Discord REST typing endpoint). The client shows
	 *  it for 10s, so an active agent turn re-arms it on a heartbeat. */
	async startTyping(to: string): Promise<void> {
		if (this.#state !== "connected" || this.#typingTimers.has(to)) return;
		try {
			await this.#sendTyping(to);
			const timer = setInterval(() => void this.#sendTyping(to).catch(() => {}), DiscordChannel.TYPING_REFRESH_MS);
			timer.unref?.();
			this.#typingTimers.set(to, timer);
		} catch {
			// Typing is cosmetics — never block the reply path.
		}
	}

	async stopTyping(to: string): Promise<void> {
		const timer = this.#typingTimers.get(to);
		if (timer) {
			clearInterval(timer);
			this.#typingTimers.delete(to);
		}
	}

	async #sendTyping(to: string): Promise<void> {
		const res = await fetch(`${DiscordChannel.REST}/channels/${to}/typing`, {
			method: "POST",
			headers: { Authorization: `Bot ${this.#token}` },
		});
		if (!res.ok) throw new Error(`discord typing failed: ${res.status}`);
	}

	/** Registry wiring: attach the incoming-message router. */
	attach(host: ChannelHost): void {
		this.#onMessage = (kind, from, text, images, meta) => host.handleIncoming(kind, from, text, images, meta);
	}

	log(message: string): void {
		logger.info(message);
	}
}
