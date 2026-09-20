import type { ChannelHost } from "./types";

/** Session operations the daemon injects into the command handler. */
export interface ChannelOps {
	listSessions(): Promise<{ id: string; title: string }[]>;
	/** Start a new session, optionally with an opening prompt. */
	startSession(prompt?: string): Promise<string>;
	stopSession(id: string): Promise<void>;
	currentSessionId(): string | null;
	/** Send a plain prompt to a live session (images = base64 attachments). */
	sendPrompt(sessionId: string, text: string, images?: { data: string; mimeType: string }[]): Promise<void>;
	/** Native "typing…" indicator toward every peer bound to this session
	 *  (no-op for adapters without one). The daemon stops it when the agent
	 *  reply is pushed back (server #pushChannelReplies). */
	startTyping?(sessionId: string): void;
}

/** Serializable chat↔session binding snapshot (daemon persists it to disk so
 *  a plain text message still routes after a daemon restart). */
export interface ChannelBindingSnapshot {
	bindings: Record<string, string>;
}

type Lang = "zh" | "en";
/** Per-channel reply language: WeChat users read Chinese, everything else
 *  keeps the original English surface (same strings the GUI shows). */
function langOf(kind: string): Lang {
	return kind === "wechat" ? "zh" : "en";
}

interface MsgTable {
	help: string;
	noSessionToStop: string;
	noSuchSession(id: string): string;
	usageSwitch: string;
	newBound(short: string, withPrompt: boolean): string;
	bound(short: string): string;
	stopped(short: string): string;
	nowNeedsBinding: string;
	sendFailed(msg: string): string;
	unknown(cmd: string): string;
	untitled: string;
	currentMark: string;
}

const MESSAGES: Record<Lang, MsgTable> = {
	zh: {
		help: "命令一览：\n/new <prompt> — 新建会话\n/list — 会话列表\n/switch <序号|id> — 绑定会话\n/stop [序号|id] — 停止会话\n/now <text> — 向绑定会话发消息\n直接发文本 — 发给绑定的会话（未绑定会自动新建）",
		noSessionToStop: "没有可停止的会话。",
		noSuchSession: (id: string) => `没有会话 ${id}，/list 查看序号。`,
		usageSwitch: "用法：/switch <序号|id>",
		newBound: (short: string, withPrompt: boolean) =>
			withPrompt ? `已新建会话 ${short} 并绑定，正在处理…` : `已新建会话 ${short} 并绑定，直接发文本即可。`,
		bound: (short: string) => `已绑定会话 ${short}`,
		stopped: (short: string) => `已停止会话 ${short}`,
		nowNeedsBinding: "/now <text> — 需要先绑定会话（/switch 或直接发文本）",
		sendFailed: (msg: string) => `发送失败：${msg}`,
		unknown: (cmd: string) => `未知命令 ${cmd}。/help 查看命令。`,
		untitled: "（未命名）",
		currentMark: "▶",
	},
	en: {
		help: "/new <prompt> — new session\n/list — sessions\n/switch <ordinal|id> — bind session\n/stop [ordinal|id] — stop session\n/now <text> — prompt bound session\nplain text — prompt bound session (auto-creates one when unbound)",
		noSessionToStop: "No session to stop.",
		noSuchSession: (id: string) => `No session ${id}. /list to see ordinals.`,
		usageSwitch: "usage: /switch <ordinal|sessionId>",
		newBound: (short: string, withPrompt: boolean) =>
			withPrompt
				? `New session ${short} bound — working on it…`
				: `New session ${short} bound. Send text to prompt it.`,
		bound: (short: string) => `Bound to ${short}`,
		stopped: (short: string) => `Stopped ${short}`,
		nowNeedsBinding: "/now <text> — needs a bound session (/switch or send plain text)",
		sendFailed: (msg: string) => `send failed: ${msg}`,
		unknown: (cmd: string) => `Unknown command ${cmd}. /help`,
		untitled: "(untitled)",
		currentMark: "▶",
	},
};

/** Short display id: full session ids are untypeable on a phone keyboard. */
function shortId(id: string): string {
	return id.length > 8 ? id.slice(0, 8) : id;
}

/** Chat ↔ session command router (Proma bridge-command-handler pattern,
 *  musepi-flavoured: no workspace/model switching — sessions only).
 *
 *  `/help /new [prompt] /list /stop [ordinal|id] /switch <ordinal|id> /now <text>`
 *  Bare text routes to the bound session; unbound text auto-creates and binds
 *  one (Telegram-DM parity: the first message already gets an answer).
 *  Bindings are keyed per channel+sender and persisted via the daemon so they
 *  survive a restart. */
export class ChannelCommandHandler implements ChannelHost {
	readonly #ops: ChannelOps;
	readonly #replyFn: (kind: string, from: string, text: string) => Promise<void>;
	/** `${kind}:${from}` → sessionId (keyed per channel so two transports can
	 *  never collide on the same sender id). */
	readonly #binding = new Map<string, string>();
	readonly #persist?: { load(): ChannelBindingSnapshot; save(snapshot: ChannelBindingSnapshot): void };

