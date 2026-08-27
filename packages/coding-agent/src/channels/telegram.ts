import { logger } from "@musepi/pi-utils";
import type { ChannelAdapter, ChannelHost, ChannelSendPayload, ChannelStatus } from "./types";

/** Telegram bot adapter — official Bot API over HTTP long-polling
 *  (getUpdates offset-based), zero dependencies. Images/files via
 *  sendPhoto/sendDocument (multipart). Incoming messages route through the
 *  registry's command handler; replies go back to the source chat. */
export class TelegramChannel implements ChannelAdapter {
	readonly kind = "telegram" as const;
	static readonly API = "https://api.telegram.org/bot";
	#token = "";
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
				photo?: { file_id: string }[];
				document?: { file_id: string; file_name?: string };
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
			photo?: { file_id: string }[];
			document?: { file_id: string; file_name?: string };
		};
	}): Promise<void> {
		this.#offset = Math.max(this.#offset, u.update_id + 1);
		const msg = u.message;
		if (!msg?.chat) return;
		const chatId = String(msg.chat.id);
		const text = msg.text ?? "";
		const images: { data: string; mimeType: string }[] = [];
		if (msg.photo && msg.photo.length > 0) {
			// Largest photo is last in the array.
			const fileId = msg.photo.at(-1)?.file_id;
			if (fileId) {
				const data = await this.#downloadFile(fileId);
				if (data) images.push({ data, mimeType: "image/jpeg" });
			}
		}
		await this.#onMessage?.(this.kind, chatId, text, images.length > 0 ? images : undefined);
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
		const form = new FormData();
		if (payload.images && payload.images.length > 0) {
			form.append("chat_id", to);
			if (payload.text.trim()) form.append("caption", payload.text.slice(0, 1024));
			const img = payload.images[0];
			form.append("photo", new Blob([Buffer.from(img.data, "base64")], { type: img.mimeType }), "photo.jpg");
			await this.#post("sendPhoto", form);
			return;
		}
		if (payload.files && payload.files.length > 0) {
			form.append("chat_id", to);
			if (payload.text.trim()) form.append("caption", payload.text.slice(0, 1024));
			const file = payload.files[0];
			form.append("document", new Blob([Buffer.from(file.data, "base64")], { type: file.mimeType }), file.name);
			await this.#post("sendDocument", form);
			return;
		}
		form.append("chat_id", to);
		form.append("text", payload.text.slice(0, 4096));
		await this.#post("sendMessage", form);
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
