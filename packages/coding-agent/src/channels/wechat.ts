import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { logger } from "@musepi/pi-utils";
import type { ChannelAdapter, ChannelHost, ChannelSendPayload, ChannelStatus } from "./types";

/** iLink incoming message (OpenClaw protocol): item_list carries text
 *  (type 1), image (type 2) and file (type 4) items. */
interface WechatIncomingMsg {
	from_user_id?: string;
	context_token?: string;
	item_list?: {
		type: number;
		text_item?: { text?: string };
		image_item?: {
			url?: string;
			aeskey?: string;
			media?: { encrypt_query_param?: string; aes_key?: string; full_url?: string };
		};
		file_item?: { file_name?: string; media?: { encrypt_query_param?: string; aes_key?: string; full_url?: string } };
	}[];
}

/** Parse an iLink aes key to 16 raw bytes (OpenClaw SDK semantics): try
 *  base64→16B, base64→hex→16B, hex→16B. */
function parseAesKey(raw: string): Buffer {
	const candidates = [
		Buffer.from(raw, "base64"),
		Buffer.from(Buffer.from(raw, "base64").toString("hex"), "hex"),
		Buffer.from(raw, "hex"),
	];
	for (const c of candidates) {
		if (c.length === 16) return c;
	}
	throw new Error(`aes_key parse failed (${raw.length} chars)`);
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Sniff PNG/JPEG/GIF/WebP from magic bytes (no mime lib needed). */
function sniffImageType(buf: Buffer): string {
	if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
	if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
	if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
	if (buf.length >= 12 && buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") {
		return "image/webp";
	}
	return "image/png";
}

/** WeChat iLink bot adapter (OpenClaw-compatible protocol, same endpoints as
 *  the Proma/OpenClaw wechat bridges). QR login → poll status → long-poll
 *  getupdates → sendmessage. No Electron dependency: the QR URL is exposed in
 *  status().config for the GUI to render.
 *
 *  Flow: start() fetches a QR code (waiting_scan); the daemon polls
 *  qrcode_status until the user scans with WeChat, then receives
 *  bot_token/ilink_bot_id credentials and enters the message loop. */
export class WechatChannel implements ChannelAdapter {
	readonly kind = "wechat" as const;
	static readonly BASE_URL = "https://ilinkai.weixin.qq.com";
	static readonly QR_CODE_URL = `${WechatChannel.BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`;
	static readonly ALLOWED_CDN_HOSTS = [".weixin.qq.com"];
	static readonly UPLOAD_IMAGE = 1;
	static readonly UPLOAD_FILE = 3;

	#state: ChannelStatus["state"] = "off";
	#detail: string | undefined;
	#qrCode = "";
	#qrUrl = "";
	#botToken = "";
	#botId = "";
	#uin = "";
	#updatesBuf = "";
	#pollTimer: ReturnType<typeof setInterval> | null = null;
	#loopTimer: ReturnType<typeof setTimeout> | null = null;
	#stopped = false;
	/** context_token per sender (required to reply/media-send to them). */
	#contextTokens = new Map<string, string>();
	#onMessage:
		| ((kind: string, from: string, text: string, images?: { data: string; mimeType: string }[]) => Promise<void>)
		| null = null;

	async configure(config: Record<string, unknown>): Promise<void> {
		// Token can be pre-supplied (reuse across restarts); empty = QR login.
		if (typeof config.token === "string" && config.token) this.#botToken = config.token;
	}

	async start(): Promise<void> {
		this.#stopped = false;
		if (!this.#botToken) {
			this.#state = "connecting";
			this.#detail = "fetching QR code…";
			await this.#fetchQr();
			this.#state = "waiting_scan";
			this.#detail = "scan the QR with WeChat";
			this.#pollTimer = setInterval(
				() =>
					void this.#pollQrStatus().catch(err => {
						logger.warn("wechat qr poll failed", { error: err instanceof Error ? err.message : String(err) });
					}),
				3000,
			);
			this.#pollTimer.unref?.();
			return;
		}
		this.#state = "connected";
		this.#detail = "connected";
		this.#startMessageLoop();
	}

	async #fetchQr(): Promise<void> {
		const res = await fetch(WechatChannel.QR_CODE_URL);
		if (!res.ok) throw new Error(`wechat QR fetch failed: HTTP ${res.status}`);
		const data = (await res.json()) as { qrcode?: string; qrcode_img_content?: string };
		if (!data.qrcode || !data.qrcode_img_content) throw new Error("wechat QR response missing fields");
		this.#qrCode = data.qrcode;
		this.#qrUrl = data.qrcode_img_content;
	}

	async #pollQrStatus(): Promise<void> {
		const res = await fetch(
			`${WechatChannel.BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(this.#qrCode)}`,
		);
		if (!res.ok) throw new Error(`wechat QR status failed: HTTP ${res.status}`);
		const data = (await res.json()) as {
			status?: string;
			bot_token?: string;
			ilink_bot_id?: string;
			ilink_user_id?: string;
		};
		// Scanned-and-confirmed carries the credentials.
		if (data.bot_token && data.ilink_bot_id) {
			this.#botToken = data.bot_token;
			this.#botId = data.ilink_bot_id;
			if (this.#pollTimer) {
				clearInterval(this.#pollTimer);
				this.#pollTimer = null;
			}
			this.#state = "connected";
			this.#detail = "connected";
			this.#startMessageLoop();
		}
	}

	#startMessageLoop(): void {
		const tick = async (): Promise<void> => {
			if (this.#stopped) return;
			try {
				await this.#getUpdates();
			} catch (err) {
				logger.warn("wechat getupdates failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
			if (!this.#stopped) this.#loopTimer = setTimeout(() => void tick(), 200);
		};
		void tick();
	}

	async #post(path: string, body: unknown): Promise<unknown> {
		const res = await fetch(`${WechatChannel.BASE_URL}${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				AuthorizationType: "ilink_bot_token",
				Authorization: `Bearer ${this.#botToken}`,
				"X-WECHAT-UIN": this.#uin,
			},
			body: JSON.stringify(body),
		});
		if (!res.ok) throw new Error(`wechat ${path} failed: HTTP ${res.status}`);
		return (await res.json()) as unknown;
	}

	async #getUpdates(): Promise<void> {
		const data = (await this.#post("/ilink/bot/getupdates", {
			get_updates_buf: this.#updatesBuf,
			base_info: { channel_version: "1.0.0" },
		})) as {
			buf?: string;
			messages?: WechatIncomingMsg[];
			data?: { buf?: string; messages?: WechatIncomingMsg[] };
		};
		const body = data.data ?? data;
		if (typeof body.buf === "string") this.#updatesBuf = body.buf;
		for (const m of body.messages ?? []) {
			if (!m.from_user_id) continue;
			if (typeof m.context_token === "string" && m.context_token) {
				this.#contextTokens.set(m.from_user_id, m.context_token);
			}
			const items = m.item_list ?? [];
			const text = items
				.filter(i => i.type === 1 && i.text_item?.text)
				.map(i => i.text_item!.text)
				.join("");
			const images = await this.#downloadImages(items);
			// Files are not representable in session content parts — surface
			// their metadata as text so the user sees what arrived.
			const fileNotes = items
				.filter(i => i.type === 4 && i.file_item?.file_name)
				.map(i => `📎 ${i.file_item!.file_name}`);
			const finalText =
				fileNotes.length > 0 ? (text ? `${text}\n${fileNotes.join("\n")}` : fileNotes.join("\n")) : text;
			if (!finalText.trim() && images.length === 0) continue;
			void this.#onMessage?.(this.kind, m.from_user_id, finalText, images).catch(() => {});
		}
	}

	/** Download + decrypt iLink image items (OpenClaw protocol): plain CDN
	 *  URL when present, else AES-128-ECB-decrypted bytes via
	 *  novac2c.cdn.weixin.qq.com with the item's aes key. */
	async #downloadImages(items: WechatIncomingMsg["item_list"]): Promise<{ data: string; mimeType: string }[]> {
		const out: { data: string; mimeType: string }[] = [];
		for (const item of items ?? []) {
			if (item.type !== 2 || !item.image_item) continue;
			const img = item.image_item;
			try {
				const buf = await this.#downloadImageBytes(img);
				if (buf.length > MAX_IMAGE_BYTES) continue;
				const mimeType = sniffImageType(buf);
				out.push({ data: buf.toString("base64"), mimeType });
			} catch (err) {
				logger.warn("wechat image download failed", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		return out;
	}

	async #downloadImageBytes(img: {
		url?: string;
		aeskey?: string;
		media?: { encrypt_query_param?: string; aes_key?: string; full_url?: string };
	}): Promise<Buffer> {
		if (img.url) {
			if (!WechatChannel.ALLOWED_CDN_HOSTS.some(h => img.url!.includes(h))) {
				throw new Error(`image url host not allowed: ${img.url}`);
			}
			const res = await fetch(img.url);
			if (!res.ok) throw new Error(`image fetch failed: HTTP ${res.status}`);
			return Buffer.from(await res.arrayBuffer());
		}
		if (!img.media?.encrypt_query_param && !img.media?.full_url) {
			throw new Error("image_item has neither url nor media");
		}
		const cdnBase = "https://novac2c.cdn.weixin.qq.com/c2c";
		const url =
			img.media.full_url ??
			`${cdnBase}/download?encrypted_query_param=${encodeURIComponent(img.media.encrypt_query_param!)}`;
		const res = await fetch(url);
		if (!res.ok) throw new Error(`cdn fetch failed: HTTP ${res.status}`);
		const encrypted = Buffer.from(await res.arrayBuffer());
		const aesKeyRaw = img.aeskey ?? img.media.aes_key;
		if (!aesKeyRaw) throw new Error("image has no aes key");
		const key = parseAesKey(aesKeyRaw);
		const decipher = createDecipheriv("aes-128-ecb", key, null);
		return Buffer.concat([decipher.update(encrypted), decipher.final()]);
	}

	async send(payload: ChannelSendPayload): Promise<void> {
		if (this.#state !== "connected") throw new Error("wechat channel not connected");
		const to = payload.to;
		if (!to) throw new Error("wechat send needs a target user id");
		const contextToken = this.#contextTokens.get(to);
		const mediaItems: {
			type: number;
			image_item?: {
				media: { encrypt_query_param: string; aes_key: string; encrypt_type: number };
				mid_size: number;
			};
			file_item?: {
				media: { encrypt_query_param: string; aes_key: string; encrypt_type: number };
				file_name: string;
				len: string;
			};
		}[] = [];
		for (const img of payload.images ?? []) {
			const uploaded = await this.#uploadMedia(to, WechatChannel.UPLOAD_IMAGE, Buffer.from(img.data, "base64"));
			mediaItems.push({
				type: 2, // IMAGE
				image_item: {
					media: {
						encrypt_query_param: uploaded.encryptQueryParam,
						aes_key: uploaded.aesKeyBase64,
						encrypt_type: 1,
					},
					mid_size: uploaded.cipherSize,
				},
			});
		}
		for (const file of payload.files ?? []) {
			const uploaded = await this.#uploadMedia(to, WechatChannel.UPLOAD_FILE, Buffer.from(file.data, "base64"));
			mediaItems.push({
				type: 4, // FILE
				file_item: {
					media: {
						encrypt_query_param: uploaded.encryptQueryParam,
						aes_key: uploaded.aesKeyBase64,
						encrypt_type: 1,
					},
					file_name: file.name,
					len: String(uploaded.rawSize),
				},
			});
		}
		// Text + each media item as its own downstream message (OpenClaw
		// sendMediaItems semantics: one item per request).
		if (payload.text.trim() || mediaItems.length === 0) {
			await this.#sendItems(to, contextToken, [{ type: 1, text_item: { text: payload.text.slice(0, 2000) } }]);
		}
		for (const item of mediaItems) {
			await this.#sendItems(to, contextToken, [item]);
		}
	}

	/** getUploadUrl → AES-128-ECB encrypt → POST CDN → download param. */
	async #uploadMedia(
		to: string,
		mediaType: number,
		plaintext: Buffer,
	): Promise<{ encryptQueryParam: string; aesKeyBase64: string; rawSize: number; cipherSize: number }> {
		const rawsize = plaintext.length;
		const rawfilemd5 = createHash("md5").update(plaintext).digest("hex");
		const cipherSize = Math.ceil(rawsize / 16) * 16; // AES-ECB PKCS7 padded size
		const filekey = randomBytes(16).toString("hex");
		const aeskey = randomBytes(16);
		const urlResp = (await this.#post("/ilink/bot/getuploadurl", {
			filekey,
			media_type: mediaType,
			to_user_id: to,
			rawsize,
			rawfilemd5,
			filesize: cipherSize,
			no_need_thumb: true,
			aeskey: aeskey.toString("hex"),
		})) as { upload_full_url?: string; upload_param?: string };
		const uploadUrl = urlResp.upload_full_url?.trim() || urlResp.upload_param;
		if (!uploadUrl) throw new Error("wechat getuploadurl returned no upload URL");
		const cipher = createCipheriv("aes-128-ecb", aeskey, null);
		const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		const res = await fetch(uploadUrl, {
			method: "POST",
			headers: { "Content-Type": "application/octet-stream" },
			body: new Uint8Array(encrypted),
		});
		if (!res.ok) throw new Error(`wechat CDN upload failed: HTTP ${res.status}`);
		const encryptQueryParam = res.headers.get("x-encrypted-param");
		if (!encryptQueryParam) throw new Error("wechat CDN upload missing x-encrypted-param");
		return { encryptQueryParam, aesKeyBase64: aeskey.toString("base64"), rawSize: rawsize, cipherSize };
	}

	async #sendItems(to: string, contextToken: string | undefined, items: unknown[]): Promise<void> {
		await this.#post("/ilink/bot/sendmessage", {
			msg: {
				from_user_id: this.#botId,
				to_user_id: to,
				client_id: randomBytes(8).toString("hex"),
				message_type: 2, // BOT
				message_state: 2, // FINISH
				item_list: items,
				...(contextToken ? { context_token: contextToken } : {}),
			},
		});
	}

	status(): ChannelStatus {
		return {
			kind: this.kind,
			state: this.#state,
			detail: this.#detail,
			config: {
				token: this.#botToken ? "••••" + this.#botToken.slice(-4) : "",
				qrUrl: this.#qrUrl || undefined,
				qrCode: this.#qrCode || undefined,
			},
		};
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		if (this.#pollTimer) {
			clearInterval(this.#pollTimer);
			this.#pollTimer = null;
		}
		if (this.#loopTimer) {
			clearTimeout(this.#loopTimer);
			this.#loopTimer = null;
		}
		this.#state = "off";
		this.#detail = undefined;
	}

	/** Registry wiring: incoming messages → command handler. */
	attach(host: ChannelHost): void {
		this.#onMessage = (kind, from, text) => host.handleIncoming(kind, from, text);
	}
}
