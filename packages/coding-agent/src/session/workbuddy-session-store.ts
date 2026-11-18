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
	Usage,
	UserMessage,
} from "@musepi/pi-ai";
import { isRecord } from "@musepi/pi-utils";
import type { ForeignSessionInfo, ForeignSessionStore } from "./foreign-session-store";
import type { SessionMessageEntry } from "./session-entries";
import { SessionManager } from "./session-manager";

/**
 * WorkBuddy keeps its sessions the way Claude Code does: one
 * `<id>.jsonl` per session under `<config>/projects/<project>/`, with an
 * optional `<id>.meta.json` beside it carrying the cwd of a session brought
 * over from its older history. Lines are OpenAI Agents SDK items —
 * `message`, `reasoning`, `function_call`, `function_call_result` — plus
 * `ai-title` / `custom-title`, each stamped in milliseconds.
 *
 * Three shapes decide what an import looks like:
 * - Everything one reply did carries the same `providerData.messageId`
 *   (reasoning, text, its tool calls), and each line repeats the reply's
 *   `providerData.usage`. Importing line by line would split a reply into
 *   several assistant messages and count its tokens once per call.
 * - A real prompt is wrapped in `<user_query>` inside a user message that
 *   also carries reminders and task notifications, so the message's own
 *   blocks are not the prompt and the harness's notices are not turns.
 * - A subagent runs as `<id>/subagents/agent-<uuid>.jsonl`, beside the
 *   session it belongs to. It is the session's work, not a session: listing
 *   it as one invents conversations the user never opened.
 */

