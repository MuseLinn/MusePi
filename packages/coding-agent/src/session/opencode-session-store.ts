import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import * as path from "node:path";
import type {
	AssistantMessage,
	ImageContent,
	TextContent,
	ThinkingContent,
	ToolCall,
	UserMessage,
} from "@musepi/pi-ai";
import { isRecord } from "@musepi/pi-utils";
import type { ForeignSessionInfo, ForeignSessionStore } from "./foreign-session-store";
import type { SessionMessageEntry } from "./session-entries";
import { SessionManager } from "./session-manager";

/**
 * Sessions from opencode (anomalyco fork / opencode.ai): SQLite with
 * session/message/part tables. Two schemas are in circulation — the original
 * `session`/`message`/`part` tables and, from 2.x, `session_v2`/
 * `session_message`/`session_part` — so every query resolves its table first
 * rather than assuming one shape. A message's `data` JSON differs too: the
 * newer rows keep a user's prompt as `text` and an assistant's blocks as
 * `content[{type:"reasoning"|"text"}]`.
 */

function dbCandidates(): string[] {
	const out: string[] = [];
	if (process.platform === "win32") {
		const local = process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local");
		out.push(path.join(local, "opencode", "opencode.db"));
	}
	// opencode keeps its database under the XDG data root on every platform,
	// including Windows installs that never use %LOCALAPPDATA%.
	out.push(path.join(homedir(), ".local", "share", "opencode", "opencode.db"));
	return out;
}

/** Which tables this database provides: 2.x renamed all three. */
interface OpencodeSchema {
	session: string;
	message: string;
	part?: string;
	/** `data` carries the message payload (2.x) rather than the part table holding it. */
	messageData: boolean;
}

function tableNames(db: Database): Set<string> {
	const rows = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
	return new Set(rows.map(row => row.name));
}

function resolveSchema(db: Database): OpencodeSchema | undefined {
	const names = tableNames(db);
	if (names.has("session_v2") && names.has("session_message")) {
		return {
			session: "session_v2",
			message: "session_message",
			part: names.has("session_part") ? "session_part" : undefined,
			messageData: true,
		};
	}
	if (names.has("session") && names.has("message")) {
		return {
			session: "session",
			message: "message",
			part: names.has("part") ? "part" : undefined,
			messageData: false,
		};
	}
	return undefined;
}

interface OpencodeRow {
	id: string;
	title: string;
	directory: string;
	time_created: number;
	time_updated: number;
	message_count?: number;
}

