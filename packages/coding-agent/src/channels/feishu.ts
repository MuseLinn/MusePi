import { AppType, Client, EventDispatcher, WSClient } from "@larksuiteoapi/node-sdk";
import { logger } from "@musepi/pi-utils";
import { chunkText } from "./chunk";
import type { ChannelAdapter, ChannelHost, ChannelInboundSink, ChannelSendPayload, ChannelStatus } from "./types";

/** Feishu / Lark bot channel — official @larksuiteoapi/node-sdk:
 *  WebSocket long-connection receive (im.message.receive_v1) + REST send
 *  (im.v1.message.create, images via im/v1/images upload). One adapter for
 *  both domains: feishu (open.feishu.cn) and international Lark
 *  (open.larksuite.com) differ only in the configured domain.
 *
 *  Enable: create a Feishu/Lark self-built app, copy App ID + App Secret,
 *  enable the bot capability, grant im:message permissions and subscribe to
 *  the message.receive_v1 event. */
export class FeishuChannel implements ChannelAdapter {
	readonly kind: "feishu" | "lark";
	#config: { appId: string; appSecret: string; domain: string } = {
		appId: "",
		appSecret: "",
		domain: "https://open.feishu.cn",
	};
	#state: ChannelStatus["state"] = "off";
	#detail: string | undefined;
	#client: Client | null = null;
	#ws: WSClient | null = null;
	#onMessage: ChannelInboundSink | null = null;

	constructor(kind: "feishu" | "lark" = "feishu") {
		this.kind = kind;
	}

	static readonly DOMAINS: Record<"feishu" | "lark", string> = {
		feishu: "https://open.feishu.cn",
		lark: "https://open.larksuite.com",
	};
	static readonly TEXT_CHUNK = 4000;
	/** Feishu throttles a bot around 5 msg/s — keep chunks above that line. */
	static readonly SEND_INTERVAL_MS = 220;
	/** 飞书 bot 无「正在输入」开放接口（仅客户端内建状态），故不实现 typing。 */
	static readonly SUPPORTS_TYPING = false;
	/** Last incoming message id per chat — replies quote it (thread reply). */
	#lastMessageIds = new Map<string, string>();

	async configure(config: Record<string, unknown>): Promise<void> {
		this.#config = {
			appId: typeof config.appId === "string" ? config.appId : "",
			appSecret: typeof config.appSecret === "string" ? config.appSecret : "",
			domain: typeof config.domain === "string" && config.domain ? config.domain : FeishuChannel.DOMAINS[this.kind],
		};
	}

	async start(): Promise<void> {
		if (!this.#config.appId || !this.#config.appSecret) {
			this.#state = "error";
			this.#detail = "missing appId/appSecret — configure the channel first";
			throw new Error(this.#detail);
		}
		this.#state = "connecting";
		this.#detail = "connecting…";
		try {
			this.#client = new Client({
				appId: this.#config.appId,
				appSecret: this.#config.appSecret,
				appType: AppType.SelfBuild,
				domain: this.#config.domain,
			});
			const dispatcher = new EventDispatcher({}).register({
				"im.message.receive_v1": data => {
					void this.#handleEvent(data).catch(() => {});
				},
			});
			this.#ws = new WSClient({
				appId: this.#config.appId,
				appSecret: this.#config.appSecret,
				domain: this.#config.domain,
			});
			await this.#ws.start({ eventDispatcher: dispatcher });
			this.#state = "connected";
			this.#detail = "connected";
		} catch (err) {
			this.#state = "error";
			this.#detail = err instanceof Error ? err.message : String(err);
			throw err;
		}
	}

	async #handleEvent(data: {
		message?: {
			message_id?: string;
			chat_id?: string;
			message_type?: string;
			content?: string;
		};
		sender?: { sender_id?: { open_id?: string }; sender_type?: string };
	}): Promise<void> {
		if (!data.message) return;
		const chatId = data.message.chat_id ?? "unknown";
		// Remember the source message so answers land as quotes under it
		// (群聊里否则看不出这条回复是在答谁)。
		if (data.message.message_id) this.#lastMessageIds.set(chatId, data.message.message_id);
		const contentType = data.message.message_type ?? "text";
		const images: { data: string; mimeType: string }[] = [];
		let text = "";
		try {
			const content = JSON.parse(data.message.content ?? "{}") as Record<string, string>;
			if (contentType === "text") {
				text = content.text ?? "";
			} else if (contentType === "image") {
				const imageKey = content.image_key;
				if (imageKey && this.#client) {
					const bytes = await this.#downloadImage(imageKey);
					if (bytes) images.push({ data: bytes, mimeType: "image/png" });
				}
			} else if (contentType === "file") {
				const name = content.file_name ?? "file";
				text = `📎 ${name}`;
			} else {
				text = `[${contentType} message]`;
			}
		} catch {
			text = data.message?.content ?? "";
		}
		if (!text.trim() && images.length === 0) return;
		await this.#onMessage?.(this.kind, chatId, text, images.length > 0 ? images : undefined, {
			messageId: data.message.message_id,
		});
	}

	async #downloadImage(imageKey: string): Promise<string | null> {
		try {
			const res = await fetch(`${this.#config.domain}/open-apis/im/v1/images/${imageKey}`, {
				headers: await this.#authHeaders(),
			});
			if (!res.ok) return null;
			const bytes = Buffer.from(await res.arrayBuffer());
			if (bytes.length > 20 * 1024 * 1024) return null;
			return bytes.toString("base64");
		} catch {
			return null;
		}
	}

	async #authHeaders(): Promise<Record<string, string>> {
		const tokenResp = await fetch(`${this.#config.domain}/open-apis/auth/v3/tenant_access_token/internal`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ app_id: this.#config.appId, app_secret: this.#config.appSecret }),
		});
		const data = (await tokenResp.json()) as { tenant_access_token?: string };
		return { Authorization: `Bearer ${data.tenant_access_token ?? ""}` };
	}

	async stop(): Promise<void> {
		this.#ws?.close();
		this.#ws = null;
		this.#client = null;
		this.#state = "off";
		this.#detail = undefined;
	}

	status(): ChannelStatus {
		return {
			kind: this.kind,
			state: this.#state,
			detail: this.#detail,
			config: {
				appId: this.#config.appId,
				appSecret: this.#config.appSecret ? `••••${this.#config.appSecret.slice(-4)}` : "",
				domain: this.#config.domain,
			},
		};
	}

	async send(payload: ChannelSendPayload): Promise<void> {
		if (this.#state !== "connected" || !this.#client) throw new Error(`${this.kind} channel not connected`);
		const to = payload.to;
		if (!to) throw new Error(`${this.kind} send needs a target chat id`);
		if (payload.images && payload.images.length > 0) {
			const imageKey = await this.#uploadImage(Buffer.from(payload.images[0].data, "base64"));
			await this.#client.im.message.create({
				params: { receive_id_type: "chat_id" },
				data: {
					receive_id: to,
					msg_type: "image",
					content: JSON.stringify({ image_key: imageKey }),
				},
			});
			if (payload.text.trim()) await this.#sendText(to, payload.text, payload.replyTo);
			return;
		}
		if (payload.files && payload.files.length > 0) {
			const fileKey = await this.#uploadFile(Buffer.from(payload.files[0].data, "base64"), payload.files[0].name);
			await this.#client.im.message.create({
				params: { receive_id_type: "chat_id" },
				data: {
					receive_id: to,
					msg_type: "file",
					content: JSON.stringify({ file_key: fileKey }),
				},
			});
			if (payload.text.trim()) await this.#sendText(to, payload.text, payload.replyTo);
			return;
		}
		await this.#sendText(to, payload.text, payload.replyTo);
	}

	async #sendText(to: string, text: string, replyTo?: string): Promise<void> {
		if (!this.#client) return;
		// Chunked, not truncated — slice() silently dropped the tail of long
		// agent replies (the 4000-char cap stays conservative until card
		// messages land).
		const chunks = chunkText(text, FeishuChannel.TEXT_CHUNK);
		const parentId = replyTo ?? this.#lastMessageIds.get(to);
		let threadHead: string | undefined;
		let failures = 0;
		for (const [idx, chunk] of chunks.entries()) {
			// 首片落在触发它的那条消息下（群聊看得出在答谁），后续片挂到自己发
			// 的首条 —— 整段回复成为一条线程，而不是一串散落的平发。
			const target = idx === 0 ? parentId : threadHead;
			let sentId: string | undefined;
			if (target) {
				try {
					sentId = await this.#replyMessage(target, chunk);
				} catch {
					// 原消息被撤回/过期/无权限 → 平发
				}
			}
			if (!sentId) {
				try {
					sentId = await this.#createMessage(to, chunk);
				} catch (err) {
					failures++;
					logger.warn(`${this.kind} send failed`, {
						error: err instanceof Error ? err.message : String(err),
					});
				}
			}
			threadHead ??= sentId;
			// 群机器人限 5 QPS —— 分片连发会被 230098 拒掉，后面几片直接丢。
			if (idx < chunks.length - 1) await this.#throttle();
		}
		this.#lastMessageIds.delete(to);
		if (failures === chunks.length && chunks.length > 0) {
			throw new Error(`${this.kind} send failed: all ${chunks.length} chunks rejected`);
		}
	}

	async #replyMessage(messageId: string, text: string): Promise<string | undefined> {
		const client = this.#client;
		if (!client) return undefined;
		const res = await client.im.message.reply({
			path: { message_id: messageId },
			data: { msg_type: "text", content: JSON.stringify({ text }) },
		});
		return this.#messageIdOf(res);
	}

	async #createMessage(to: string, text: string): Promise<string | undefined> {
		const client = this.#client;
		if (!client) return undefined;
		const res = await client.im.message.create({
			params: { receive_id_type: "chat_id" },
			data: { receive_id: to, msg_type: "text", content: JSON.stringify({ text }) },
		});
		return this.#messageIdOf(res);
	}

	/** The SDK types omit message_id on these responses, but it is what lets
	 *  later chunks hang off the first one as a thread. */
	#messageIdOf(res: unknown): string | undefined {
		const data = (res as { data?: { message_id?: string } } | undefined)?.data;
		const id = typeof data?.message_id === "string" ? data.message_id : "";
		return id || undefined;
	}

	/** Feishu caps a bot at ~5 messages/second; chunk bursts trip 230098. */
	async #throttle(): Promise<void> {
		await new Promise(resolve => setTimeout(resolve, FeishuChannel.SEND_INTERVAL_MS));
	}

	async #uploadImage(bytes: Buffer): Promise<string> {
		const form = new FormData();
		form.append("image_type", "message");
		form.append("image", new Blob([bytes.buffer as ArrayBuffer], { type: "image/png" }), "image.png");
		const res = await fetch(`${this.#config.domain}/open-apis/im/v1/images`, {
			method: "POST",
			headers: await this.#authHeaders(),
			body: form,
		});
		const data = (await res.json()) as { code?: number; data?: { image_key?: string } };
		if (!res.ok || data.code !== 0 || !data.data?.image_key) {
			throw new Error(`${this.kind} image upload failed: ${res.status}`);
		}
		return data.data.image_key;
	}

	async #uploadFile(bytes: Buffer, name: string): Promise<string> {
		const form = new FormData();
		form.append("file_type", "stream");
		form.append("file_name", name);
		form.append("file", new Blob([bytes]), name);
		const res = await fetch(`${this.#config.domain}/open-apis/im/v1/files`, {
			method: "POST",
			headers: await this.#authHeaders(),
			body: form,
		});
		const data = (await res.json()) as { code?: number; data?: { file_key?: string } };
		if (!res.ok || data.code !== 0 || !data.data?.file_key) {
			throw new Error(`${this.kind} file upload failed: ${res.status}`);
		}
		return data.data.file_key;
	}

	/** Registry wiring: incoming messages → command handler. */
	attach(host: ChannelHost): void {
		this.#onMessage = (kind, from, text, images, meta) => host.handleIncoming(kind, from, text, images, meta);
	}

	log(message: string): void {
		logger.info(message);
	}
}
