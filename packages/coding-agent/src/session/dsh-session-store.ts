import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
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
 * DeepSeek Harness keeps a session in its own folder under
 * `<home>/sessions/<project>/`, one file per format generation:
 * `session.jsonl[.zstd]` or `session.v<N>.jsonl[.zstd]`. A carried-over
 * session leaves the older generation behind, so only the newest is read; the
 * file's first line is the header (id, cwd, createdAt) and every line after it
 * is an event `{type, seq, time, data}`. A subagent session records
 * `parentSession` and a positive `delegationDepth`; it counts inside the
 * session that spawned it, not as a session of its own.
 *
 * Two properties shape the reader. Events are appended in compressed frames,
 * so a live file ends mid-frame and a whole-file decompress fails outright;
 * frames are therefore decoded in order and the torn tail is dropped. And most
 * `user/message` events are not something the user typed — runtime context,
 * skill catalogs, approval notices and time snapshots all arrive that way, and
 * only `data.source.kind === "user"` marks a prompt. Reading them all turns one
 * turn into a wall of invented user messages.
 */

/** A session file's name: its format generation, compressed or not. */
const SESSION_FILE = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/;

/** How much of a transcript a listing decodes before it settles for what it has. */
const LISTING_BYTES = 256 * 1024;

function expandHome(p: string): string {
	return p.replace("~", homedir());
}

/** `$DSH_HOME`, else the harness's folder under the home directory. */
function dshRoot(): string {
	const configured = process.env.DSH_HOME;
	return configured ? expandHome(configured) : path.join(homedir(), ".dsh");
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function finiteMs(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

interface DshHeader {
	id?: string;
	cwd?: string;
	createdAt?: number;
	parentSession?: string;
	delegationDepth?: number;
}

function readHeader(text: string): DshHeader | undefined {
	const first = text.split("\n", 1)[0];
	if (!first) return undefined;
	let record: unknown;
	try {
		record = JSON.parse(first);
	} catch {
		return undefined;
	}
	if (!isRecord(record) || record.type !== "session") return undefined;
	return {
		id: stringField(record, "id"),
		cwd: stringField(record, "cwd"),
		createdAt: finiteMs(record.createdAt),
		parentSession: stringField(record, "parentSession"),
		delegationDepth: finiteMs(record.delegationDepth),
	};
}

/**
 * The newest generation of a session folder, and of its two encodings the one
 * written last — a compressed file lags its plain one by the batch in flight.
 */
async function sessionFile(dir: string): Promise<string | undefined> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return undefined;
	}
	let best: { path: string; generation: number; modified: number } | undefined;
	for (const name of names) {
		const match = SESSION_FILE.exec(name);
		if (!match) continue;
		const file = path.join(dir, name);
		let stats: Awaited<ReturnType<typeof fs.stat>>;
		try {
			stats = await fs.stat(file);
		} catch {
			continue;
		}
		if (!stats.isFile()) continue;
		const generation = Number(match[1] ?? 0);
		if (
			best &&
			(generation < best.generation || (generation === best.generation && stats.mtimeMs <= best.modified))
		) {
			continue;
		}
		best = { path: file, generation, modified: stats.mtimeMs };
	}
	return best?.path;
}

/**
 * Decode a session file's text, keeping what the decoder read before a torn
 * tail. Bun's whole-file zstd decoder rejects a file that ends mid-frame, which
 * is the normal state of a session still being written.
 */
async function readSessionText(file: string, maxBytes: number): Promise<string> {
	const raw = await Bun.file(file).bytes();
	if (!file.endsWith(".zstd")) return new TextDecoder().decode(raw.subarray(0, maxBytes));
	const chunks: Buffer[] = [];
	let total = 0;
	await new Promise<void>(resolve => {
		const decoder = zlib.createZstdDecompress();
		const finish = (): void => {
			decoder.destroy();
			resolve();
		};
		decoder.on("data", (chunk: Buffer) => {
			if (total >= maxBytes) return finish();
			chunks.push(chunk);
			total += chunk.length;
		});
		decoder.on("end", resolve);
		decoder.on("error", () => finish());
		decoder.end(Buffer.from(raw));
	});
	return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, maxBytes));
}

function recordsOf(text: string): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			// the final line of a bounded or live read is often incomplete
			continue;
		}
		if (isRecord(value)) out.push(value);
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

/** An event's payload, or an empty record for a line that carries none. */
function dataOf(record: Record<string, unknown>): Record<string, unknown> {
	return isRecord(record.data) ? record.data : {};
}

/**
 * A record's surface operation: `'append'`, or a replacement range.
 *
 * A v4 `surfaceOp: { op: 'replace', startSeq, endSeq }` states that this record
 * takes the place of everything the surface held from `startSeq` through
 * `endSeq`. Runtime-context injection and compaction both write it, so a reader
 * that appends unconditionally keeps the content that was replaced and then
 * also keeps what replaced it.
 */