/** `$WORKBUDDY_CONFIG_DIR`, else `~/.workbuddy`. */
function workbuddyRoot(): string {
	const configured = process.env.WORKBUDDY_CONFIG_DIR;
	if (configured?.trim()) return configured.replace("~", homedir());
	return path.join(homedir(), ".workbuddy");
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Bytes read from a session file to list it: the title, the first prompt, the span. */
const WORKBUDDY_HEAD_BYTES = 256 * 1024;

const USER_QUERY = /<user_query>([\s\S]*?)<\/user_query>/;
/** A block the harness wrote beside the prompt (`<system-reminder>`, `<task-notification>`). */
const HARNESS_BLOCK = /^\s*</;
/** WorkBuddy's own reference to a scene its prompt is attached to. */
const SCENE_REF = /^@[\w-]+:\S*$/;

function promptPreview(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

type ContentBlock = Record<string, unknown>;

function contentBlocks(record: Record<string, unknown>): ContentBlock[] {
	const content = record.content;
	if (!Array.isArray(content)) return [];
	return content.filter(isRecord);
}

/**
 * What the user typed: the `<user_query>` a message wraps it in, else the
 * blocks that are not harness text. A message holding only reminders and
 * notifications is the harness talking to the agent, not a turn.
 */
function promptText(record: Record<string, unknown>): string | undefined {
	const parts: string[] = [];
	for (const block of contentBlocks(record)) {
		if (block.type !== "input_text" && block.type !== "text") continue;
		const text = typeof block.text === "string" ? block.text.trim() : "";
		if (!text) continue;
		const query = USER_QUERY.exec(text);
		if (query) {
			parts.push(query[1].trim());
			continue;
		}
		if (HARNESS_BLOCK.test(text) || SCENE_REF.test(text)) continue;
		parts.push(text);
	}
	const joined = parts
		.filter(part => part.length > 0)
		.join("\n")
		.trim();
	return joined.length > 0 ? joined : undefined;
}

/** Inline images a message carries; a blob reference points at a file and is left out. */
function inlineImages(record: Record<string, unknown>): ImageContent[] {
	const images: ImageContent[] = [];
	for (const block of contentBlocks(record)) {
		if (block.type !== "image") continue;
		const source = isRecord(block.source) ? block.source : undefined;
		const data = stringField(block, "data") ?? (source ? stringField(source, "data") : undefined);
		const mimeType =
			stringField(block, "mimeType") ??
			(source ? (stringField(source, "media_type") ?? stringField(source, "mime_type")) : undefined);
		if (data && mimeType) images.push({ type: "image", data, mimeType });
	}
	return images;
}

/** The reply this line is part of; lines without one stand on their own. */
function replyId(record: Record<string, unknown>): string | undefined {
	const providerData = isRecord(record.providerData) ? record.providerData : undefined;
	return providerData ? stringField(providerData, "messageId") : undefined;
}

function replyModel(record: Record<string, unknown>): string | undefined {
	const providerData = isRecord(record.providerData) ? record.providerData : undefined;
	if (!providerData) return undefined;
	return stringField(providerData, "model") ?? stringField(providerData, "requestModelId");
}

function lineTimeMs(record: Record<string, unknown>): number | undefined {
	return numberField(record, "timestamp");
}

function cachedTokens(details: unknown): number {
	if (!Array.isArray(details)) return 0;
	let total = 0;
	for (const detail of details) {
		if (isRecord(detail)) total += numberField(detail, "cached_tokens") ?? 0;
	}
	return total;
}

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * A reply's token accounting. `providerData.usage` names the current fields
 * (`inputTokens`, `inputTokensDetails[].cached_tokens`); a session brought
 * over from WorkBuddy's older history has `input_tokens` and
 * `cache_read_input_tokens` both there and under `message.usage`. The
 * reported input includes what was read from the cache, so the cache buckets
 * come out of it rather than being added on top.
 */
function replyUsage(record: Record<string, unknown>): Usage | undefined {
	const providerData = isRecord(record.providerData) ? record.providerData : undefined;
	const legacy = isRecord(record.message) && isRecord(record.message.usage) ? record.message.usage : undefined;
	const usage = providerData && isRecord(providerData.usage) ? providerData.usage : legacy;
	if (!usage) return undefined;
	const rawInput = numberField(usage, "inputTokens") ?? numberField(usage, "input_tokens") ?? 0;
	const output = numberField(usage, "outputTokens") ?? numberField(usage, "output_tokens") ?? 0;
	const details = cachedTokens(usage.inputTokensDetails) + cachedTokens(usage.input_tokens_details);
	const cacheRead = details > 0 ? details : (numberField(usage, "cache_read_input_tokens") ?? 0);
	const cacheWrite =
		numberField(usage, "cacheCreationTokens") ??
		numberField(usage, "cache_creation_input_tokens") ??
		numberField(usage, "prompt_cache_write_tokens") ??
		0;
	const input = Math.max(0, rawInput - cacheRead - cacheWrite);
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/**
 * What a reply thought. WorkBuddy writes it to `rawContent` as
 * `reasoning_text` blocks; a `content` block of either kind is read the same
 * way, but `input_text` there is context handed back to the model, not
 * reasoning.
 */
function reasoningText(record: Record<string, unknown>): string | undefined {
	const parts: string[] = [];
	const sources = [record.rawContent, record.content];
	for (const source of sources) {
		if (!Array.isArray(source)) continue;
		for (const block of source) {
			if (!isRecord(block)) continue;
			if ((block.type === "reasoning_text" || block.type === "text") && typeof block.text === "string") {
				parts.push(block.text);
			}
		}
	}
	const joined = parts.join("\n");
	return joined.length > 0 ? joined : undefined;
}

function assistantText(record: Record<string, unknown>): string | undefined {
	const parts: string[] = [];
	for (const block of contentBlocks(record)) {
		if ((block.type === "output_text" || block.type === "text") && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	const joined = parts.join("\n");
	return joined.length > 0 ? joined : undefined;
}

function callArguments(value: unknown): Record<string, unknown> {
	if (isRecord(value)) return value;
	if (typeof value !== "string") return {};
	try {
		const parsed: unknown = JSON.parse(value);
		return isRecord(parsed) ? parsed : {};
	} catch {
		// Arguments kept as text: the call still names its tool.
		return {};
	}
}

/** What a tool answered: its text, the texts of its blocks, or the value as JSON. */
function resultText(output: unknown): string | undefined {
	if (typeof output === "string") return output.length > 0 ? output : undefined;
	if (Array.isArray(output)) {
		const parts: string[] = [];
		for (const block of output) {
			if (isRecord(block) && typeof block.text === "string") parts.push(block.text);
		}
		return parts.length > 0 ? parts.join("\n") : undefined;
	}
	if (isRecord(output)) {
		if (typeof output.text === "string") return output.text.length > 0 ? output.text : undefined;
		const content = output.content;
		if (typeof content === "string") return content;
		return JSON.stringify(output);
	}
	return undefined;
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

async function readMetaCwd(file: string): Promise<string | undefined> {
	try {
		const parsed: unknown = await Bun.file(`${file.slice(0, -".jsonl".length)}.meta.json`).json();
		return isRecord(parsed) ? stringField(parsed, "cwd") : undefined;
	} catch {
		return undefined;
	}
}

function uniqueEntryId(base: string, used: Set<string>): string {
	let candidate = base;
	let i = 1;
	while (used.has(candidate)) candidate = `${base}-${++i}`;
	used.add(candidate);
	return candidate;
}

interface WorkbuddyNames {
	/** The name WorkBuddy made up. */
	title?: string;
	/** The name the user gave it, which wins. */
	customTitle?: string;
}

/** A session file's names, its cwd and its span, read from its head. */
interface WorkbuddyHead {
	cwd?: string;
	created: number;
	modified: number;
	firstMessage?: string;
	messageCount: number;
	names: WorkbuddyNames;
}

async function readHead(file: string): Promise<WorkbuddyHead> {
	const stats = await fs.stat(file);
	let created = stats.birthtimeMs || stats.mtimeMs;
	let modified = stats.mtimeMs;
	let cwd: string | undefined;
	let firstMessage: string | undefined;
	let messageCount = 0;
	const names: WorkbuddyNames = {};
	let bytes = 0;
	const handle = await fs.open(file, "r");
	try {
		for await (const line of handle.readLines()) {
			bytes += line.length + 1;
			if (bytes > WORKBUDDY_HEAD_BYTES) break;
			let record: Record<string, unknown>;
			try {
				record = JSON.parse(line) as Record<string, unknown>;
			} catch {
				continue;
			}
			const ts = lineTimeMs(record);
			if (ts !== undefined) {
				created = Math.min(created, ts);
				modified = Math.max(modified, ts);
			}
			cwd ??= stringField(record, "cwd");
			if (record.type === "custom-title")
				names.customTitle = stringField(record, "customTitle") ?? names.customTitle;
			else if (record.type === "ai-title") names.title = stringField(record, "aiTitle") ?? names.title;
			if (record.type !== "message") continue;
			messageCount += 1;
			if (!firstMessage && record.role === "user") firstMessage = promptText(record);
		}
	} finally {
		await handle.close();
	}
	return { cwd, created, modified, firstMessage, messageCount, names };
}

/** One reply of a conversation: what it thought, said and asked for. */
interface WorkbuddyReply {
	readonly id: string;
	timestamp: number;
	model?: string;
	thinking: string[];
	texts: string[];
	calls: ToolCall[];
	usage?: Usage;
}

/** WorkBuddy session store over its per-project session files. */
export class WorkbuddySessionStore implements ForeignSessionStore {
	readonly source = "workbuddy";
	readonly #root: string;

	constructor(root: string = workbuddyRoot()) {
		this.#root = root;
	}

	async list(): Promise<ForeignSessionInfo[]> {
		const sessions: ForeignSessionInfo[] = [];
		for (const file of await this.#sessionFiles()) {
			try {
				sessions.push(await this.#describe(file));
			} catch {
				// a session being written or removed mid-scan is skipped
			}
		}
		return sessions.sort(
			(left, right) => right.modified.getTime() - left.modified.getTime() || left.path.localeCompare(right.path),
		);
	}

	/** Every session file under `projects/`, however deep, less the subagents'. */
	async #sessionFiles(): Promise<string[]> {
		const projects = path.join(this.#root, "projects");
		const files: string[] = [];
		try {
			for await (const name of new Bun.Glob("**/*.jsonl").scan(projects)) {
				const file = path.join(projects, name);
				const segments = name.split(/[\\/]/);
				if (segments.includes("subagents")) continue;
				files.push(file);
			}
		} catch {
			return [];
		}
		return files;
	}

	async #describe(file: string): Promise<ForeignSessionInfo> {
		const head = await readHead(file);
		const cwd = head.cwd ?? (await readMetaCwd(file)) ?? "";
		const title = head.names.customTitle ?? head.names.title;
		return {
			source: this.source,
			id: path.basename(file, ".jsonl"),
			path: file,
			cwd,
			title,
			created: new Date(head.created),
			modified: new Date(head.modified),
			firstMessage: head.firstMessage,
			messageCount: head.messageCount,
		};
	}

	async load(info: ForeignSessionInfo): Promise<SessionManager> {
		if (info.source !== this.source) throw new Error(`Cannot load ${info.source} session with this store`);
		const records = await readLines(info.path);
		if (records.length === 0) throw new Error(`Session ${info.id} contains no readable records`);

		let cwd: string | undefined;
		const names: WorkbuddyNames = {};
		for (const record of records) {
			cwd ??= stringField(record, "cwd");
			if (record.type === "custom-title")
				names.customTitle = stringField(record, "customTitle") ?? names.customTitle;
			else if (record.type === "ai-title") names.title = stringField(record, "aiTitle") ?? names.title;
		}
		const manager = SessionManager.inMemory(cwd ?? info.cwd);

		const usedIds = new Set<string>();
		const toolNames = new Map<string, string>();
		const replies = new Map<string, WorkbuddyReply>();
		let parentId: string | null = null;
		let synthetic = 0;
		/** The reply being gathered; its lines are contiguous in practice, but a
		 * line that resumes another one still has to close this first. */
		let pending: WorkbuddyReply | undefined;

		const append = (message: UserMessage | AssistantMessage | ToolResultMessage, timestamp: number): void => {
			const iso = new Date(timestamp).toISOString();
			const id = uniqueEntryId(`workbuddy-${synthetic++}`, usedIds);
			const entry: SessionMessageEntry = { type: "message", id, parentId, timestamp: iso, message };
			manager.ingestReplicatedEntry(entry);
			parentId = id;
		};
		/** Emit the reply being gathered as the one assistant message it was. */
		const flush = (): void => {
			const reply = pending;
			pending = undefined;
			if (!reply) return;
			const content: (TextContent | ThinkingContent | ToolCall)[] = [
				...reply.thinking.map(text => ({ type: "thinking" as const, thinking: text })),
				...reply.texts.map(text => ({ type: "text" as const, text })),
				...reply.calls,
			];
			if (content.length === 0) return;
			append(
				{
					role: "assistant",
					content,
					api: "workbuddy",
					provider: "workbuddy",
					model: reply.model ?? "unknown",
					usage: reply.usage ?? EMPTY_USAGE,
					stopReason: "stop",
					timestamp: reply.timestamp,
				},
				reply.timestamp,
			);
		};

		let line = 0;
		for (const record of records) {
			line += 1;
			const ts = lineTimeMs(record) ?? Date.now();
			if (record.type === "message" && record.role === "user") {
				flush();
				const text = promptText(record);
				const images = inlineImages(record);
				if (!text && images.length === 0) continue;
				const content: string | (TextContent | ImageContent)[] = !text
					? images
					: images.length > 0
						? [{ type: "text" as const, text }, ...images]
						: text;
				append({ role: "user", content, timestamp: ts }, ts);
				continue;
			}
			if (record.type === "function_call_result") {
				flush();
				const text = resultText(record.output);
				if (!text) continue;
				const callId = stringField(record, "callId") ?? "";
				append(
					{
						role: "toolResult",
						toolCallId: callId,
						toolName: stringField(record, "name") ?? toolNames.get(callId) ?? "tool",
						content: [{ type: "text", text }],
						isError: record.status !== undefined && record.status !== "completed",
						timestamp: ts,
					},
					ts,
				);
				continue;
			}
			if (record.type !== "reasoning" && record.type !== "function_call" && record.type !== "message") continue;
			if (record.type === "message" && record.role !== "assistant") continue;

			const id = replyId(record) ?? `line-${line}`;
			let reply = replies.get(id);
			if (!reply) {
				reply = { id, timestamp: ts, thinking: [], texts: [], calls: [] };
				replies.set(id, reply);
			}
			if (pending !== reply) {
				flush();
				pending = reply;
			}
			reply.model ??= replyModel(record);
			reply.usage ??= replyUsage(record);
			if (record.type === "reasoning") {
				const thinking = reasoningText(record);
				if (thinking) reply.thinking.push(thinking);
			} else if (record.type === "message") {
				const text = assistantText(record);
				if (text) reply.texts.push(text);
			} else {
				const callId = stringField(record, "callId");
				const name = stringField(record, "name") ?? "tool";
				if (callId) toolNames.set(callId, name);
				reply.calls.push({
					type: "toolCall",
					id: callId ?? `workbuddy-call-${synthetic}`,
					name,
					arguments: callArguments(record.arguments),
				});
			}
		}
		flush();

		const title = names.customTitle ?? names.title ?? info.title;
		if (title) await manager.setSessionName(title, names.customTitle ? "user" : "auto");
		return manager;
	}
}
