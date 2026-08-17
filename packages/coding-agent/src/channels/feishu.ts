import { logger } from "@musepi/pi-utils";
import { AppType, Client, EventDispatcher, WSClient, type Logger } from "@larksuiteoapi/node-sdk";
import type { ChannelAdapter, ChannelHost, ChannelSendPayload, ChannelStatus } from "./types";

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
	#config: { appId: string; appSecret: string; domain: string } = { appId: "", appSecret: "", domain: "https://open.feishu.cn" };
	#state: ChannelStatus["state"] = "off";
	#detail: string | undefined;
	#client: Client | null = null;
	#ws: WSClient | null = null;
	#onMessage: ((kind: string, from: string, text: string, images?: { data: string; mimeType: string }[]) => Promise<void>) | null = null;

	constructor(kind: "feishu" | "lark" = "feishu") {
		this.kind = kind;
	}

	static readonly DOMAINS: Record<"feishu" | "lark", string> = {
		feishu: "https://open.feishu.cn",
		lark: "https://open.larksuite.com",
	};

	async configure(config: Record<string, unknown>): Promise<void> {
		this.#config = {
			appId: typeof config.appId === "string" ? config.appId : "",
			appSecret: typeof config.appSecret === "string" ? config.appSecret : "",
			domain:
				typeof config.domain === "string" && config.domain
					? config.domain
					: FeishuChannel.DOMAINS[this.kind],
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
		const from = data.sender?.sender_id?.open_id ?? chatId ?? "unknown";
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
		await this.#onMessage?.(this.kind, chatId, text, images.length > 0 ? images : undefined);
	}

	async #downloadImage(imageKey: string): Promise<string | null> {
		try {
			const res = await fetch(
				`${this.#config.domain}/open-apis/im/v1/images/${imageKey}`,
				{ headers: await this.#authHeaders() },
			);
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
				appSecret: this.#config.appSecret ? "••••" + this.#config.appSecret.slice(-4) : "",
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
			if (payload.text.trim()) await this.#sendText(to, payload.text);
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
			if (payload.text.trim()) await this.#sendText(to, payload.text);
			return;
		}
		await this.#sendText(to, payload.text);
	}

	async #sendText(to: string, text: string): Promise<void> {
		if (!this.#client) return;
		await this.#client.im.message.create({
			params: { receive_id_type: "chat_id" },
			data: { receive_id: to, msg_type: "text", content: JSON.stringify({ text: text.slice(0, 4000) }) },
		});
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
		this.#onMessage = (kind, from, text, images) => host.handleIncoming(kind, from, text, images);
	}

	log(message: string): void {
		logger.info(message);
	}
}