function surfaceOpOf(record: Record<string, unknown>): SurfaceOp | undefined {
	const raw = record.surfaceOp ?? dataOf(record).surfaceOp;
	if (raw === "append") return { op: "append" };
	if (!isRecord(raw)) return undefined;
	if (raw.op !== "replace") return undefined;
	const startSeq = raw.startSeq;
	const endSeq = raw.endSeq;
	if (typeof startSeq !== "number" || typeof endSeq !== "number") return undefined;
	return { op: "replace", startSeq, endSeq };
}

/** One record's surface operation, as this reader needs it. */
type SurfaceOp =
	| { readonly op: "append" }
	| { readonly op: "replace"; readonly startSeq: number; readonly endSeq: number };

/** One message with the seq of the record that contributed it. */
export interface SurfaceNode {
	readonly seq: number;
	readonly message: UserMessage | AssistantMessage | ToolResultMessage;
}

/** Test hook: the fold without a filesystem, so its ordering rule is pinnable. */
export function applySurfaceOpsForTest(
	records: readonly Record<string, unknown>[],
	nodes: readonly SurfaceNode[],
): SurfaceNode[] {
	return applySurfaceOps(records, nodes);
}

/**
 * Fold recorded messages into the order the model actually saw.
 *
 * A replacement drops every node whose seq falls in its range and keeps the
 * replacing message wherever the range began, so a compacted region reads as its
 * summary rather than as the summary followed by the text it summarizes. A
 * range that names no recorded node (an unreadable or truncated record) is
 * ignored rather than guessed at: dropping nothing is the recoverable failure,
 * and the alternative drops content the range never identified.
 */
function applySurfaceOps(records: readonly Record<string, unknown>[], nodes: readonly SurfaceNode[]): SurfaceNode[] {
	const replacements: { at: number; startSeq: number; endSeq: number }[] = [];
	for (const record of records) {
		const op = surfaceOpOf(record);
		if (op?.op !== "replace") continue;
		const seq = record.seq;
		if (typeof seq !== "number") continue;
		replacements.push({ at: seq, startSeq: op.startSeq, endSeq: op.endSeq });
	}
	if (replacements.length === 0) return [...nodes];

	// Retired nodes are identified by seq, not by position, so a range still
	// applies when an unreadable record removed its neighbours from the surface.
	const retired = new Set<number>();
	for (const { startSeq, endSeq } of replacements) {
		for (const node of nodes) {
			if (node.seq >= startSeq && node.seq <= endSeq) retired.add(node.seq);
		}
	}
	return nodes.filter(node => !retired.has(node.seq));
}

function eventTimeMs(record: Record<string, unknown>): number | undefined {
	return finiteMs(record.time);
}

/**
 * A prompt the user typed. Everything else that arrives as `user/message` is
 * context the harness injects for the model, which the transcript already
 * carries as the assistant's and tools' own turns.
 */
function isUserPrompt(record: Record<string, unknown>): boolean {
	if (record.type !== "user/message") return false;
	const source = isRecord(dataOf(record).source) ? (dataOf(record).source as Record<string, unknown>) : undefined;
	return source?.kind === "user";
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

interface ContentBlocks {
	texts: string[];
	thinking: string[];
	images: ImageContent[];
}

/** One message's content, as text, reasoning and images. */
function contentBlocks(content: unknown): ContentBlocks {
	const out: ContentBlocks = { texts: [], thinking: [], images: [] };
	if (typeof content === "string") {
		out.texts.push(content);
		return out;
	}
	if (!Array.isArray(content)) return out;
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") out.texts.push(block.text);
		else if (block.type === "reasoning" && typeof block.text === "string") out.thinking.push(block.text);
		else if (block.type === "thinking" && typeof block.thinking === "string") out.thinking.push(block.thinking);
		else {
			const image = imageBlock(block);
			if (image) out.images.push(image);
		}
	}
	return out;
}

