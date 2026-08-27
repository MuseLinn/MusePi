import type * as fsTypes from "node:fs";
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
	UserMessage,
} from "@musepi/pi-ai";
import { isRecord } from "@musepi/pi-utils";
import type { ForeignSessionInfo, ForeignSessionSource, ForeignSessionStore } from "./foreign-session-store";
import type { SessionMessageEntry } from "./session-entries";
import { SessionManager } from "./session-manager";

/**
 * Tolerant JSONL session reader for agents whose transcript format is not
 * OMP-SDK-native (grok: `~/.grok/sessions/` + encoded-cwd dirs; kimi-code:
 * `~/.kimi-code` wire.jsonl under session dirs). Records are probed for a
 * message shape — `{role, content[]}` blocks, `{type:"message",
 * message:{role}}`, or `turn.prompt` style events — and converted
 * best-effort; unreadable records are skipped, never fatal.
 */
interface GenericJsonlOptions {
	roots: string[];
	/** Glob (relative to each root) for session files. */
	pattern: string;
	/** Extract cwd from a file path (encoded dirnames). */
	cwdFromPath?: (file: string, root: string) => string;
}

const DEFAULT_GLOBS: Record<"grok" | "kimicode", GenericJsonlOptions> = {
	grok: {
		roots: ["~/.grok/sessions"],
		pattern: "*/*.jsonl",
	},
	kimicode: {
		roots: ["~/.kimi-code"],
		pattern: "**/wire.jsonl",
	},
};