interface MessageRow {
	id: string;
	time_created: number;
	data: string;
	/** 2.x carries the role on the row (`user`/`assistant`) rather than in `data`. */
	session_id?: string;
	type?: string;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Collect text/image/tool blocks from an opencode message/part data JSON.
 *  2.x rows carry `text` (user) or `content[reasoning|text|tool]` (assistant);
 *  older rows carry `parts[]`. */
function collectBlocks(value: unknown): {
	role?: string;
	texts: string[];
	thinking: string[];
	tools: { id?: string; name?: string; input?: Record<string, unknown> }[];
	images: ImageContent[];
} {
	const out: {
		role?: string;
		texts: string[];
		thinking: string[];
		tools: { id?: string; name?: string; input?: Record<string, unknown> }[];
		images: ImageContent[];
	} = { texts: [], thinking: [], tools: [], images: [] };
	if (!isRecord(value)) return out;
	if (typeof value.role === "string") out.role = value.role;
	if (typeof value.text === "string") out.texts.push(value.text);
	const walk = (blocks: unknown): void => {
		if (!Array.isArray(blocks)) return;
		for (const block of blocks) {
			if (!isRecord(block)) continue;
			if (block.type === "text" && typeof block.text === "string") out.texts.push(block.text);
			else if (
				(block.type === "thinking" || block.type === "reasoning") &&
				typeof (block.thinking ?? block.text) === "string"
			) {
				out.thinking.push((block.thinking ?? block.text) as string);
			} else if (block.type === "tool" || block.type === "tool_use" || block.type === "toolCall") {
				const id = stringField(block, "id") ?? stringField(block, "toolCallId") ?? stringField(block, "callID");
				const name = stringField(block, "name") ?? stringField(block, "tool");
				const input = isRecord(block.input)
					? block.input
					: isRecord(block.arguments)
						? block.arguments
						: isRecord(block.state) && isRecord(block.state.input)
							? block.state.input
							: {};
				out.tools.push({ id, name, input });
			} else if (block.type === "image" || block.type === "file") {
				const data =
					stringField(block, "data") ?? stringField((block.source ?? {}) as Record<string, unknown>, "data");
				const mimeType =
					stringField(block, "mimeType") ??
					stringField((block.source ?? {}) as Record<string, unknown>, "media_type");
				if (data && mimeType) out.images.push({ type: "image", data, mimeType });
			} else if (Array.isArray(block.parts)) {
				walk(block.parts);
			}
		}
	};
	walk(value.content);
	walk(value.parts);
	return out;
}

function uniqueEntryId(base: string, used: Set<string>): string {
	let candidate = base;
	let i = 1;
	while (used.has(candidate)) candidate = `${base}-${++i}`;
	used.add(candidate);
	return candidate;
}

/** The role a row carries: in `data` (1.x) or on the row (2.x). */
function messageRole(data: Record<string, unknown>, rowType: string | undefined): string | undefined {
	const role = typeof data.role === "string" ? data.role : undefined;
	return role ?? rowType;
}

/** Fold one `session_part` row into the message's blocks. */
function applyPart(
	blocks: {
		texts: string[];
		thinking: string[];
		tools: { id?: string; name?: string; input?: Record<string, unknown> }[];
		images: ImageContent[];
	},
	part: Record<string, unknown>,
): void {
	const collected = collectBlocks(part);
	blocks.texts.push(...collected.texts);
	blocks.thinking.push(...collected.thinking);
	blocks.tools.push(...collected.tools);
	blocks.images.push(...collected.images);
}

/** opencode session store — read-only SQLite queries. */
export class OpencodeSessionStore implements ForeignSessionStore {
	readonly source: "opencode" = "opencode";
	readonly #paths: string[];
	#db: Database | null = null;
	#schema: OpencodeSchema | null | undefined;

	constructor(paths?: string[]) {
		this.#paths = paths ?? dbCandidates();
	}

	#open(): Database | null {
		if (this.#db) return this.#db;
		for (const p of this.#paths) {
			try {
				const db = new Database(p, { readonly: true });
				this.#db = db;
				return db;
			} catch {
				// try next candidate
			}
		}
		return null;
	}

	async list(): Promise<ForeignSessionInfo[]> {
		const db = this.#open();
		const schema = this.#resolve(db);
		if (!db || !schema) return [];
		let rows: OpencodeRow[] = [];
		try {
			rows = db
				.query(
					`SELECT id, title, directory, time_created, time_updated FROM ${schema.session} ORDER BY time_updated DESC`,
				)
				.all() as OpencodeRow[];
		} catch {
			return [];
		}
		return rows.map(row => ({
			source: this.source,
			id: row.id,
			path: row.id,
			cwd: row.directory ?? "",
			title: row.title || undefined,
			created: new Date(row.time_created),
			modified: new Date(row.time_updated),
			messageCount: row.message_count ?? 0,
		}));
	}

	#resolve(db: Database | null): OpencodeSchema | undefined {
		if (this.#schema !== undefined) return this.#schema ?? undefined;
		this.#schema = db ? (resolveSchema(db) ?? null) : null;
		return this.#schema ?? undefined;
	}

	/** Release the read-only database handle this store opened. */
	close(): void {
		this.#db?.close();
		this.#db = null;
	}

