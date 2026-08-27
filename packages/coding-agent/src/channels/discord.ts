import { logger } from "@musepi/pi-utils";
import type { ChannelAdapter, ChannelHost, ChannelSendPayload, ChannelStatus } from "./types";

interface DiscordMessage {
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
	/** Injected by the registry at construction: (kind, from, text, images). */
	#onMessage:
		| ((kind: string, from: string, text: string, images?: { data: string; mimeType: string }[]) => Promise<void>)
		| null = null;

	static readonly GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
	static readonly INTENTS = (1 << 9) | (1 << 12); // GUILD_MESSAGES | DIRECT_MESSAGES

	async configure(config: Record<string, unknown>): Promise<void> {
		this.#token = typeof config.token === "string" ? config.token : "";
	}

	async start(): Promise<void> {
		if (!this.#token) {
			this.#state = "error";
			this.#detail = "missing bot token — configure the channel first";
			throw new Error(this.#detail);
		}
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

	#connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(DiscordChannel.GATEWAY_URL);
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
					// Hello — start heartbeat, then IDENTIFY.
					const hello = msg.d as { heartbeat_interval?: number };
					this.#heartbeatTimer?.unref?.();
					if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
					this.#heartbeatTimer = setInterval(
						() => {
							this.#sendOp(1, this.#lastSeq);
						},
						(hello.heartbeat_interval ?? 41250) * 0.9,
					);
					this.#heartbeatTimer.unref?.();
					this.#sendOp(2, {
						token: this.#token,
						intents: DiscordChannel.INTENTS,
						properties: { os: "linux", browser: "musepi", device: "musepi" },
					});
					return;
				}
				if (msg.op === 0 && msg.t === "READY") {
					this.#selfId = (msg.d as { user?: { id?: string } }).user?.id ?? "";
					this.#state = "connected";
					this.#detail = "connected";
					handshake = true;
					resolve();
					return;
				}
				if (msg.op === 0 && msg.t === "MESSAGE_CREATE") {
					void this.#handleMessage(msg.d as DiscordMessage).catch(() => {});
				}
				if (msg.op === 11) {
					// HEARTBEAT_ACK — nothing to do.
					return;
				}
			};
			ws.onerror = () => {
				if (!handshake) reject(new Error("gateway connection failed"));
			};
			ws.onclose = () => {
				this.#state = "off";
				this.#detail = "disconnected";
				this.#socket = null;
			};
		});
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
		for (const a of m.attachments ?? []) {
			if (!a.url || !a.content_type?.startsWith("image/")) continue;
			try {
				const res = await fetch(a.url);
				if (!res.ok) continue;
				const bytes = Buffer.from(await res.arrayBuffer());
				if (bytes.length > 20 * 1024 * 1024) continue;
				images.push({ data: bytes.toString("base64"), mimeType: a.content_type });
			} catch {
				// skip unreadable attachment
			}
		}
		await this.#onMessage?.(this.kind, from, m.content ?? "", images.length > 0 ? images : undefined);
	}

	async stop(): Promise<void> {
		if (this.#heartbeatTimer) {
			clearInterval(this.#heartbeatTimer);
			this.#heartbeatTimer = null;
		}
		this.#socket?.close();
		this.#socket = null;
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
		const url = `https://discord.com/api/v10/channels/${to}/messages`;
		const headers: Record<string, string> = { Authorization: `Bot ${this.#token}` };
		let body: string | FormData;
		if (payload.images && payload.images.length > 0) {
			const form = new FormData();
			form.append("content", payload.text.slice(0, 2000));
			for (const [idx, img] of payload.images.entries()) {
				const ext = img.mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
				form.append(
					`files[${idx}]`,
					new Blob([Buffer.from(img.data, "base64")], { type: img.mimeType }),
					`musepi-${Date.now()}-${idx}.${ext}`,
				);
			}
			body = form;
		} else if (payload.files && payload.files.length > 0) {
			const form = new FormData();
			form.append("content", payload.text.slice(0, 2000));
			for (const [idx, file] of payload.files.entries()) {
				form.append(
					`files[${idx}]`,
					new Blob([Buffer.from(file.data, "base64")], { type: file.mimeType }),
					file.name,
				);
			}
			body = form;
		} else {
			headers["Content-Type"] = "application/json";
			body = JSON.stringify({ content: payload.text.slice(0, 2000) });
		}
		const res = await fetch(url, { method: "POST", headers, body });
		if (!res.ok) {
			const errBody = await res.text().catch(() => "");
			throw new Error(`discord send failed: ${res.status} ${errBody.slice(0, 160)}`);
		}
	}

	/** Registry wiring: attach the incoming-message router. */
	attach(host: ChannelHost): void {
		this.#onMessage = (kind, from, text) => host.handleIncoming(kind, from, text);
	}

	log(message: string): void {
		logger.info(message);
	}
}