function expandHome(p: string): string {
	return p.replace("~", homedir());
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordTs(record: Record<string, unknown>): number {
	for (const key of ["timestamp", "ts", "time_created", "time", "createdAt"]) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) {
			return value > 10_000_000_000 ? value : value * 1000; // seconds vs ms
		}
		if (typeof value === "string") {
			const parsed = Date.parse(value);
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	return 0;
}

/** Collect role + content blocks from any plausible message record. */
function collectBlocks(record: Record<string, unknown>): {
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
	// Direct message shape: {role, content}
	const direct = record;
	// Nested SDK shape: {type:"message", message:{role, content}}
	const nested = isRecord(record.message) ? record.message : null;
	// turn.prompt style: {type:"turn.prompt", text/…}
	const message = nested ?? direct;
	const role = typeof message.role === "string" ? message.role : undefined;
	const textField =
		typeof message.text === "string"
			? message.text
			: typeof record.text === "string"
				? record.text
				: typeof record.prompt === "string"
					? record.prompt
					: undefined;
	if (textField) out.texts.push(textField);
	if (typeof message.content === "string") out.texts.push(message.content);
	if (Array.isArray(message.content)) {
		for (const block of message.content) {
			if (!isRecord(block)) continue;
			if (block.type === "text" && typeof block.text === "string") out.texts.push(block.text);
			else if (block.type === "thinking" && typeof block.thinking === "string") out.thinking.push(block.thinking);
			else if (block.type === "tool_use" || block.type === "toolCall" || block.type === "tool") {
				const id = stringField(block, "id");
				const name = stringField(block, "name") ?? stringField(block, "tool");
				const input = isRecord(block.input) ? block.input : isRecord(block.arguments) ? block.arguments : {};
				out.tools.push({ id, name, input });
			} else if (block.type === "image" || block.type === "file") {
				const data = stringField(block, "data");
				const mimeType =
					stringField(block, "mimeType") ??
					stringField((block.source ?? {}) as Record<string, unknown>, "media_type");
				if (data && mimeType) out.images.push({ type: "image", data, mimeType });
			}
		}
	}
	// Assistant text may live at top level ({type:"assistant", text})
	if (!role && typeof record.type === "string") {
		const type = record.type;
		if (
			type === "assistant" ||
			type === "assistant_message" ||
			type === "llm.response" ||
			type === "llm.completion"
		) {
			out.role = "assistant";
		} else if (type === "user" || type === "user_message" || type === "turn.prompt" || type === "turn") {
			out.role = "user";
		}
	}
	if (out.role === "assistant" && out.texts.length === 0 && out.thinking.length === 0 && out.tools.length === 0) {
		const content = stringField(record, "content") ?? stringField(record, "text") ?? stringField(record, "response");
		if (content) out.texts.push(content);
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

async function readJsonl(file: string): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	let handle: FileHandle | null = null;
	try {
		handle = await fs.open(file, "r");
		for await (const line of handle.readLines()) {
			try {
				const value = JSON.parse(line) as Record<string, unknown>;
				if (value && typeof value === "object") out.push(value);
			} catch {
				// skip malformed lines
			}
		}
	} finally {
		await handle?.close();
	}
	return out;
}

/** Generic tolerant JSONL session store (grok / kimicode). */
export class GenericJsonlSessionStore implements ForeignSessionStore {
	readonly source: "grok" | "kimicode";
	readonly #options: GenericJsonlOptions;

	constructor(source: "grok" | "kimicode", options?: Partial<GenericJsonlOptions>) {
		this.source = source;
		const base = DEFAULT_GLOBS[source];
		this.#options = {
			roots: options?.roots ?? base.roots,
			pattern: options?.pattern ?? base.pattern,
			cwdFromPath: options?.cwdFromPath,
		};
	}

	async list(): Promise<ForeignSessionInfo[]> {
		const sessions: ForeignSessionInfo[] = [];
		for (const rootRaw of this.#options.roots) {
			const root = expandHome(rootRaw);
			try {
				const stat = await fs.stat(root);
				if (!stat.isDirectory()) continue;
			} catch {
				continue;
			}
			try {
				const files = await Array.fromAsync(new Bun.Glob(this.#options.pattern).scan(root), name =>
					path.join(root, name),
				);
				for (const file of files) {
					try {
						const meta = await this.#head(file);
						const id =
							this.source === "kimicode" ? path.basename(path.dirname(file)) : path.basename(file, ".jsonl");
						sessions.push({
							source: this.source,
							id,
							path: file,
							cwd: this.#options.cwdFromPath?.(file, root) ?? path.dirname(file),
							created: new Date(meta.created),
							modified: new Date(meta.modified),
							firstMessage: meta.firstMessage,
							messageCount: meta.messageCount,
						});
					} catch {
						// unreadable file — skip
					}
				}
			} catch {
				// glob failure
			}
		}
		return sessions.sort(
			(left, right) => right.modified.getTime() - left.modified.getTime() || left.path.localeCompare(right.path),
		);
	}

	async #head(
		file: string,
	): Promise<{ created: number; modified: number; firstMessage?: string; messageCount: number }> {
		const stats = await fs.stat(file);
		let created = stats.mtimeMs;
		let modified = stats.mtimeMs;
		let firstMessage: string | undefined;
		let messageCount = 0;
		let bytes = 0;
		const handle = await fs.open(file, "r");
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
				const ts = recordTs(record);
				if (ts > 0) {
					created = Math.min(created, ts);
					modified = Math.max(modified, ts);
				}
				messageCount += 1;
				if (!firstMessage) {
					const blocks = collectBlocks(record);
					if (blocks.role === "user" && blocks.texts.length > 0) {
						firstMessage = blocks.texts.join(" ").replace(/\s+/g, " ").trim().slice(0, 200);
					}
				}
			}
		} finally {
			await handle.close();
		}
		return { created, modified, firstMessage, messageCount };
	}

	async load(info: ForeignSessionInfo): Promise<SessionManager> {
		if (info.source !== this.source) throw new Error(`Cannot load ${info.source} session with this store`);
		const records = await readJsonl(info.path);
		if (records.length === 0) throw new Error(`Session ${info.id} contains no readable records`);

		const manager = SessionManager.inMemory(info.cwd);
		const usedIds = new Set<string>();
		let parentId: string | null = null;
		let synthetic = 0;

		for (const record of records) {
			const blocks = collectBlocks(record);
			const ts = new Date(recordTs(record) || Date.now()).toISOString();
			if (blocks.role === "user" && (blocks.texts.length > 0 || blocks.images.length > 0)) {
				const content: string | (TextContent | ImageContent)[] =
					blocks.images.length > 0
						? [
								...(blocks.texts.length > 0 ? [{ type: "text" as const, text: blocks.texts.join("\n") }] : []),
								...blocks.images,
							]
						: blocks.texts.join("\n");
				const message: UserMessage = { role: "user", content, timestamp: Date.parse(ts) || Date.now() };
				const id = uniqueEntryId(`g-${synthetic++}`, usedIds);
				const entry: SessionMessageEntry = { type: "message", id, parentId, timestamp: ts, message };
				manager.ingestReplicatedEntry(entry);
				parentId = id;
			} else if (
				blocks.role === "assistant" &&
				(blocks.texts.length > 0 || blocks.thinking.length > 0 || blocks.tools.length > 0)
			) {
				const content: (TextContent | ThinkingContent | ToolCall)[] = [
					...blocks.thinking.map(t => ({ type: "thinking" as const, thinking: t })),
					...blocks.texts.map(t => ({ type: "text" as const, text: t })),
					...blocks.tools.map(t => ({
						type: "toolCall" as const,
						id: t.id ?? `t${synthetic}`,
						name: t.name ?? "tool",
						arguments: t.input ?? {},
					})),
				];
				const message: AssistantMessage = {
					role: "assistant",
					content,
					api: "generic",
					provider: "unknown",
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
					timestamp: Date.parse(ts) || Date.now(),
				};
				const id = uniqueEntryId(`g-${synthetic++}`, usedIds);
				const entry: SessionMessageEntry = { type: "message", id, parentId, timestamp: ts, message };
				manager.ingestReplicatedEntry(entry);
				parentId = id;
			}
		}

		if (info.title) await manager.setSessionName(info.title, "auto");
		return manager;
	}
}