	/** Part rows by message id, for the legacy schema that splits blocks out. */
	#partsByMessage(db: Database, schema: OpencodeSchema, sessionId: string): Map<string, Record<string, unknown>[]> {
		const out = new Map<string, Record<string, unknown>[]>();
		if (!schema.part || schema.messageData) return out;
		let rows: { message_id: string; data: string }[];
		try {
			rows = db
				.query(`SELECT message_id, data FROM ${schema.part} WHERE session_id = ? ORDER BY ordinal, id`)
				.all(sessionId) as { message_id: string; data: string }[];
		} catch {
			return out;
		}
		for (const row of rows) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(row.data);
			} catch {
				continue;
			}
			if (!isRecord(parsed)) continue;
			const list = out.get(row.message_id) ?? [];
			list.push(parsed);
			out.set(row.message_id, list);
		}
		return out;
	}

	async load(info: ForeignSessionInfo): Promise<SessionManager> {
		if (info.source !== this.source) throw new Error(`Cannot load ${info.source} session with this store`);
		const db = this.#open();
		const schema = this.#resolve(db);
		if (!db || !schema) throw new Error("opencode database not found");
		const rows = db
			.query(
				schema.messageData
					? `SELECT id, session_id, type, time_created, data FROM ${schema.message} WHERE session_id = ? ORDER BY seq, time_created`
					: `SELECT id, time_created, data FROM ${schema.message} WHERE session_id = ? ORDER BY time_created, id`,
			)
			.all(info.id) as MessageRow[];
		if (rows.length === 0) throw new Error(`Session ${info.id} contains no messages`);

		const manager = SessionManager.inMemory(info.cwd);
		const usedIds = new Set<string>();
		const toolNames = new Map<string, string>();
		let parentId: string | null = null;
		let synthetic = 0;
		const title = info.title;
		const parts = this.#partsByMessage(db, schema, info.id);

		for (const row of rows) {
			let data: Record<string, unknown>;
			try {
				data = JSON.parse(row.data) as Record<string, unknown>;
			} catch {
				continue;
			}
			// 2.x rows also hold bookkeeping (`idle`, `error`); only message rows convert.
			const role = messageRole(data, row.type);
			if (role !== "user" && role !== "assistant" && role !== "tool") continue;
			const blocks = collectBlocks(data);
			for (const part of parts.get(row.id) ?? []) applyPart(blocks, part);
			const ts = row.time_created * 1000;
			if (role === "user" && (blocks.texts.length > 0 || blocks.images.length > 0)) {
				const content: string | (TextContent | ImageContent)[] =
					blocks.images.length > 0
						? [
								...(blocks.texts.length > 0 ? [{ type: "text" as const, text: blocks.texts.join("\n") }] : []),
								...blocks.images,
							]
						: blocks.texts.join("\n");
				const message: UserMessage = { role: "user", content, timestamp: ts };
				const id = uniqueEntryId(`oc-${synthetic++}`, usedIds);
				const entry: SessionMessageEntry = {
					type: "message",
					id,
					parentId,
					timestamp: new Date(ts).toISOString(),
					message,
				};
				manager.ingestReplicatedEntry(entry);
				parentId = id;
			} else if (role === "assistant") {
				const content: (TextContent | ThinkingContent | ToolCall)[] = [
					...blocks.thinking.map(t => ({ type: "thinking" as const, thinking: t })),
					...blocks.texts.map(t => ({ type: "text" as const, text: t })),
					...blocks.tools.map(t => {
						const id = t.id ?? `t${synthetic}`;
						if (t.name) toolNames.set(id, t.name);
						return { type: "toolCall" as const, id, name: t.name ?? "tool", arguments: t.input ?? {} };
					}),
				];
				if (content.length === 0) continue;
				const model = isRecord(data.model) ? data.model : undefined;
				const message: AssistantMessage = {
					role: "assistant",
					content,
					api: "opencode",
					provider: (model ? stringField(model, "providerID") : undefined) ?? "opencode",
					model: (model ? stringField(model, "id") : undefined) ?? "unknown",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: ts,
				};
				const id = uniqueEntryId(`oc-${synthetic++}`, usedIds);
				const entry: SessionMessageEntry = {
					type: "message",
					id,
					parentId,
					timestamp: new Date(ts).toISOString(),
					message,
				};
				manager.ingestReplicatedEntry(entry);
				parentId = id;
			}
			// toolResult parts (role "tool") carry tool outputs — included in
			// the assistant block context for continuity but not surfaced as
			// separate entries (opencode stores them in part rows).
		}

		if (title) await manager.setSessionName(title, "auto");
		return manager;
	}
}
