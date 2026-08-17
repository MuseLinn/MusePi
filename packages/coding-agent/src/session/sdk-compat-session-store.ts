import type * as fsTypes from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { homedir } from "node:os";
import type {
	AssistantMessage,
	ImageContent,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@musepi/pi-ai";
import { isRecord } from "@musepi/pi-utils";
import type { ForeignSessionInfo, ForeignSessionSource, ForeignSessionStore } from "./foreign-session-store";
import type { ModelChangeEntry, SessionMessageEntry } from "./session-entries";
import { SessionManager } from "./session-manager";

/**
 * Sessions owned by an OMP-SDK-compatible agent (musepi/omp/pi share the
 * same session format: `<sessions>/<encoded-cwd>/<ts>_<uuid>.jsonl` of wire
 * records with `type:"message"` + `message.role` blocks). Reading a sibling
 * install is a format-compatible conversion, not a translation.
 */
const SDK_SESSION_ROOTS: Record<"omp" | "pi", string[]> = {
	omp: ["~/.omp/agent/sessions", "~/.omp/sessions", "~/.omp/agent/data/sessions"],
	pi: ["~/.pi/agent/sessions", "~/.pi/sessions", "~/.pi/agent/data/sessions"],
};

function expandHome(p: string): string {
	return p.replace("~", homedir());
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isoToMs(value: unknown, fallback: number): number {
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return fallback;
}

function firstMessagePreview(record: Record<string, unknown>): string | undefined {
	const message = record.message;
	if (!isRecord(message) || message.role !== "user") return undefined;
	const content = message.content;
	if (typeof content === "string") return content.replace(/\s+/g, " ").trim();
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
			return block.text.replace(/\s+/g, " ").trim();
		}
	}
	return undefined;
}

function imageContent(value: unknown): ImageContent | undefined {
	if (!isRecord(value) || value.type !== "image" || !isRecord(value.source)) return undefined;
	const data = stringField(value.source, "data");
	const mimeType = stringField(value.source, "media_type");
	return data && mimeType ? { type: "image", data, mimeType } : undefined;
}

function userContent(value: unknown): string | (TextContent | ImageContent)[] | undefined {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return undefined;
	const content: (TextContent | ImageContent)[] = [];
	for (const block of value) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text });
		else {
			const image = imageContent(block);
			if (image) content.push(image);
		}
	}
	return content.length > 0 ? content : undefined;
}

function toolResultContent(value: unknown): (TextContent | ImageContent)[] {
	if (typeof value === "string") return [{ type: "text", text: value }];
	if (!Array.isArray(value)) return [];
	const content: (TextContent | ImageContent)[] = [];
	for (const block of value) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text });
		else {
			const image = imageContent(block);
			if (image) content.push(image);
		}
	}
	return content;
}

