import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import type { AssistantMessage, TextContent, ThinkingContent, ToolCall, UserMessage } from "@musepi/pi-ai";
import { isRecord } from "@musepi/pi-utils";
import type { ForeignSessionInfo, ForeignSessionStore } from "./foreign-session-store";
import type { SessionMessageEntry } from "./session-entries";
import { SessionManager } from "./session-manager";

/**
 * Grok Build keeps one folder per session, under a folder per working
 * directory, in `<home>/sessions`: `<cwd>/<session id>/`. `summary.json` there
 * names the id, the cwd, when it was made and the model-generated title
 * (`generated_title`, else `session_summary`); `updates.jsonl` is the event
 * log, one `{params:{update:{sessionUpdate,…}}}` per line.
 *
 * A user prompt arrives as a run of `user_message_chunk` updates that must be
 * joined, not as one message record — reading each chunk as a message turns a
 * single prompt into dozens of fragments.
 */

function expandHome(p: string): string {
	return p.replace("~", homedir());
}

/** `$GROK_HOME`, else `~/.grok`. */
function grokRoot(): string {
	const configured = process.env.GROK_HOME;
	return configured ? expandHome(configured) : path.join(homedir(), ".grok");
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface GrokSummary {
	id?: string;
	cwd?: string;
	title?: string;
	parent?: string;
	kind?: string;
	createdAt?: string;
}

async function readSummary(sessionDir: string): Promise<GrokSummary> {
	let parsed: Record<string, unknown>;
	try {
		parsed = (await Bun.file(path.join(sessionDir, "summary.json")).json()) as Record<string, unknown>;
	} catch {
		return {};
	}
	if (!isRecord(parsed)) return {};
	const info = isRecord(parsed.info) ? parsed.info : undefined;
	return {
		id: info ? stringField(info, "id") : undefined,
		cwd: info ? stringField(info, "cwd") : undefined,
		title: stringField(parsed, "generated_title") ?? stringField(parsed, "session_summary"),
		parent: stringField(parsed, "parent_session_id"),
		kind: stringField(parsed, "session_kind"),
		createdAt: stringField(parsed, "created_at"),
	};
}

interface GrokUpdate {
	kind?: string;
	text?: string;
	thinking?: string;
	toolCall?: { id?: string; name?: string; input?: Record<string, unknown> };
	hostTurn: boolean;
}

/** One event line as the fields a listing or transcript needs. */
function readUpdate(record: Record<string, unknown>): GrokUpdate | undefined {
	const params = isRecord(record.params) ? record.params : undefined;
	const update = params && isRecord(params.update) ? params.update : undefined;
	if (!update) return undefined;
	const kind = stringField(update, "sessionUpdate");
	const content = isRecord(update.content) ? update.content : undefined;
	const meta = isRecord(update._meta) ? update._meta : undefined;
	const out: GrokUpdate = { kind, hostTurn: meta?.hostTurn === true };
	if (content) {
		if (content.type === "text") out.text = stringField(content, "text");
		else if (content.type === "thinking") out.thinking = stringField(content, "text");
	}
	if (kind === "tool_call") {
		const call = isRecord(update._meta) ? update._meta : undefined;
		const tool = call && isRecord(call["x.ai/tool"]) ? (call["x.ai/tool"] as Record<string, unknown>) : undefined;
		const input = isRecord(update.rawInput) ? update.rawInput : isRecord(update.input) ? update.input : {};
		out.toolCall = {
			id: stringField(update, "toolCallId"),
			name: tool ? stringField(tool, "name") : undefined,
			input,
		};
	}
	return out;
}

async function readLines(file: string): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	let handle: FileHandle | null = null;
	try {
		handle = await fs.open(file, "r");
		for await (const line of handle.readLines()) {
			try {
				const value: unknown = JSON.parse(line);
				if (isRecord(value)) out.push(value);
			} catch {
				// a torn trailing line is normal for a live session
			}
		}
	} finally {
		await handle?.close();
	}
	return out;
}

function uniqueEntryId(base: string, used: Set<string>): string {
	let candidate = base;
	let i = 1;
	while (used.has(candidate)) candidate = `${base}-${++i}`;
	used.add(candidate);
	return candidate;
}

/** Grok Build session store over its per-session folders. */
export class GrokSessionStore implements ForeignSessionStore {
	readonly source = "grok";
	readonly #root: string;

	constructor(root: string = grokRoot()) {
		this.#root = root;
	}

