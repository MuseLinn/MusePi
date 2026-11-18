import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import type { AssistantMessage, TextContent, ThinkingContent, ToolCall, UserMessage } from "@musepi/pi-ai";
import { isRecord } from "@musepi/pi-utils";
import type { ForeignSessionInfo, ForeignSessionStore } from "./foreign-session-store";
import { SessionManager } from "./session-manager";

/**
 * CodeBuddy Code (Tencent) keeps sessions as WorkBuddy does, under its
 * folder's `projects/<encoded-cwd>/`: one `<session id>.jsonl` per session,
 * beside a `<session id>/` folder holding that session's tool output. Lines
 * are the OpenAI Agents SDK's items — a `session-meta` first, then `message`
 * with `role` and `content[]` blocks — plus `ai-title` / `custom-title`
 * records when the session was named.
 *
 * A user message's `input_text` blocks also carry what the CLI wrote beside
 * the typed words (`<system-reminder>` caveats, `/model` command echoes);
 * those are not prompts.
 */

function expandHome(p: string): string {
	return p.replace("~", homedir());
}

/** `$CODEBUDDY_CONFIG_DIR`, else `~/.codebuddy`. */
function codebuddyRoot(): string {
	const configured = process.env.CODEBUDDY_CONFIG_DIR;
	return configured ? expandHome(configured) : path.join(homedir(), ".codebuddy");
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Blocks a user message carries that the CLI injected rather than the user typing. */
const INJECTED_PREFIXES = [
	"<system-reminder",
	"<command-caveat",
	"<user_shell_command",
	"<environment_context",
	// A slash command and what it printed: the CLI writes both as a user
	// message, but neither is something the user typed as a prompt.
	"<command-name",
	"<command-args",
	"<command-message",
	"<local-command-stdout",
	"<local-command-stderr",
];

function isInjectedText(text: string): boolean {
	const trimmed = text.trimStart();
	return INJECTED_PREFIXES.some(prefix => trimmed.startsWith(prefix));
}

function promptPreview(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * The words a user message typed: its text blocks, less what the CLI put in
 * beside them. A message left with nothing is a command echo, not a prompt.
 */
function promptOf(content: unknown): string | undefined {
	if (typeof content === "string") return isInjectedText(content) ? undefined : content;
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		const type = stringField(block, "type");
		if (type !== "input_text" && type !== "text") continue;
		const text = stringField(block, "text");
		if (!text || isInjectedText(text)) continue;
		parts.push(text);
	}
	const joined = parts.join("\n").trim();
	return joined.length > 0 ? joined : undefined;
}

interface CodebuddyBlocks {
	texts: string[];
	thinking: string[];
	tools: { id?: string; name?: string; input?: Record<string, unknown> }[];
}

function collectBlocks(record: Record<string, unknown>): CodebuddyBlocks {
	const out: CodebuddyBlocks = { texts: [], thinking: [], tools: [] };
	const content = record.content;
	if (typeof content === "string") {
		if (!isInjectedText(content)) out.texts.push(content);
		return out;
	}
	if (!Array.isArray(content)) return out;
	for (const block of content) {
		if (!isRecord(block)) continue;
		const type = stringField(block, "type");
		if (type === "input_text" || type === "output_text" || type === "text") {
			const text = stringField(block, "text");
			if (text && !isInjectedText(text)) out.texts.push(text);
		} else if (type === "reasoning" || type === "thinking") {
			const text = stringField(block, "text") ?? stringField(block, "summary");
			if (text) out.thinking.push(text);
		} else if (type === "function_call" || type === "tool_call" || type === "tool_use") {
			const args = callArguments(block);
			out.tools.push({
				id: stringField(block, "call_id") ?? stringField(block, "id"),
				name: stringField(block, "name"),
				input: args,
			});
		}
	}
	return out;
}

function callArguments(block: Record<string, unknown>): Record<string, unknown> {
	const raw = block.arguments ?? block.input;
	if (isRecord(raw)) return raw;
	if (typeof raw !== "string") return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** A record's own time: epoch milliseconds. */
function recordTimeMs(record: Record<string, unknown>): number | undefined {
	return numberField(record, "timestamp");
}

async function readRecords(file: string): Promise<Record<string, unknown>[]> {
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

/** CodeBuddy Code session store over its `projects/<cwd>/` folders. */
export class CodebuddySessionStore implements ForeignSessionStore {
	readonly source = "codebuddy";
	readonly #root: string;

	constructor(root: string = codebuddyRoot()) {
		this.#root = root;
	}

	async list(): Promise<ForeignSessionInfo[]> {
		const root = path.join(this.#root, "projects");
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
				const dirents = await fs.readdir(path.join(root, project), { withFileTypes: true });
				entries = dirents.filter(entry => entry.isFile() && entry.name.endsWith(".jsonl")).map(entry => entry.name);
			} catch {
				continue;
			}
			for (const entry of entries) {
				try {
					const info = await this.#describe(path.join(root, project, entry));
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

	async #describe(file: string): Promise<ForeignSessionInfo | undefined> {
		const stats = await fs.stat(file);
		let created = stats.birthtimeMs || stats.mtimeMs;
		let modified = stats.mtimeMs;
		let cwd: string | undefined;
		let title: string | undefined;
		let customTitle: string | undefined;
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
				const ts = recordTimeMs(record);
				if (ts !== undefined) {
					created = Math.min(created, ts);
					modified = Math.max(modified, ts);
				}
				cwd ??= stringField(record, "cwd");
				const type = stringField(record, "type");
				if (type === "custom-title") customTitle = stringField(record, "customTitle") ?? customTitle;
				else if (type === "ai-title") title = stringField(record, "aiTitle") ?? title;
				else if (type === "message" && record.role === "user") {
					messageCount += 1;
					if (!firstMessage) {
						const prompt = promptOf(record.content);
						if (prompt) firstMessage = promptPreview(prompt);
					}
				}
			}
		} finally {
			await handle.close();
		}
		return {
			source: this.source,
			id: path.basename(file, ".jsonl"),
			path: file,
			// A project folder name is a path with separators and the drive colon turned
			// into `-`, so it is a label, not a directory; only records state the cwd.
			cwd: cwd ?? "",
			// A title the user gave wins over the one the CLI generated.
			// A session named by neither the user nor the CLI is labelled by the
			// first thing typed in it, so a picker row is never a bare id.
			title: customTitle ?? title ?? firstMessage,
			created: new Date(created),
			modified: new Date(modified),
			firstMessage,
			messageCount,
		};
	}

	async load(info: ForeignSessionInfo): Promise<SessionManager> {
		if (info.source !== this.source) throw new Error(`Cannot load ${info.source} session with this store`);
		const records = await readRecords(info.path);
		if (records.length === 0) throw new Error(`Session ${info.id} contains no readable records`);

		let cwd = info.cwd;
		let customTitle: string | undefined;
		let title: string | undefined;
		for (const record of records) {
			cwd = stringField(record, "cwd") ?? cwd;
			const type = stringField(record, "type");
			if (type === "custom-title") customTitle = stringField(record, "customTitle") ?? customTitle;
			else if (type === "ai-title") title = stringField(record, "aiTitle") ?? title;
		}

		const manager = SessionManager.inMemory(cwd);
		const usedIds = new Set<string>();
		const toolNames = new Map<string, string>();
		let parentId: string | null = null;
		let synthetic = 0;

		for (const record of records) {
			const type = stringField(record, "type");
			if (type !== "message") continue;
			const role = stringField(record, "role");
			const ts = recordTimeMs(record) ?? Date.now();
			const timestamp = new Date(ts).toISOString();
			const blocks = collectBlocks(record);
			if (role === "user") {
				const prompt = promptOf(record.content);
				if (!prompt) continue;
				const message: UserMessage = { role: "user", content: prompt, timestamp: ts };
				const id = uniqueEntryId(`cb-${synthetic++}`, usedIds);
				manager.ingestReplicatedEntry({ type: "message", id, parentId, timestamp, message });
				parentId = id;
				continue;
			}
			if (role !== "assistant") continue;
			const content: (TextContent | ThinkingContent | ToolCall)[] = [
				...blocks.thinking.map(text => ({ type: "thinking" as const, thinking: text })),
				...blocks.texts.map(text => ({ type: "text" as const, text })),
				...blocks.tools.map(tool => {
					const id = tool.id ?? `cb-call-${synthetic}`;
					if (tool.name) toolNames.set(id, tool.name);
					return { type: "toolCall" as const, id, name: tool.name ?? "tool", arguments: tool.input ?? {} };
				}),
			];
			if (content.length === 0) continue;
			const providerData = isRecord(record.providerData) ? record.providerData : undefined;
			const message: AssistantMessage = {
				role: "assistant",
				content,
				api: "codebuddy",
				provider: "codebuddy",
				model:
					(providerData
						? (stringField(providerData, "model") ?? stringField(providerData, "requestModelId"))
						: undefined) ?? "unknown",
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
			const id = uniqueEntryId(`cb-${synthetic++}`, usedIds);
			manager.ingestReplicatedEntry({ type: "message", id, parentId, timestamp, message });
			parentId = id;
		}

		const name = customTitle ?? title ?? info.title;
		if (name) await manager.setSessionName(name, customTitle ? "user" : "auto");
		return manager;
	}
}
