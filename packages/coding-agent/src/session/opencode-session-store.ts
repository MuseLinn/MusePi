import * as path from "node:path";
import { homedir } from "node:os";
import { Database } from "bun:sqlite";
import type {
	AssistantMessage,
	ImageContent,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@musepi/pi-ai";
import { isRecord } from "@musepi/pi-utils";
import type { ForeignSessionInfo, ForeignSessionSource, ForeignSessionStore } from "./foreign-session-store";
import type { SessionMessageEntry } from "./session-entries";
import { SessionManager } from "./session-manager";

/**
 * Sessions from opencode (anomalyco fork / opencode.ai): SQLite at
 * `<xdg-data>/opencode/opencode.db` with session/message/part tables.
 * message.data and part.data are JSON strings carrying role + content
 * blocks — read tolerantly (structure may drift across schema versions).
 */

function dbCandidates(): string[] {
	if (process.platform === "win32") {
		const local = process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local");
		return [path.join(local, "opencode", "opencode.db")];
	}
	return [path.join(homedir(), ".local", "share", "opencode", "opencode.db")];
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
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Collect text/image/tool blocks from an opencode message/part data JSON,
 *  tolerant of both nested `parts[]` and a top-level role+content shape. */
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
	const walk = (blocks: unknown): void => {
		if (!Array.isArray(blocks)) return;
		for (const block of blocks) {
			if (!isRecord(block)) continue;
			if (block.type === "text" && typeof block.text === "string") out.texts.push(block.text);
			else if (block.type === "thinking" && typeof block.thinking === "string") out.thinking.push(block.thinking);
			else if (block.type === "tool" || block.type === "tool_use" || block.type === "toolCall") {
				const id = stringField(block, "id") ?? stringField(block, "toolCallId");
				const name = stringField(block, "name") ?? stringField(block, "tool");
				const input = isRecord(block.input) ? block.input : isRecord(block.arguments) ? block.arguments : {};
				out.tools.push({ id, name, input });
			} else if (block.type === "image" || block.type === "file") {
				const data = stringField(block, "data") ?? stringField((block.source ?? {}) as Record<string, unknown>, "data");
				const mimeType = stringField(block, "mimeType") ?? stringField((block.source ?? {}) as Record<string, unknown>, "media_type");
				if (data && mimeType) out.images.push({ type: "image", data, mimeType });
			} else if (Array.isArray(block.parts)) {
				walk(block.parts);
			}
		}
	};
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

/** opencode session store — read-only SQLite queries. */
export class OpencodeSessionStore implements ForeignSessionStore {
	readonly source: "opencode" = "opencode";
	readonly #paths: string[];
	#db: Database | null = null;

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
		if (!db) return [];
		const rows: OpencodeRow[] = [];
		try {
			rows.push(
				...(db.query("SELECT id, title, directory, time_created, time_updated FROM session ORDER BY time_updated DESC").all() as OpencodeRow[]),
			);
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

	async load(info: ForeignSessionInfo): Promise<SessionManager> {
		if (info.source !== this.source) throw new Error(`Cannot load ${info.source} session with this store`);
		const db = this.#open();
		if (!db) throw new Error("opencode database not found");
		const rows = db
			.query("SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id")
			.all(info.id) as MessageRow[];
		if (rows.length === 0) throw new Error(`Session ${info.id} contains no messages`);

		const manager = SessionManager.inMemory(info.cwd);
		const usedIds = new Set<string>();
		let parentId: string | null = null;
		let synthetic = 0;
		let title = info.title;

		for (const row of rows) {
			let data: Record<string, unknown>;
			try {
				data = JSON.parse(row.data) as Record<string, unknown>;
			} catch {
				continue;
			}
			const blocks = collectBlocks(data);
			const ts = row.time_created * 1000;
			const role = blocks.role ?? stringField(data, "role");
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
				const entry: SessionMessageEntry = { type: "message", id, parentId, timestamp: new Date(ts).toISOString(), message };
				manager.ingestReplicatedEntry(entry);
				parentId = id;
			} else if (role === "assistant" || blocks.tools.length > 0) {
				const content: (TextContent | ThinkingContent | ToolCall)[] = [
					...blocks.thinking.map(t => ({ type: "thinking" as const, thinking: t })),
					...blocks.texts.map(t => ({ type: "text" as const, text: t })),
					...blocks.tools.map(t => ({ type: "toolCall" as const, id: t.id ?? `t${synthetic}`, name: t.name ?? "tool", arguments: t.input ?? {} })),
				];
				if (content.length === 0) continue;
				const message: AssistantMessage = { role: "assistant", content, api: "opencode", provider: "opencode", model: "unknown", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: ts };
				const id = uniqueEntryId(`oc-${synthetic++}`, usedIds);
				const entry: SessionMessageEntry = { type: "message", id, parentId, timestamp: new Date(ts).toISOString(), message };
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