	async list(): Promise<ForeignSessionInfo[]> {
		const root = path.join(this.#root, "sessions");
		let workspaces: string[];
		try {
			workspaces = await fs.readdir(root);
		} catch {
			return [];
		}
		const sessions: ForeignSessionInfo[] = [];
		for (const workspace of workspaces) {
			if (workspace.startsWith(".")) continue;
			let entries: string[];
			try {
				entries = await fs.readdir(path.join(root, workspace));
			} catch {
				continue;
			}
			for (const entry of entries) {
				const dir = path.join(root, workspace, entry);
				try {
					const info = await this.#describe(dir, entry);
					if (info) sessions.push(info);
				} catch {
					// a session being written or removed mid-scan is skipped
				}
			}
		}
		return sessions.sort(
			(left, right) => right.modified.getTime() - left.modified.getTime() || left.path.localeCompare(right.path),
		);
	}

	async #describe(dir: string, folderName: string): Promise<ForeignSessionInfo | undefined> {
		const summary = await readSummary(dir);
		// A subagent runs in its own folder but belongs to the session that
		// spawned it; counting it separately would invent sessions.
		if (summary.kind?.startsWith("subagent")) return undefined;
		const updates = path.join(dir, "updates.jsonl");
		let stats: Awaited<ReturnType<typeof fs.stat>>;
		try {
			stats = await fs.stat(updates);
		} catch {
			return undefined;
		}
		const modified = stats.mtimeMs;
		const created = Date.parse(summary.createdAt ?? "") || stats.birthtimeMs || stats.mtimeMs;
		let firstMessage: string | undefined;
		let messageCount = 0;
		let bytes = 0;
		let prompt = "";
		const handle = await fs.open(updates, "r");
		try {
			for await (const line of handle.readLines()) {
				bytes += line.length + 1;
				if (bytes > 256 * 1024) break;
				let record: Record<string, unknown>;
				try {
					record = JSON.parse(line) as Record<string, unknown>;
				} catch {
					continue;
				}
				const update = readUpdate(record);
				if (!update) continue;
				// A prompt is streamed in chunks; the session's first one is its
				// natural label when no title was generated.
				if (update.kind === "user_message_chunk" && !update.hostTurn) {
					prompt += update.text ?? "";
					if (update.text) messageCount += 1;
					if (!firstMessage && prompt.length > 0) firstMessage = prompt.replace(/\s+/g, " ").trim().slice(0, 200);
				}
			}
		} finally {
			await handle.close();
		}
		return {
			source: this.source,
			id: summary.id ?? folderName,
			path: dir,
			cwd: summary.cwd ?? workspaceName(dir),
			title: summary.title,
			created: new Date(created),
			modified: new Date(modified),
			firstMessage,
			messageCount,
		};
	}

	async load(info: ForeignSessionInfo): Promise<SessionManager> {
		if (info.source !== this.source) throw new Error(`Cannot load ${info.source} session with this store`);
		const summary = await readSummary(info.path);
		const records = await readLines(path.join(info.path, "updates.jsonl"));
		if (records.length === 0) throw new Error(`Session ${info.id} contains no readable records`);

		const manager = SessionManager.inMemory(summary.cwd ?? info.cwd);
		const usedIds = new Set<string>();
		let parentId: string | null = null;
		let synthetic = 0;
		let prompt: string[] = [];

		/** Append one message entry and make it the current leaf. */
		const append = (message: UserMessage | AssistantMessage): void => {
			const timestamp = new Date(message.timestamp).toISOString();
			const id = uniqueEntryId(`grok-${synthetic++}`, usedIds);
			const entry: SessionMessageEntry = { type: "message", id, parentId, timestamp, message };
			manager.ingestReplicatedEntry(entry);
			parentId = id;
		};

		const assistantMessage = (content: (TextContent | ThinkingContent | ToolCall)[]): AssistantMessage => ({
			role: "assistant",
			content,
			api: "grok",
			provider: "grok",
			model: "unknown",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		/** Flush the chunks of one user prompt as a single message. */
		const flushPrompt = (): void => {
			const text = prompt.join("");
			prompt = [];
			if (!text.trim()) return;
			append({ role: "user", content: text, timestamp: Date.now() });
		};

		for (const record of records) {
			const update = readUpdate(record);
			if (!update) continue;
			if (update.kind === "user_message_chunk") {
				if (update.hostTurn || !update.text) continue;
				prompt.push(update.text);
				continue;
			}
			// Any non-chunk event ends the prompt it was answering.
			flushPrompt();
			if (update.kind === "tool_call" && update.toolCall) {
				const call = update.toolCall;
				append(
					assistantMessage([
						{
							type: "toolCall",
							id: call.id ?? `grok-call-${synthetic}`,
							name: call.name ?? "tool",
							arguments: call.input ?? {},
						},
					]),
				);
				continue;
			}
			if (update.thinking) {
				append(assistantMessage([{ type: "thinking", thinking: update.thinking }]));
				continue;
			}
			if (update.text) append(assistantMessage([{ type: "text", text: update.text }]));
		}
		flushPrompt();

		const title = summary.title ?? info.title;
		if (title) await manager.setSessionName(title, "auto");
		return manager;
	}
}

/** The workspace folder Grok filed a session under, as a fallback cwd. */
function workspaceName(dir: string): string {
	return path.basename(path.dirname(dir));
}
