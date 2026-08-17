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
}

/** Chat ↔ session command router (Proma bridge-command-handler pattern,
 *  musepi-flavoured: no workspace/model switching — sessions only).
 *
 *  `/help /new [prompt] /list /stop [id] /switch <id> /now <text>`
 *  Bare text routes to the bound session (bound on first /new or /switch). */
export class ChannelCommandHandler implements ChannelHost {
	readonly #ops: ChannelOps;
	readonly #replyFn: (kind: string, from: string, text: string) => Promise<void>;
	readonly #binding = new Map<string, string>();

	constructor(ops: ChannelOps, reply: (kind: string, from: string, text: string) => Promise<void>) {
		this.#ops = ops;
		this.#replyFn = reply;
	}

	async handleIncoming(
		kind: string,
		from: string,
		text: string,
		images?: { data: string; mimeType: string }[],
	): Promise<void> {
		const reply = (target: string, body: string): Promise<void> => this.#replyFn(kind, target, body);
		const trimmed = text.trim();
		if (!trimmed && (!images || images.length === 0)) return;
		if (trimmed.startsWith("/")) {
			await this.#runCommand(reply, from, trimmed);
			return;
		}
		// Plain message (optionally with image attachments) → bound session.
		const sessionId = this.#binding.get(from);
		if (sessionId) {
			await this.#ops.sendPrompt(sessionId, trimmed, images).catch(err => {
				void reply(from, `send failed: ${err instanceof Error ? err.message : String(err)}`);
			});
		} else {
			await reply(
				from,
				images && images.length > 0
					? "Received image(s) — send /new <prompt> or /switch <id> to bind a session first. /help for commands."
					: "No session bound — send /new <prompt> or /switch <id> first. /help for commands.",
			);
		}
	}

	async #runCommand(
		reply: (from: string, text: string) => Promise<void>,
		from: string,
		text: string,
	): Promise<void> {
		const [cmd, ...rest] = text.split(/\s+/);
		const arg = rest.join(" ").trim();
		switch (cmd) {
			case "/help":
				await reply(
					from,
					"/new <prompt> — new session\n/list — sessions\n/switch <id> — bind session\n/stop [id] — stop session\n/now <text> — prompt bound session\nplain text — prompt bound session",
				);
				return;
			case "/new": {
				const id = await this.#ops.startSession(arg || undefined);
				this.#binding.set(from, id);
				await reply(from, arg ? `Session started: ${id}` : "New session (no prompt). Send text to prompt it.");
				return;
			}
			case "/list": {
				const sessions = await this.#ops.listSessions();
				const current = this.#ops.currentSessionId();
				if (sessions.length === 0) {
					await reply(from, "No sessions.");
					return;
				}
				await reply(
					from,
					sessions
						.map(s => `${s.id === current ? "* " : "  "}${s.id} — ${s.title || "(untitled)"}`)
						.join("\n"),
				);
				return;
			}
			case "/switch": {
				const id = arg;
				if (!id) {
					await reply(from, "usage: /switch <sessionId>");
					return;
				}
				const sessions = await this.#ops.listSessions();
				const target = sessions.find(s => s.id === id) ?? sessions[Number(id) - 1];
				if (!target) {
					await reply(from, `No session ${id}. /list to see ids.`);
					return;
				}
				this.#binding.set(from, target.id);
				await reply(from, `Bound to ${target.id}`);
				return;
			}
			case "/stop": {
				const sessions = await this.#ops.listSessions();
				const target = arg
					? sessions.find(s => s.id === arg) ?? sessions[Number(arg) - 1]
					: sessions.find(s => s.id === this.#binding.get(from));
				if (!target) {
					await reply(from, "No session to stop.");
					return;
				}
				await this.#ops.stopSession(target.id);
				await reply(from, `Stopped ${target.id}`);
				return;
			}
			case "/now": {
				const sessionId = this.#binding.get(from);
				if (!sessionId || !arg) {
					await reply(from, "/now <text> — needs a bound session (/switch first)");
					return;
				}
				await this.#ops.sendPrompt(sessionId, arg);
				return;
			}
			default:
				await reply(from, `Unknown command ${cmd}. /help`);
		}
	}
}