	constructor(
		ops: ChannelOps,
		reply: (kind: string, from: string, text: string) => Promise<void>,
		persist?: { load(): ChannelBindingSnapshot; save(snapshot: ChannelBindingSnapshot): void },
	) {
		this.#ops = ops;
		this.#replyFn = reply;
		this.#persist = persist;
		for (const [key, sessionId] of Object.entries(persist?.load().bindings ?? {})) {
			this.#binding.set(key, sessionId);
		}
	}

	/** Peers (channel + sender) bound to a session — the daemon pushes agent
	 *  replies and stops the typing indicator for exactly these. */
	peersFor(sessionId: string): { kind: string; from: string }[] {
		const peers: { kind: string; from: string }[] = [];
		for (const [key, sid] of this.#binding) {
			if (sid !== sessionId) continue;
			const sep = key.indexOf(":");
			peers.push({ kind: key.slice(0, sep), from: key.slice(sep + 1) });
		}
		return peers;
	}

	/** Drop every binding pointing at a session (session closed from the GUI —
	 *  stale bindings would auto-reactivate it on the next channel message). */
	unbindSession(sessionId: string): void {
		let changed = false;
		for (const [key, sid] of this.#binding) {
			if (sid === sessionId) {
				this.#binding.delete(key);
				changed = true;
			}
		}
		if (changed) this.#save();
	}

	#save(): void {
		this.#persist?.save({ bindings: Object.fromEntries(this.#binding) });
	}

	async handleIncoming(
		kind: string,
		from: string,
		text: string,
		images?: { data: string; mimeType: string }[],
	): Promise<void> {
		const m = MESSAGES[langOf(kind)];
		const reply = (target: string, body: string): Promise<void> => this.#replyFn(kind, target, body);
		const say = (body: string): Promise<void> => reply(from, body);
		const peerKey = `${kind}:${from}`;
		const trimmed = text.trim();
		if (!trimmed && (!images || images.length === 0)) return;
		if (trimmed.startsWith("/")) {
			await this.#runCommand(kind, from, trimmed);
			return;
		}
		// Plain message (optionally with image attachments) → bound session;
		// unbound senders get a fresh session bound automatically (Telegram-DM
		// parity) instead of a dead end telling them to learn /commands first.
		const sessionId = this.#binding.get(peerKey);
		if (sessionId) {
			this.#ops.startTyping?.(sessionId);
			await this.#ops.sendPrompt(sessionId, trimmed, images).catch(err => {
				void say(m.sendFailed(err instanceof Error ? err.message : String(err)));
			});
			return;
		}
		const id = await this.#ops.startSession(trimmed || undefined);
		this.#binding.set(peerKey, id);
		this.#save();
		if (images && images.length > 0) {
			this.#ops.startTyping?.(id);
			await this.#ops.sendPrompt(id, trimmed, images).catch(err => {
				void say(m.sendFailed(err instanceof Error ? err.message : String(err)));
			});
		}
		await say(m.newBound(shortId(id), Boolean(trimmed)));
	}

	async #runCommand(kind: string, from: string, text: string): Promise<void> {
		const m = MESSAGES[langOf(kind)];
		const reply = (target: string, body: string): Promise<void> => this.#replyFn(kind, target, body);
		const say = (body: string): Promise<void> => reply(from, body);
		const peerKey = `${kind}:${from}`;
		const [cmd, ...rest] = text.split(/\s+/);
		const arg = rest.join(" ").trim();
		switch (cmd) {
			case "/help":
				await say(m.help);
				return;
			case "/new": {
				const id = await this.#ops.startSession(arg || undefined);
				this.#binding.set(peerKey, id);
				this.#save();
				if (arg) this.#ops.startTyping?.(id);
				await say(m.newBound(shortId(id), Boolean(arg)));
				return;
			}
			case "/list": {
				const sessions = await this.#ops.listSessions();
				if (sessions.length === 0) {
					await say(langOf(kind) === "zh" ? "暂无会话。" : "No sessions.");
					return;
				}
				const boundId = this.#binding.get(peerKey);
				await say(
					sessions
						.map(
							(s, i) =>
								`${s.id === boundId ? m.currentMark : " "} ${i + 1}. ${s.title || m.untitled} (${shortId(s.id)})`,
						)
						.join("\n"),
				);
				return;
			}
			case "/switch": {
				if (!arg) {
					await say(m.usageSwitch);
					return;
				}
				const sessions = await this.#ops.listSessions();
				const target = sessions.find(s => s.id === arg) ?? sessions[Number(arg) - 1];
				if (!target) {
					await say(m.noSuchSession(arg));
					return;
				}
				this.#binding.set(peerKey, target.id);
				this.#save();
				await say(m.bound(shortId(target.id)));
				return;
			}
			case "/stop": {
				const sessions = await this.#ops.listSessions();
				const target = arg
					? (sessions.find(s => s.id === arg) ?? sessions[Number(arg) - 1])
					: sessions.find(s => s.id === this.#binding.get(peerKey));
				if (!target) {
					await say(m.noSessionToStop);
					return;
				}
				await this.#ops.stopSession(target.id);
				await say(m.stopped(shortId(target.id)));
				return;
			}
			case "/now": {
				const sessionId = this.#binding.get(peerKey);
				if (!sessionId || !arg) {
					await say(m.nowNeedsBinding);
					return;
				}
				this.#ops.startTyping?.(sessionId);
				await this.#ops.sendPrompt(sessionId, arg);
				return;
			}
			default:
				await say(m.unknown(cmd));
		}
	}
}