/** A tool call's arguments, which the source keeps as a JSON string. */
function toolArguments(raw: unknown): Record<string, unknown> {
	if (isRecord(raw)) return raw;
	if (typeof raw !== "string") return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

interface ConvertedMessage {
	user?: UserMessage;
	assistant?: AssistantMessage;
	toolResult?: ToolResultMessage;
	/** Tool calls this message makes, by id, for naming their results. */
	calls: ToolCall[];
}

/** One `user/message` event, when it is a prompt the user typed. */
function convertUser(record: Record<string, unknown>, fallbackTime: number): ConvertedMessage | undefined {
	if (!isUserPrompt(record)) return undefined;
	const data = dataOf(record);
	const blocks = contentBlocks(data.content);
	if (blocks.texts.length === 0 && blocks.images.length === 0) return undefined;
	const content: string | (TextContent | ImageContent)[] =
		blocks.images.length > 0
			? [
					...(blocks.texts.length > 0 ? [{ type: "text" as const, text: blocks.texts.join("\n") }] : []),
					...blocks.images,
				]
			: blocks.texts.join("\n");
	return {
		user: { role: "user", content, timestamp: eventTimeMs(record) ?? fallbackTime },
		calls: [],
	};
}

/** One `assistant/message` event; its content already names the tools it called. */
function convertAssistant(record: Record<string, unknown>, fallbackTime: number): ConvertedMessage | undefined {
	const message = isRecord(dataOf(record).message) ? (dataOf(record).message as Record<string, unknown>) : undefined;
	if (message?.role !== "assistant") return undefined;
	const source = isRecord(message.source) ? message.source : undefined;
	const blocks = contentBlocks(message.content);
	const calls: ToolCall[] = [];
	if (Array.isArray(message.content)) {
		for (const block of message.content) {
			if (!isRecord(block) || block.type !== "tool-call") continue;
			const name = stringField(block, "name");
			if (!name) continue;
			const rawId = stringField(block, "id");
			calls.push({
				type: "toolCall",
				id: rawId ?? `dsh-call-${calls.length}`,
				name,
				arguments: toolArguments(block.arguments),
			});
		}
	}
	if (blocks.thinking.length === 0 && blocks.texts.length === 0 && calls.length === 0) return undefined;
	const usage = isRecord(dataOf(record).usage) ? (dataOf(record).usage as Record<string, unknown>) : undefined;
	const input = finiteMs(usage?.inputTokens) ?? 0;
	const output = finiteMs(usage?.outputTokens) ?? 0;
	const cacheRead = finiteMs(usage?.cacheReadTokens) ?? 0;
	const cacheWrite = finiteMs(usage?.cacheWriteTokens) ?? 0;
	const totalTokens = finiteMs(usage?.totalTokens) ?? input + output + cacheRead + cacheWrite;
	const content: (TextContent | ThinkingContent | ToolCall)[] = [
		...blocks.thinking.map(text => ({ type: "thinking" as const, thinking: text })),
		...blocks.texts.map(text => ({ type: "text" as const, text })),
		...calls,
	];
	return {
		assistant: {
			role: "assistant",
			content,
			api: "dsh",
			provider: stringField(source, "provider") ?? "dsh",
			model: stringField(source, "model") ?? "unknown",
			usage: {
				input,
				output,
				cacheRead,
				cacheWrite,
				totalTokens,
				cost: { ...EMPTY_USAGE.cost },
			},
			stopReason: calls.length > 0 ? "toolUse" : "stop",
			timestamp: eventTimeMs(record) ?? fallbackTime,
		},
		calls,
	};
}

/** One `tool/result` event, naming the tool from the call it answers. */
function convertToolResult(
	record: Record<string, unknown>,
	fallbackTime: number,
	toolNames: Map<string, string>,
): ConvertedMessage | undefined {
	const message = isRecord(dataOf(record).message) ? (dataOf(record).message as Record<string, unknown>) : undefined;
	if (!message) return undefined;
	const toolCallId = stringField(message, "toolCallId") ?? stringField(message, "callId");
	if (!toolCallId) return undefined;
	const blocks = contentBlocks(message.content);
	const content: (TextContent | ImageContent)[] = [
		...blocks.texts.map(text => ({ type: "text" as const, text })),
		...blocks.images,
	];
	if (content.length === 0) return undefined;
	return {
		toolResult: {
			role: "toolResult",
			toolCallId,
			toolName: toolNames.get(toolCallId) ?? "tool",
			content,
			isError: message.isError === true,
			timestamp: eventTimeMs(record) ?? fallbackTime,
		},
		calls: [],
	};
}

/** The name a session gives itself, from the last title event it wrote. */
function titleOf(records: readonly Record<string, unknown>[]): string | undefined {
	let title: string | undefined;
	for (const record of records) {
		if (record.type !== "session/title") continue;
		const next = stringField(dataOf(record), "title");
		if (next) title = next;
	}
	return title;
}

/** Whitespace-collapsed first line of a prompt, as a picker shows it. */
function promptPreview(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** DeepSeek Harness session store over its per-session folders. */
export class DshSessionStore implements ForeignSessionStore {
	readonly source = "dsh";
	readonly #root: string;

	constructor(root: string = dshRoot()) {
		this.#root = root;
	}

	async list(): Promise<ForeignSessionInfo[]> {
		const root = path.join(this.#root, "sessions");
		let projects: string[];
		try {
			projects = await fs.readdir(root);
		} catch {
			return [];
		}
		const sessions: ForeignSessionInfo[] = [];
		for (const project of projects) {
			if (project.startsWith(".")) continue;
			let entries: string[];
			try {
				entries = await fs.readdir(path.join(root, project));
			} catch {
				continue;
			}
			for (const entry of entries) {
				const dir = path.join(root, project, entry);
				try {
					const info = await this.#describe(dir);
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

	async #describe(dir: string): Promise<ForeignSessionInfo | undefined> {
		const file = await sessionFile(dir);
		if (!file) return undefined;
		const text = await readSessionText(file, LISTING_BYTES);
		const header = readHeader(text);
		if (!header?.id) return undefined;
		// A subagent runs in its own folder but belongs to the session that
		// spawned it; counting it separately would invent sessions.
		if ((header.delegationDepth ?? 0) > 0) return undefined;

		let stats: Awaited<ReturnType<typeof fs.stat>>;
		try {
			stats = await fs.stat(file);
		} catch {
			return undefined;
		}
		const records = recordsOf(text);
		let firstMessage: string | undefined;
		let messageCount = 0;
		let lastTime = 0;
		for (const record of records) {
			const ts = eventTimeMs(record);
			if (ts !== undefined) lastTime = Math.max(lastTime, ts);
			if (isUserPrompt(record)) {
				messageCount += 1;
				if (!firstMessage) {
					const texts = contentBlocks(dataOf(record).content).texts;
					if (texts.length > 0) firstMessage = promptPreview(texts.join(" "));
				}
				continue;
			}
			if (record.type === "assistant/message") messageCount += 1;
		}
		const created = header.createdAt ?? stats.birthtimeMs ?? stats.mtimeMs;
		return {
			source: this.source,
			id: header.id,
			path: dir,
			cwd: header.cwd ?? path.basename(path.dirname(dir)),
			title: titleOf(records),
			created: new Date(created),
			modified: new Date(Math.max(stats.mtimeMs, created, lastTime)),
			firstMessage,
			messageCount,
		};
	}

	async load(info: ForeignSessionInfo): Promise<SessionManager> {
		if (info.source !== this.source) throw new Error(`Cannot load ${info.source} session with this store`);
		const file = await sessionFile(info.path);
		if (!file) throw new Error(`Session ${info.id} has no readable transcript`);
		const text = await readSessionText(file, Number.POSITIVE_INFINITY);
		const header = readHeader(text);
		const records = recordsOf(text);
		if (records.length === 0) throw new Error(`Session ${info.id} contains no readable records`);

		const manager = SessionManager.inMemory(header?.cwd ?? info.cwd);
		const usedIds = new Set<string>();
		const toolNames = new Map<string, string>();
		let synthetic = 0;
		let fallbackTime = info.created.getTime();

		/**
		 * Messages in surface order, with the seq that produced each one.
		 *
		 * The order is decided after reading every record, because a later
		 * `surfaceOp: replace` retires messages an earlier record contributed.
		 * Appending as we read would leave both the retired and the replacing
		 * message in the transcript.
		 */
		const surface: { seq: number; message: UserMessage | AssistantMessage | ToolResultMessage }[] = [];

		/** Record one converted message at its source seq. */
		const push = (record: Record<string, unknown>, converted: ConvertedMessage): void => {
			const message = converted.user ?? converted.assistant ?? converted.toolResult;
			if (!message) return;
			for (const call of converted.calls) toolNames.set(call.id, call.name);
			fallbackTime = Math.max(fallbackTime + 1, message.timestamp);
			const seq = typeof record.seq === "number" ? record.seq : -1;
			surface.push({ seq, message });
		};

		for (const record of records) {
			if (record.type === "tool/call") {
				const data = dataOf(record);
				const callId = stringField(data, "callId");
				const name = stringField(data, "name");
				if (callId && name && !toolNames.has(callId)) toolNames.set(callId, name);
			} else if (record.type === "assistant/message") {
				const converted = convertAssistant(record, fallbackTime);
				if (converted) push(record, converted);
			} else if (record.type === "tool/result") {
				const converted = convertToolResult(record, fallbackTime, toolNames);
				if (converted) push(record, converted);
			} else if (isUserPrompt(record)) {
				const converted = convertUser(record, fallbackTime);
				if (converted) push(record, converted);
			}
		}

		let parentId: string | null = null;
		for (const entry of applySurfaceOps(records, surface)) {
			const id = uniqueEntryId(`dsh-${synthetic++}`, usedIds);
			const timestamp = new Date(entry.message.timestamp).toISOString();
			const message: SessionMessageEntry = { type: "message", id, parentId, timestamp, message: entry.message };
			manager.ingestReplicatedEntry(message);
			parentId = id;
		}

		const title = titleOf(records) ?? info.title;
		if (title) await manager.setSessionName(title, "auto");
		return manager;
	}
}
