import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
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
import type { ForeignSessionInfo, ForeignSessionStore } from "./foreign-session-store";
import type { SessionMessageEntry } from "./session-entries";
import { SessionManager } from "./session-manager";

/**
 * Kimi Code keeps a session as `<sessions>/<workspace>/session_<id>/`: its
 * `state.json` is the session's own record (title, title kind, cwd, dates) and
 * `agents/<agent>/wire.jsonl` its events, one per line. `agents/main` is the
 * session the user opened; other agent folders are its subagents.
 *
 * A message event nests one level deeper than the other agents' records —
 * `{"type":"agent.message.appended","message":{"message":{"role","content"}}}`
 * — so a reader that expects a single `message` wrapper finds no role at all
 * and every session looks empty. The session's id is its folder name, not the
 * agent folder's (`main`), which cannot tell two sessions apart.
 *
 * A subagent is part of the session that spawned it, not a session of its own:
 * `list()` still yields one entry per `session_<id>` folder, with the
 * subagents' messages counted in. The spawned record
 * (`subagent.spawned`, naming its kind, description and parent) lives in the
 * wire of whichever agent started it, so the marker a subagent gets in the
 * import comes from scanning every wire of the session.
 */

interface KimiState {
	title?: string;
	titleKind?: string;
	isCustomTitle?: boolean;
	customTitle?: string;
	cwd?: string;
	createdAt?: number;
	updatedAt?: number;
	lastPrompt?: string;
}

function expandHome(p: string): string {
	return p.replace("~", homedir());
}

