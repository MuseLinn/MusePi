/** Bot/notification channels for MusePi daemon (CollabDialog "use bot
 *  channel" + task-completion pushes).
 *
 * Kind-agnostic adapter contract: each channel implements connect/disconnect/
 * send and reports a status. Incoming IM messages flow through
 * ChannelCommandHandler (/help /new /list /stop …), which the daemon wires to
 * its session operations. Huawei today-screen is push-only (task results). */

export type ChannelKind = "wechat" | "discord" | "huawei-today" | "feishu" | "lark" | "telegram";

export interface ChannelStatus {
	kind: ChannelKind;
	state: "off" | "connecting" | "connected" | "waiting_scan" | "error";
	/** Human-readable detail (e.g. "waiting for QR scan", error message). */
	detail?: string;
	/** Config snapshot for the GUI (secrets masked). */
	config: Record<string, unknown>;
}

export interface ChannelAdapter {
	readonly kind: ChannelKind;
	/** Start (idempotent). Resolves once connected; throws on failure. */
	start(): Promise<void>;
	/** Stop (idempotent). */
	stop(): Promise<void>;
	/** Send a text message through the channel (IM) or push a result (today). */
	send(payload: ChannelSendPayload): Promise<void>;
	status(): ChannelStatus;
	/** Update configuration (persisted by the registry) and reconnect. */
	configure(config: Record<string, unknown>): Promise<void>;
	/** Optional: wire the incoming-message router (IM channels). Called once
	 *  when the registry constructs the adapter. */
	attach?(host: ChannelHost): void;
}

export interface ChannelSendPayload {
	/** IM: chat/target id; today-screen: ignored (push to the bound account). */
	to?: string;
	text: string;
	/** Markdown body (today-screen renders it; IM falls back to plain text). */
	markdown?: string;
	/** Task-result semantics for today-screen cards. */
	taskName?: string;
	taskResult?: string;
	/** Image attachments (base64 data) — Discord sends them as message
	 *  attachments; WeChat uploads them to its CDN (AES-128-ECB) and sends
	 *  IMAGE items. */
	images?: { data: string; mimeType: string }[];
	/** File attachments (base64 data) — Discord multipart; WeChat CDN
	 *  FILE items (media_type=3). */
	files?: { name: string; data: string; mimeType: string }[];
}

/** An incoming IM message's image attachments (base64, decoded by the
 *  adapter — WeChat CDN bytes are AES-128-ECB decrypted; Discord downloads
 *  its attachment URLs). */
export interface ChannelIncomingImage {
	data: string;
	mimeType: string;
}

export interface ChannelHost {
	/** Route an incoming IM message: parse /commands, answer, bind chats.
	 *  `kind` identifies the transport so replies route back through it.
	 *  `images` ride along and are forwarded to the bound session. */
	handleIncoming(kind: string, from: string, text: string, images?: ChannelIncomingImage[]): Promise<void>;
}

export interface ChannelRegistryOptions {
	configPath: string;
	host: ChannelHost;
	/** Factory map: kind → adapter (lazily constructed per kind). The
	 *  registry instance is passed for status/host access; the interface
	 *  stays minimal to avoid a circular type import. */
	factories: Partial<Record<ChannelKind, (registry: { host: ChannelHost }) => ChannelAdapter>>;
}
