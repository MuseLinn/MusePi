import { logger } from "@musepi/pi-utils";
import { chunkText } from "./chunk";
import type { ChannelAdapter, ChannelHost, ChannelSendPayload, ChannelStatus } from "./types";

/** Escape the three characters Telegram's HTML parse mode treats as markup. */
function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Render an agent reply's markdown-ish body to Telegram HTML (fenced code,
 *  inline code, bold, italic, links). HTML is the safe parse mode: only
 *  & < > are structural, so a stray < in a tool output cannot break a send —
 *  and send() still falls back to plain text if the parser rejects it. */
export function toTelegramHtml(text: string): string {
	const fences: string[] = [];
	// 1. Pull fenced blocks out first so inline rules never touch their body.
	let body = text.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_m, code: string) => {
		fences.push(`<pre>${escapeHtml(String(code).replace(/\n$/, ""))}</pre>`);
		return `\u0000FENCE${fences.length - 1}\u0000`;
	});
	body = escapeHtml(body);
	body = body
		.replace(/`([^`\n]+)`/g, "<code>$1</code>")
		.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
		.replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, "$1<i>$2</i>")
		.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
	return body.replace(/\u0000FENCE(\d+)\u0000/g, (_m, i: string) => fences[Number(i)] ?? "");
}

/** Telegram bot adapter — official Bot API over HTTP long-polling
 *  (getUpdates offset-based), zero dependencies. Images/files via
 *  sendPhoto/sendDocument (multipart). Incoming messages route through the
 *  registry's command handler; replies go back to the source chat. */
export class TelegramChannel implements ChannelAdapter {
	readonly kind = "telegram" as const;
	static readonly API = "https://api.telegram.org/bot";
	static readonly TEXT_CHUNK = 4096;
	/** Telegram's typing indicator expires after ~5s. */
	static readonly TYPING_REFRESH_MS = 4_000;
	#token = "";
	/** Per-chat typing heartbeats — cleared in stopTyping()/stop(). */
	#typingTimers = new Map<string, ReturnType<typeof setInterval>>();
	#state: ChannelStatus["state"] = "off";
	#detail: string | undefined;
	#offset = 0;
	#polling = false;
	#stopped = false;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#onMessage:
		| ((kind: string, from: string, text: string, images?: { data: string; mimeType: string }[]) => Promise<void>)
		| null = null;

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
		this.#state = "connected";
		this.#detail = "connected";
		this.#polling = true;
		void this.#pollLoop().catch(err => {
			logger.warn("telegram poll loop failed", { error: err instanceof Error ? err.message : String(err) });
			if (!this.#stopped) {
				this.#state = "error";
				this.#detail = "polling stopped";
			}
		});
	}

	async #pollLoop(): Promise<void> {
		while (this.#polling && !this.#stopped) {
			try {
				const updates = await this.#getUpdates();
				for (const u of updates) await this.#handleUpdate(u);
			} catch (err) {
				logger.warn("telegram getUpdates failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
			if (this.#stopped) break;
			await new Promise(resolve => {
				this.#timer = setTimeout(resolve, 1200);
			});
		}
	}

	async #getUpdates(): Promise<
		{
			update_id: number;
			message?: {
				chat?: { id: number };
				text?: string;
				caption?: string;
				photo?: { file_id: string }[];
				document?: { file_id: string; file_name?: string };
				voice?: { file_id?: string };
				sticker?: { file_id?: string };
				from?: { id: number };
			};
		}[]
	> {
		const res = await fetch(
			`${TelegramChannel.API}${this.#token}/getUpdates?timeout=20&offset=${this.#offset}&limit=20`,
		);
		if (!res.ok) throw new Error(`telegram getUpdates failed: HTTP ${res.status}`);
		const data = (await res.json()) as { ok: boolean; result?: unknown[] };
		return Array.isArray(data.result) ? (data.result as never) : [];
	}

	async #handleUpdate(u: {
		update_id: number;
		message?: {
			chat?: { id: number };
			text?: string;
			caption?: string;
			photo?: { file_id: string }[];
			document?: { file_id: string; file_name?: string };
			voice?: { file_id?: string };
			sticker?: { file_id?: string };
		};
	}): Promise<void> {
		this.#offset = Math.max(this.#offset, u.update_id + 1);
		const msg = u.message;
		if (!msg?.chat) return;
		const chatId = String(msg.chat.id);
		const text = msg.text ?? msg.caption ?? "";
		const images: { data: string; mimeType: string }[] = [];
		const notes: string[] = [];
		if (msg.photo && msg.photo.length > 0) {
			// Largest photo is last in the array.
			const fileId = msg.photo.at(-1)?.file_id;
			if (fileId) {
				const data = await this.#downloadFile(fileId);
				if (data) images.push({ data, mimeType: "image/jpeg" });
			}
		}
		// Documents are not representable as session content parts — surface
		// their name next to a sticker/voice so nothing arrives silently.
		if (msg.document?.file_id) {
			notes.push(`📎 ${msg.document.file_name ?? "file"}`);
		}
		if (msg.voice) notes.push("🎙 语音消息（当前无法转写，请以文字发送）");
		if (msg.sticker) notes.push("[sticker]");
		const finalText = notes.length > 0 ? (text ? `${text}\n${notes.join("\n")}` : notes.join("\n")) : text;
		await this.#onMessage?.(this.kind, chatId, finalText, images.length > 0 ? images : undefined);
	}

	async #downloadFile(fileId: string): Promise<string | null> {
		try {
			const info = (await (
				await fetch(`${TelegramChannel.API}${this.#token}/getFile?file_id=${encodeURIComponent(fileId)}`)
			).json()) as { ok: boolean; result?: { file_path?: string } };
			if (!info.ok || !info.result?.file_path) return null;
			const res = await fetch(`https://api.telegram.org/file/bot${this.#token}/${info.result.file_path}`);
			if (!res.ok) return null;
			const bytes = Buffer.from(await res.arrayBuffer());
			if (bytes.length > 20 * 1024 * 1024) return null;
			return bytes.toString("base64");
		} catch {
			return null;
		}
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		this.#polling = false;
		for (const timer of this.#typingTimers.values()) clearInterval(timer);
		this.#typingTimers.clear();
		if (this.#timer) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
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
		if (this.#state !== "connected") throw new Error("telegram channel not connected");
		const to = payload.to;
		if (!to) throw new Error("telegram send needs a target chat id");
		if (payload.images && payload.images.length > 0) {
			for (const [idx, img] of payload.images.entries()) {
				const form = new FormData();
				form.append("chat_id", to);
				// A caption rides the FIRST photo only (Telegram repeats it on every
				// message of an album otherwise).
				if (idx === 0 && payload.text.trim()) {
					form.append("caption", toTelegramHtml(payload.text.slice(0, 1024)));
					form.append("parse_mode", "HTML");
				}
				form.append("photo", new Blob([Buffer.from(img.data, "base64")], { type: img.mimeType }), "photo.jpg");
				await this.#post("sendPhoto", form);
			}
			return;
		}
		if (payload.files && payload.files.length > 0) {
			for (const file of payload.files) {
				const form = new FormData();
				form.append("chat_id", to);
				form.append("caption", file.name);
				form.append("document", new Blob([Buffer.from(file.data, "base64")], { type: file.mimeType }), file.name);
				await this.#post("sendDocument", form);
			}
			return;
		}
		// Chunked, not truncated — slice() silently dropped the tail of long
		// agent replies (Telegram caps a single message at 4096 chars).
		for (const chunk of chunkText(payload.text, TelegramChannel.TEXT_CHUNK)) {
			const part = new FormData();
			part.append("chat_id", to);
			part.append("text", toTelegramHtml(chunk));
			part.append("parse_mode", "HTML");
			try {
				await this.#post("sendMessage", part);
			} catch {
				// HTML entities can still trip the parser (stray < from a tool
				// output); plain text never fails — retry once without markup.
				const plain = new FormData();
				plain.append("chat_id", to);
				plain.append("text", chunk);
				await this.#post("sendMessage", plain);
			}
		}
	}

	/** Native typing indicator (Telegram sendChatAction). The client shows
	 *  "typing…" for ~5s, so an active agent turn re-arms it on a heartbeat. */
	async startTyping(to: string): Promise<void> {
		if (this.#state !== "connected" || this.#typingTimers.has(to)) return;
		try {
			await this.#sendChatAction(to, "typing");
			const timer = setInterval(
				() => void this.#sendChatAction(to, "typing").catch(() => {}),
				TelegramChannel.TYPING_REFRESH_MS,
			);
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

	async #sendChatAction(to: string, action: string): Promise<void> {
		const form = new FormData();
		form.append("chat_id", to);
		form.append("action", action);
		await this.#post("sendChatAction", form);
	}

	async #post(method: string, body: FormData): Promise<void> {
		const res = await fetch(`${TelegramChannel.API}${this.#token}/${method}`, { method: "POST", body });
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`telegram ${method} failed: ${res.status} ${text.slice(0, 160)}`);
		}
	}

	/** Registry wiring: incoming messages → command handler. */
	attach(host: ChannelHost): void {
		this.#onMessage = (kind, from, text, images) => host.handleIncoming(kind, from, text, images);
	}
}