/** `$KIMI_CODE_HOME`, else `~/.kimi-code`. */
function kimiRoot(): string {
	const configured = process.env.KIMI_CODE_HOME;
	return configured ? expandHome(configured) : path.join(homedir(), ".kimi-code");
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteMs(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Kimi's own name for a session and the one the user gave it. Its
 * `isCustomTitle` flag is authoritative; `titleKind` covers records written
 * before that flag existed, and `customTitle` is the older field name.
 */
function kimiNames(state: KimiState): { title?: string } {
	if (state.title) return { title: state.title };
	if (state.customTitle) return { title: state.customTitle };
	return {};
}

async function readState(sessionDir: string): Promise<KimiState> {
	try {
		const text = await Bun.file(path.join(sessionDir, "state.json")).text();
		const parsed = JSON.parse(text) as Record<string, unknown>;
		return isRecord(parsed) ? (parsed as KimiState) : {};
	} catch {
		return {};
	}
}

interface KimiBlocks {
	role?: string;
	texts: string[];
	thinking: string[];
	tools: { id?: string; name?: string; input?: Record<string, unknown> }[];
	toolCallId?: string;
	images: ImageContent[];
}

/** Unwrap the record's message payload: Kimi nests it twice, others once. */
function kimiMessage(record: Record<string, unknown>): Record<string, unknown> | undefined {
	const outer = isRecord(record.message) ? record.message : undefined;
	if (!outer) return undefined;
	if (isRecord(outer.message)) return outer.message;
	return outer;
}

function collectBlocks(record: Record<string, unknown>): KimiBlocks {
	const out: KimiBlocks = { texts: [], thinking: [], tools: [], images: [] };
	const message = kimiMessage(record);
	if (!message) return out;
	if (typeof message.role === "string") out.role = message.role;
	out.toolCallId = stringField(message, "toolCallId");
	const content = message.content;
	if (typeof content === "string") out.texts.push(content);
	if (Array.isArray(content)) {
		for (const block of content) {
			if (!isRecord(block)) continue;
			if (block.type === "text" && typeof block.text === "string") out.texts.push(block.text);
			else if (block.type === "think" && typeof block.think === "string") out.thinking.push(block.think);
			else if (block.type === "thinking" && typeof block.thinking === "string") out.thinking.push(block.thinking);
			else {
				const image = imageBlock(block);
				if (image) out.images.push(image);
			}
		}
	}
	if (Array.isArray(message.toolCalls)) {
		for (const call of message.toolCalls) {
			if (!isRecord(call)) continue;
			const raw = call.arguments;
			let args: Record<string, unknown> = {};
			if (isRecord(raw)) args = raw;
			else if (typeof raw === "string") {
				try {
					const parsed = JSON.parse(raw) as unknown;
					if (isRecord(parsed)) args = parsed;
				} catch {
					// arguments kept as text: the call still names its tool
				}
			}
			out.tools.push({ id: stringField(call, "id"), name: stringField(call, "name"), input: args });
		}
	}
	return out;
}

function imageBlock(block: Record<string, unknown>): ImageContent | undefined {
	if (block.type !== "image" && block.type !== "file") return undefined;
	const source = isRecord(block.source) ? block.source : undefined;
	const data = stringField(block, "data") ?? (source ? stringField(source, "data") : undefined);
	const mimeType =
		stringField(block, "mimeType") ??
		stringField(block, "mime_type") ??
		(source ? (stringField(source, "media_type") ?? stringField(source, "mime_type")) : undefined);
	return data && mimeType ? { type: "image", data, mimeType } : undefined;
}

function eventTimeMs(record: Record<string, unknown>): number | undefined {
	return finiteMs(record.time) ?? finiteMs(record.createdAt);
}

/** Events that carry a message; the rest are protocol bookkeeping. */
function isMessageEvent(record: Record<string, unknown>): boolean {
	return record.type === "agent.message.appended";
}

/** Whitespace-collapsed first line of a prompt, as a picker shows it. */
function promptPreview(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

async function readLines(file: string): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	let handle: FileHandle | null = null;
	try {
		handle = await fs.open(file, "r");
		for await (const line of handle.readLines()) {
			try {
				const value = JSON.parse(line) as unknown;
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

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;

/** Kimi Code session store over its per-session folders. */
export class KimiSessionStore implements ForeignSessionStore {
	readonly source = "kimicode";
	readonly #root: string;

	constructor(root: string = kimiRoot()) {
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
				if (!entry.startsWith("session_")) continue;
				try {
					const info = await this.#describe(path.join(root, workspace, entry));
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

	/** The session's folder name is its id; `main`'s agent folder is not. */
	async #describe(dir: string): Promise<ForeignSessionInfo | undefined> {
		const state = await readState(dir);
		const wire = path.join(dir, "agents", "main", "wire.jsonl");
		let modified = state.updatedAt ?? state.createdAt ?? 0;
		let created = state.createdAt ?? modified;
		let firstMessage: string | undefined;
		let messageCount = 0;
		try {
			const head = await this.#head(wire);
			created = head.created || created;
			modified = Math.max(modified, head.modified);
			firstMessage = head.firstMessage;
			messageCount = head.messageCount;
		} catch {
			return undefined;
		}
		const id = path.basename(dir).replace(/^session_/, "");
		return {
			source: this.source,
			id,
			path: dir,
			cwd: state.cwd ?? path.basename(path.dirname(dir)),
			title: kimiNames(state).title,
			created: new Date(created),
			modified: new Date(modified),
			firstMessage,
			messageCount,
		};
	}

	/** Bounded read for listing: the first prompt and the event span. */
	async #head(
		wire: string,
	): Promise<{ created: number; modified: number; firstMessage?: string; messageCount: number }> {
		const stats = await fs.stat(wire);
		let created = stats.birthtimeMs || stats.mtimeMs;
		let modified = stats.mtimeMs;
		let firstMessage: string | undefined;
		let messageCount = 0;
		let bytes = 0;
		const handle = await fs.open(wire, "r");
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
				const ts = eventTimeMs(record);
				if (ts !== undefined) {
					created = Math.min(created, ts);
					modified = Math.max(modified, ts);
				}
				if (!isMessageEvent(record)) continue;
				messageCount += 1;
				if (firstMessage) continue;
				const blocks = collectBlocks(record);
				if (blocks.role === "user" && blocks.texts.length > 0) {
					firstMessage = promptPreview(blocks.texts.join(" "));
				}
			}
		} finally {
			await handle.close();
		}
		return { created, modified, firstMessage, messageCount };
	}

	async load(info: ForeignSessionInfo): Promise<SessionManager> {
		if (info.source !== this.source) throw new Error(`Cannot load ${info.source} session with this store`);
		const state = await readState(info.path);
		const records = await readLines(path.join(info.path, "agents", "main", "wire.jsonl"));
		if (records.length === 0) throw new Error(`Session ${info.id} contains no readable records`);
		const manager = SessionManager.inMemory(state.cwd ?? info.cwd);
		const usedIds = new Set<string>();
		const toolNames = new Map<string, string>();
		let parentId: string | null = null;
		let synthetic = 0;

		for (const record of records) {
			if (!isMessageEvent(record)) continue;
			const ts = eventTimeMs(record) ?? Date.now();
			const blocks = collectBlocks(record);
			const timestamp = new Date(ts).toISOString();
			if (blocks.role === "user" && (blocks.texts.length > 0 || blocks.images.length > 0)) {
				const content: string | (TextContent | ImageContent)[] =
					blocks.images.length > 0
						? [
								...(blocks.texts.length > 0 ? [{ type: "text" as const, text: blocks.texts.join("\n") }] : []),
								...blocks.images,
							]
						: blocks.texts.join("\n");
				const message: UserMessage = { role: "user", content, timestamp: ts };
				const id = uniqueEntryId(`kimi-${synthetic++}`, usedIds);
				const entry: SessionMessageEntry = { type: "message", id, parentId, timestamp, message };
				manager.ingestReplicatedEntry(entry);
				parentId = id;
				continue;
			}
			if (blocks.role === "tool") {
				const content: (TextContent | ImageContent)[] = [
					...blocks.texts.map(text => ({ type: "text" as const, text })),
					...blocks.images,
				];
				if (content.length === 0) continue;
				const toolCallId = blocks.toolCallId ?? "";
				const message: ToolResultMessage = {
					role: "toolResult",
					toolCallId,
					toolName: toolNames.get(toolCallId) ?? "tool",
					content,
					isError: false,
					timestamp: ts,
				};
				const id = uniqueEntryId(`kimi-${synthetic++}`, usedIds);
				const entry: SessionMessageEntry = { type: "message", id, parentId, timestamp, message };
				manager.ingestReplicatedEntry(entry);
				parentId = id;
				continue;
			}
			if (blocks.role !== "assistant") continue;
			const content: (TextContent | ThinkingContent | ToolCall)[] = [
				...blocks.thinking.map(text => ({ type: "thinking" as const, thinking: text })),
				...blocks.texts.map(text => ({ type: "text" as const, text })),
				...blocks.tools.map(tool => {
					const id = tool.id ?? `kimi-call-${synthetic}`;
					if (tool.name) toolNames.set(id, tool.name);
					return {
						type: "toolCall" as const,
						id,
						name: tool.name ?? "tool",
						arguments: tool.input ?? {},
					};
				}),
			];
			if (content.length === 0) continue;
			const message: AssistantMessage = {
				role: "assistant",
				content,
				api: "kimi",
				provider: "kimi",
				model: "unknown",
				usage: { ...EMPTY_USAGE, cost: { ...EMPTY_USAGE.cost } },
				stopReason: "stop",
				timestamp: ts,
			};
			const id = uniqueEntryId(`kimi-${synthetic++}`, usedIds);
			const entry: SessionMessageEntry = { type: "message", id, parentId, timestamp, message };
			manager.ingestReplicatedEntry(entry);
			parentId = id;
		}

		const title = kimiNames(state).title ?? info.title;
		if (title) await manager.setSessionName(title, "auto");
		return manager;
	}
}