function assistantContent(
	value: unknown,
	toolNames: Map<string, string>,
): (TextContent | ThinkingContent | ToolCall)[] {
	if (!Array.isArray(value)) return [];
	const content: (TextContent | ThinkingContent | ToolCall)[] = [];
	for (const block of value) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") {
			content.push({ type: "text", text: block.text });
		} else if (block.type === "thinking" && typeof block.thinking === "string") {
			const thinking: ThinkingContent = { type: "thinking", thinking: block.thinking };
			if (typeof block.signature === "string") thinking.thinkingSignature = block.signature;
			content.push(thinking);
		} else if (block.type === "tool_use") {
			const id = stringField(block, "id");
			const name = stringField(block, "name");
			if (!id || !name) continue;
			const argumentsValue = isRecord(block.input) ? block.input : {};
			content.push({ type: "toolCall", id, name, arguments: argumentsValue });
			toolNames.set(id, name);
		}
	}
	return content;
}

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Convert one SDK wire record into session messages (format-compatible). */
function convertRecord(
	record: Record<string, unknown>,
	toolNames: Map<string, string>,
	timestamp: number,
): { message: UserMessage | AssistantMessage | ToolResultMessage; kind: string }[] {
	if (record.type !== "message") return [];
	const message = record.message;
	if (!isRecord(message) || typeof message.role !== "string") return [];
	const id = stringField(record, "id") ?? "";
	const out: { message: UserMessage | AssistantMessage | ToolResultMessage; kind: string }[] = [];

	if (message.role === "user") {
		const content = userContent(message.content);
		if (content === undefined) return [];
		const user: UserMessage = { role: "user", content, timestamp };
		out.push({ message: user, kind: "user" });
		return out;
	}
	if (message.role === "assistant") {
		const content = assistantContent(message.content, toolNames);
		if (content.length === 0) return [];
		const assistant: AssistantMessage = {
			role: "assistant",
			content,
			api: stringField(message, "api") ?? "sdk",
			provider: stringField(message, "provider") ?? "unknown",
			model: stringField(message, "model") ?? "unknown",
			usage: EMPTY_USAGE,
			stopReason: "stop",
			timestamp,
		};
		out.push({ message: assistant, kind: "assistant" });
		return out;
	}
	if (message.role === "tool") {
		const content = toolResultContent(message.content);
		if (content.length === 0) return [];
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: id,
			toolName: toolNames.get(id) ?? "unknown",
			content,
			isError: false,
			timestamp,
		};
		out.push({ message: toolResult, kind: "tool_result" });
		return out;
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

async function collectRecords(file: string): Promise<{ value: Record<string, unknown> }[]> {
	const records: { value: Record<string, unknown> }[] = [];
	let handle: FileHandle | null = null;
	try {
		handle = await fs.open(file, "r");
		for await (const line of handle.readLines()) {
			try {
				const value = JSON.parse(line) as Record<string, unknown>;
				if (value && typeof value === "object") records.push({ value });
			} catch {
				// skip malformed lines
			}
		}
	} finally {
		await handle?.close();
	}
	return records;
}

/** OMP-SDK-compatible session store (omp / pi). */
export class SdkCompatSessionStore implements ForeignSessionStore {
	readonly source: "omp" | "pi";
	readonly #roots: string[];

	constructor(source: "omp" | "pi", roots?: string[]) {
		this.source = source;
		this.#roots = roots ?? SDK_SESSION_ROOTS[source].map(expandHome);
	}

	async #sessionRoot(): Promise<string | null> {
		for (const root of this.#roots) {
			try {
				const stat = await fs.stat(root);
				if (stat.isDirectory()) return root;
			} catch {
				// try next candidate
			}
		}
		return null;
	}

	async list(): Promise<ForeignSessionInfo[]> {
		const root = await this.#sessionRoot();
		if (!root) return [];
		const sessions: ForeignSessionInfo[] = [];
		try {
			const files = await Array.fromAsync(new Bun.Glob("*/*.jsonl").scan(root), name => path.join(root, name));
			for (const file of files) {
				try {
					const meta = await this.#readHead(file, root);
					sessions.push({
						source: this.source,
						id: path.basename(file, ".jsonl"),
						path: file,
						cwd: meta.cwd,
						created: new Date(meta.created),
						modified: new Date(meta.modified),
						firstMessage: meta.firstMessage,
						messageCount: meta.messageCount,
					});
				} catch {
					// unreadable/locked file — skip
				}
			}
		} catch {
			// glob failure — no sessions
		}
		return sessions.sort(
			(left, right) => right.modified.getTime() - left.modified.getTime() || left.path.localeCompare(right.path),
		);
	}

	/** Bounded head read for lightweight metadata. */
	async #readHead(
		file: string,
		root: string,
	): Promise<{ cwd: string; created: number; modified: number; firstMessage?: string; messageCount: number }> {
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
				const ts = isoToMs(record.timestamp, 0);
				if (ts > 0) {
					created = Math.min(created, ts);
					modified = Math.max(modified, ts);
				}
				if (record.type === "session" && typeof record.cwd === "string") modified = modified; // cwd on session record
				if (record.type === "message") messageCount += 1;
				if (!firstMessage) firstMessage = firstMessagePreview(record);
			}
		} finally {
			await handle.close();
		}
		return { cwd: await this.#cwdFor(file, root), created, modified, firstMessage, messageCount };
	}

	/** SDK shape: sessions/<encoded-cwd>/<file>; a `.cwd` marker overrides. */
	async #cwdFor(file: string, root: string): Promise<string> {
		const dir = path.dirname(file);
		try {
			const marker = (await fs.readFile(path.join(dir, ".cwd"), "utf8")).trim();
			if (marker) return marker;
		} catch {
			// no marker
		}
		return path.relative(root, dir).replaceAll(path.sep, "-").replace(/^-+/, "");
	}

	async load(info: ForeignSessionInfo): Promise<SessionManager> {
		if (info.source !== this.source) throw new Error(`Cannot load ${info.source} session with this store`);
		const records = await collectRecords(info.path);
		if (records.length === 0) throw new Error(`Session ${info.id} contains no readable records`);

		let sourceCwd: string | undefined;
		let title: string | undefined;
		const usedIds = new Set<string>();
		const toolNames = new Map<string, string>();
		const manager = SessionManager.inMemory(sourceCwd ?? info.cwd);
		let lastModel: string | undefined;
		let parentId: string | null = null;
		let synthetic = 0;

		for (const { value } of records) {
			const ts = isoToMs(value.timestamp, Date.now());
			if (value.type === "session" && typeof value.cwd === "string") sourceCwd = value.cwd;
			if (value.type === "title" && typeof value.title === "string" && value.title.length > 0) title = value.title;
			if (value.type === "model_change" && typeof value.model === "string") {
				if (value.model !== lastModel) {
					const id = uniqueEntryId(`sdk-model-${synthetic++}`, usedIds);
					const entry: ModelChangeEntry = {
						type: "model_change",
						id,
						parentId,
						timestamp: new Date(ts).toISOString(),
						model: value.model,
					};
					manager.ingestReplicatedEntry(entry);
					parentId = id;
					lastModel = value.model;
				}
				continue;
			}
			const converted = convertRecord(value, toolNames, ts);
			for (const item of converted) {
				const id = uniqueEntryId(`sdk-${synthetic++}`, usedIds);
				const entry: SessionMessageEntry = {
					type: "message",
					id,
					parentId,
					timestamp: new Date(ts).toISOString(),
					message: item.message,
				};
				manager.ingestReplicatedEntry(entry);
				parentId = id;
			}
		}

		if (title) await manager.setSessionName(title, "auto");
		return manager;
	}
}
