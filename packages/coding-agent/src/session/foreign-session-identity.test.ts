import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CodexSessionStore } from "./codex-session-store";
import { persistForeignSession } from "./foreign-session-import";
import { KimiSessionStore } from "./kimi-session-store";
import { OpencodeSessionStore } from "./opencode-session-store";
import { SdkCompatSessionStore } from "./sdk-compat-session-store";

/**
 * These cover the picker-visible contract of an imported session: the
 * workspace it is filed under and the name it is listed by. Both come from
 * the source's own record — a slug or a file name is a lossy stand-in that
 * made every imported row look alike.
 */

let tempRoot: string;

beforeEach(async () => {
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-foreign-identity-"));
});

afterEach(async () => {
	await fs.rm(tempRoot, { recursive: true, force: true });
});

async function writeJsonl(filePath: string, records: Record<string, unknown>[]): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await Bun.write(filePath, `${records.map(record => JSON.stringify(record)).join("\n")}\n`);
}

/** A session file as MusePi writes it: title slot, then the session header. */
function musepiRecords(cwd: string, title: string): Record<string, unknown>[] {
	return [
		{ type: "title", v: 1, title, source: "auto", updatedAt: "2026-01-01T00:00:00.000Z", pad: "" },
		{
			type: "session",
			version: 3,
			id: "01a1d5ba-a8f1-71f3-a247-6688e81c9d9b",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd,
			title,
			titleSource: "auto",
		},
		{
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "user", content: [{ type: "text", text: "hello there" }] },
		},
	];
}

describe("SdkCompatSessionStore identity", () => {
	it("takes cwd and title from the session header, not the folder slug", async () => {
		const root = path.join(tempRoot, "sessions");
		const cwd = path.join(tempRoot, "some", "project");
		const file = path.join(root, "--encoded-slug--", "2026-01-01T00-00-00-000Z_01a1d5ba.jsonl");
		await writeJsonl(file, musepiRecords(cwd, "Named by the agent"));

		const [info] = await new SdkCompatSessionStore("omp", [root]).list();

		expect(info?.cwd).toBe(cwd);
		expect(info?.title).toBe("Named by the agent");
	});

	it("loads entries into the header's working directory", async () => {
		const root = path.join(tempRoot, "sessions");
		const cwd = path.join(tempRoot, "some", "project");
		const file = path.join(root, "--encoded-slug--", "2026-01-01T00-00-00-000Z_01a1d5ba.jsonl");
		await writeJsonl(file, musepiRecords(cwd, "Named by the agent"));
		const store = new SdkCompatSessionStore("omp", [root]);
		const info = (await store.list())[0];
		if (!info) throw new Error("fixture was not listed");

		const manager = await store.load(info);

		expect(manager.getCwd()).toBe(cwd);
		expect(manager.getSessionName()).toBe("Named by the agent");
	});

	it("imports into the source workspace instead of the fallback", async () => {
		const root = path.join(tempRoot, "sessions");
		const cwd = path.join(tempRoot, "some", "project");
		await fs.mkdir(cwd, { recursive: true });
		const fallback = path.join(tempRoot, "fallback");
		await fs.mkdir(fallback, { recursive: true });
		const file = path.join(root, "--encoded-slug--", "2026-01-01T00-00-00-000Z_01a1d5ba.jsonl");
		await writeJsonl(file, musepiRecords(cwd, "Named by the agent"));
		const store = new SdkCompatSessionStore("omp", [root]);
		const info = (await store.list())[0];
		if (!info) throw new Error("fixture was not listed");

		const imported = await persistForeignSession(store, info, {
			fallbackCwd: fallback,
			sessionDir: path.join(tempRoot, "out"),
			suppressBreadcrumb: true,
		});

		expect(imported.getCwd()).toBe(cwd);
		expect(imported.getSessionName()).toBe("Named by the agent");
		await imported.close();
	});

	it("falls back to the title slot when the header carries no title", async () => {
		const root = path.join(tempRoot, "sessions");
		const cwd = path.join(tempRoot, "project");
		const records = musepiRecords(cwd, "");
		records[1] = { type: "session", version: 3, id: "s", timestamp: "2026-01-01T00:00:00.000Z", cwd };
		await writeJsonl(path.join(root, "slug", "s.jsonl"), records);

		const [info] = await new SdkCompatSessionStore("omp", [root]).list();

		expect(info?.title).toBeUndefined();
		expect(info?.cwd).toBe(cwd);
	});

	it("prefers the title slot over a stale header title", async () => {
		const root = path.join(tempRoot, "sessions");
		const cwd = path.join(tempRoot, "project");
		const records = musepiRecords(cwd, "Old snapshot");
		// `updateSessionTitle` rewrites only the slot, so a rename leaves the
		// header holding the previous name — the slot is what the app lists.
		records[0] = {
			type: "title",
			v: 1,
			title: "Renamed later",
			source: "auto",
			updatedAt: "2026-01-01T00:00:05.000Z",
			pad: "",
		};
		await writeJsonl(path.join(root, "slug", "s.jsonl"), records);

		const store = new SdkCompatSessionStore("omp", [root]);
		const [info] = await store.list();
		const manager = await store.load(info!);

		expect(info?.title).toBe("Renamed later");
		expect(manager.getSessionName()).toBe("Renamed later");
	});

	it("falls back to the header title when the slot is blank", async () => {
		const root = path.join(tempRoot, "sessions");
		const cwd = path.join(tempRoot, "project");
		const records = musepiRecords(cwd, "Header only");
		records[0] = { type: "title", v: 1, title: "", source: "auto", updatedAt: "2026-01-01T00:00:00.000Z", pad: "" };
		await writeJsonl(path.join(root, "slug", "s.jsonl"), records);

		const [info] = await new SdkCompatSessionStore("omp", [root]).list();

		expect(info?.title).toBe("Header only");
	});
});

/** A Kimi Code session folder: state.json beside agents/main/wire.jsonl. */
async function kimiFixture(options: {
	id: string;
	title?: string;
	cwd: string;
	withMessages?: boolean;
}): Promise<string> {
	const dir = path.join(tempRoot, "kimi", "sessions", "wd_project_abc", `session_${options.id}`);
	await Bun.write(
		path.join(dir, "state.json"),
		JSON.stringify({ title: options.title, titleKind: "generated", cwd: options.cwd }),
	);
	const records: Record<string, unknown>[] = [];
	if (options.withMessages) {
		records.push({
			type: "agent.message.appended",
			time: 1_767_225_600_000,
			message: { message: { role: "user", content: [{ type: "text", text: "plan my week" }] } },
		});
		records.push({
			type: "agent.message.appended",
			time: 1_767_225_601_000,
			message: {
				message: {
					role: "assistant",
					content: [{ type: "text", text: "here is the plan" }],
					toolCalls: [{ type: "function", id: "call-1", name: "read", arguments: '{"path":"a.ts"}' }],
				},
			},
		});
		records.push({
			type: "agent.message.appended",
			time: 1_767_225_602_000,
			message: {
				message: { role: "tool", toolCallId: "call-1", content: [{ type: "text", text: "file body" }] },
			},
		});
	}
	await writeJsonl(path.join(dir, "agents", "main", "wire.jsonl"), records);
	return dir;
}

describe("KimiSessionStore", () => {
	it("names sessions by their folder id, not every agent's `main` folder", async () => {
		const root = path.join(tempRoot, "kimi");
		await kimiFixture({ id: "aaa", title: "First", cwd: path.join(tempRoot, "a"), withMessages: true });
		await kimiFixture({ id: "bbb", title: "Second", cwd: path.join(tempRoot, "b"), withMessages: true });

		const sessions = await new KimiSessionStore(root).list();

		expect(sessions.map(session => session.id).sort()).toEqual(["aaa", "bbb"]);
		expect(new Set(sessions.map(session => session.id)).size).toBe(2);
	});

	it("reads title and cwd from state.json", async () => {
		const root = path.join(tempRoot, "kimi");
		const cwd = path.join(tempRoot, "some", "project");
		await kimiFixture({ id: "aaa", title: "Named by Kimi", cwd, withMessages: true });

		const [info] = await new KimiSessionStore(root).list();

		expect(info?.title).toBe("Named by Kimi");
		expect(info?.cwd).toBe(cwd);
		expect(info?.firstMessage).toBe("plan my week");
	});

	it("converts the doubly nested message envelope with linked tool calls", async () => {
		const root = path.join(tempRoot, "kimi");
		await kimiFixture({ id: "aaa", title: "Named by Kimi", cwd: tempRoot, withMessages: true });
		const store = new KimiSessionStore(root);
		const info = (await store.list())[0];
		if (!info) throw new Error("fixture was not listed");

		const manager = await store.load(info);
		const messages = manager.getEntries().filter(entry => entry.type === "message");

		expect(messages.map(entry => entry.message.role)).toEqual(["user", "assistant", "toolResult"]);
		const assistant = messages.find(entry => entry.message.role === "assistant");
		if (assistant?.message.role !== "assistant") throw new Error("missing assistant entry");
		const call = assistant.message.content.find(block => block.type === "toolCall");
		expect(call).toMatchObject({ id: "call-1", name: "read", arguments: { path: "a.ts" } });
		const result = messages.find(entry => entry.message.role === "toolResult");
		if (result?.message.role !== "toolResult") throw new Error("missing tool result entry");
		expect(result.message.toolCallId).toBe("call-1");
		expect(manager.getSessionName()).toBe("Named by Kimi");
	});

	it("lists a session whose wire holds no messages yet", async () => {
		const root = path.join(tempRoot, "kimi");
		await kimiFixture({ id: "aaa", title: "Fresh", cwd: tempRoot, withMessages: false });

		const [info] = await new KimiSessionStore(root).list();

		expect(info?.id).toBe("aaa");
		expect(info?.messageCount).toBe(0);
	});
});

/** An opencode database in one of the two schemas it ships. */
function opencodeDb(file: string, schema: "legacy" | "v2"): void {
	const db = new Database(file);
	try {
		if (schema === "v2") {
			db.run(
				"CREATE TABLE session_v2 (id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER)",
			);
			db.run(
				"CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)",
			);
			db.run("INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?)", [
				"ses_1",
				"V2 titled",
				"/work/project",
				1_767_225_600_000,
				1_767_225_660_000,
			]);
			const messages: Array<[string, string, string, number, string]> = [
				["m1", "ses_1", "user", 1, JSON.stringify({ text: "hello v2" })],
				[
					"m2",
					"ses_1",
					"assistant",
					2,
					JSON.stringify({
						model: { id: "glm-5", providerID: "opencode" },
						content: [
							{ type: "reasoning", text: "thinking it over" },
							{ type: "text", text: "hi" },
						],
					}),
				],
				["m3", "ses_1", "idle", 3, JSON.stringify({ outcome: "succeeded" })],
			];
			for (const [id, sessionId, type, seq, data] of messages) {
				db.run("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)", [
					id,
					sessionId,
					type,
					seq,
					1_767_225_600_000 + seq,
					0,
					data,
				]);
			}
			return;
		}
		db.run("CREATE TABLE session (id TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER)");
		db.run("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)");
		db.run("CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, ordinal INTEGER, data TEXT)");
		db.run("INSERT INTO session VALUES (?, ?, ?, ?, ?)", [
			"ses_old",
			"Legacy titled",
			"/work/legacy",
			1_767_225_600_000,
			1_767_225_660_000,
		]);
		db.run("INSERT INTO message VALUES (?, ?, ?, ?)", [
			"m1",
			"ses_old",
			1_767_225_601_000,
			JSON.stringify({ role: "user", parts: [{ type: "text", text: "hello legacy" }] }),
		]);
		db.run("INSERT INTO part VALUES (?, ?, ?, ?, ?)", [
			"p1",
			"m1",
			"ses_old",
			0,
			JSON.stringify({ type: "text", text: "hello legacy" }),
		]);
	} finally {
		db.close();
	}
}

describe("OpencodeSessionStore", () => {
	it("lists the 2.x schema, which renamed every table", async () => {
		const file = path.join(tempRoot, "opencode.db");
		opencodeDb(file, "v2");

		const listing = new OpencodeSessionStore([file]);
		const sessions = await listing.list();
		listing.close();

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({ id: "ses_1", title: "V2 titled", cwd: "/work/project" });
	});

	it("converts 2.x rows, keeping reasoning and skipping bookkeeping rows", async () => {
		const file = path.join(tempRoot, "opencode.db");
		opencodeDb(file, "v2");
		const store = new OpencodeSessionStore([file]);
		const info = (await store.list())[0];
		if (!info) throw new Error("fixture was not listed");

		const manager = await store.load(info);
		store.close();
		const messages = manager.getEntries().filter(entry => entry.type === "message");

		expect(messages.map(entry => entry.message.role)).toEqual(["user", "assistant"]);
		const assistant = messages[1];
		if (assistant?.message.role !== "assistant") throw new Error("missing assistant entry");
		expect(assistant.message.content.some(block => block.type === "thinking")).toBe(true);
		expect(assistant.message.model).toBe("glm-5");
		expect(manager.getSessionName()).toBe("V2 titled");
	});

	it("still lists and converts the legacy schema", async () => {
		const file = path.join(tempRoot, "opencode-legacy.db");
		opencodeDb(file, "legacy");
		const store = new OpencodeSessionStore([file]);
		const info = (await store.list())[0];
		if (!info) throw new Error("fixture was not listed");

		const manager = await store.load(info);
		store.close();
		const messages = manager.getEntries().filter(entry => entry.type === "message");

		expect(info.title).toBe("Legacy titled");
		expect(messages.map(entry => entry.message.role)).toEqual(["user"]);
	});

	it("imports into the session's own directory", async () => {
		const file = path.join(tempRoot, "opencode.db");
		opencodeDb(file, "v2");
		const store = new OpencodeSessionStore([file]);
		const info = (await store.list())[0];
		if (!info) throw new Error("fixture was not listed");

		const imported = await persistForeignSession(store, info, {
			fallbackCwd: tempRoot,
			sessionDir: path.join(tempRoot, "out"),
			suppressBreadcrumb: true,
		});

		store.close();
		expect(imported.getCwd()).toBe("/work/project");
		expect(imported.getSessionName()).toBe("V2 titled");
		await imported.close();
	});
});

describe("ClaudeSessionStore identity", () => {
	// `list()` walks Claude's on-disk project layout, which encodes a drive
	// colon into a directory name and is therefore posix-only. The title read
	// itself is layout-independent, so it is exercised directly.
	it("reads the newest title record from the transcript", async () => {
		const { readTranscriptTitleForTests } = await import("./claude-session-store");
		const file = path.join(tempRoot, "transcript.jsonl");
		await writeJsonl(file, [
			{
				type: "user",
				uuid: "u1",
				parentUuid: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { content: "hi" },
			},
			{ type: "ai-title", aiTitle: "Model suggestion" },
			{ type: "custom-title", customTitle: "Renamed by the user" },
		]);

		expect(await readTranscriptTitleForTests(file)).toBe("Renamed by the user");
	});

	it("ignores a missing transcript instead of failing the listing", async () => {
		const { readTranscriptTitleForTests } = await import("./claude-session-store");

		expect(await readTranscriptTitleForTests(path.join(tempRoot, "absent.jsonl"))).toBeUndefined();
	});
});

/** A Grok Build session folder: summary.json beside updates.jsonl. */
async function grokFixture(options: {
	root: string;
	id: string;
	title?: string;
	cwd: string;
	kind?: string;
}): Promise<void> {
	const dir = path.join(options.root, "sessions", "wd_project", options.id);
	await Bun.write(
		path.join(dir, "summary.json"),
		JSON.stringify({
			info: { id: options.id, cwd: options.cwd },
			generated_title: options.title,
			session_kind: options.kind,
			created_at: "2026-01-01T00:00:00.000Z",
		}),
	);
	const updates = [
		{ params: { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "plan " } } } },
		{ params: { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "my week" } } } },
		{
			params: {
				update: {
					sessionUpdate: "tool_call",
					toolCallId: "call-grok",
					rawInput: { path: "a.ts" },
					_meta: { "x.ai/tool": { name: "read_file" } },
				},
			},
		},
	];
	await writeJsonl(path.join(dir, "updates.jsonl"), updates);
}

describe("GrokSessionStore", () => {
	it("reads the per-session folder layout with its summary title", async () => {
		const root = path.join(tempRoot, "grok");
		const cwd = path.join(tempRoot, "some", "project");
		await grokFixture({ root, id: "grok-session-1", title: "Named by Grok", cwd });
		const { GrokSessionStore } = await import("./grok-session-store");

		const [info] = await new GrokSessionStore(root).list();

		expect(info?.id).toBe("grok-session-1");
		expect(info?.cwd).toBe(cwd);
		expect(info?.title).toBe("Named by Grok");
	});

	it("joins a streamed prompt into one user message", async () => {
		const root = path.join(tempRoot, "grok");
		await grokFixture({ root, id: "grok-session-1", title: "Named by Grok", cwd: tempRoot });
		const { GrokSessionStore } = await import("./grok-session-store");
		const store = new GrokSessionStore(root);
		const info = (await store.list())[0];
		if (!info) throw new Error("fixture was not listed");

		const manager = await store.load(info);
		const messages = manager.getEntries().filter(entry => entry.type === "message");

		const user = messages[0];
		if (user?.message.role !== "user") throw new Error("missing user entry");
		expect(user.message.content).toBe("plan my week");
		const assistant = messages.find(entry => entry.message.role === "assistant");
		if (assistant?.message.role !== "assistant") throw new Error("missing assistant entry");
		expect(assistant.message.content).toMatchObject([{ type: "toolCall", name: "read_file" }]);
	});

	it("does not list a subagent folder as its own session", async () => {
		const root = path.join(tempRoot, "grok");
		await grokFixture({ root, id: "parent-1", title: "Parent", cwd: tempRoot });
		await grokFixture({ root, id: "child-1", cwd: tempRoot, kind: "subagent" });
		const { GrokSessionStore } = await import("./grok-session-store");

		const sessions = await new GrokSessionStore(root).list();

		expect(sessions.map(session => session.id)).toEqual(["parent-1"]);
	});
});

/**
 * A WorkBuddy session: its own `<id>.jsonl` under one of `projects/`'s
 * folders, beside an optional `<id>.meta.json` (the cwd of a session brought
 * over from its older history) and `<id>/subagents/agent-<uuid>.jsonl`.
 */
async function workbuddyFixture(options: {
	root: string;
	project: string;
	id: string;
	cwd?: string;
	title?: string;
	customTitle?: string;
	metaCwd?: string;
	subagents?: string[];
	records?: Record<string, unknown>[];
}): Promise<string> {
	const dir = path.join(options.root, "projects", options.project);
	const file = path.join(dir, `${options.id}.jsonl`);
	const records: Record<string, unknown>[] = options.records ?? [
		{ type: "session-meta", id: "meta-1", sessionId: options.id, timestamp: 1_767_225_600_000 },
		...(options.title
			? [{ type: "ai-title", aiTitle: options.title, sessionId: options.id, timestamp: 1_767_225_601_000 }]
			: []),
		...(options.customTitle
			? [{ type: "custom-title", customTitle: options.customTitle, timestamp: 1_767_225_900_000 }]
			: []),
		{
			type: "message",
			id: "u1",
			timestamp: 1_767_225_602_000,
			role: "user",
			cwd: options.cwd,
			content: [{ type: "input_text", text: "<user_query>plan my week</user_query>" }],
		},
		{
			type: "message",
			id: "a1",
			timestamp: 1_767_225_603_000,
			role: "assistant",
			cwd: options.cwd,
			content: [{ type: "output_text", text: "here is the plan" }],
			providerData: { messageId: "m-1", model: "wb-model" },
			message: { usage: { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 7 } },
		},
	];
	await writeJsonl(file, records);
	if (options.metaCwd) {
		await Bun.write(path.join(dir, `${options.id}.meta.json`), JSON.stringify({ cwd: options.metaCwd }));
	}
	for (const agent of options.subagents ?? []) {
		await writeJsonl(path.join(dir, options.id, "subagents", `${agent}.jsonl`), [
			{
				type: "message",
				id: `${agent}-u1`,
				timestamp: 1_767_225_604_000,
				role: "user",
				content: [{ type: "input_text", text: "investigate the accent swatch" }],
			},
		]);
	}
	return file;
}

describe("WorkbuddySessionStore", () => {
	it("lists the session once and never a subagent transcript", async () => {
		const root = path.join(tempRoot, "workbuddy");
		const cwd = path.join(tempRoot, "some", "project");
		await workbuddyFixture({
			root,
			project: "d-Projects-Agents-MusePi",
			id: "17cc53d5-729e-43e7-93f7-53a12b5ec50c",
			cwd,
			title: "Named by WorkBuddy",
			subagents: ["agent-0b8f96f7-8b4f-4a77-86df-65b801d65a89", "agent-93a2b476"],
		});
		const { WorkbuddySessionStore } = await import("./workbuddy-session-store");

		const sessions = await new WorkbuddySessionStore(root).list();

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			source: "workbuddy",
			id: "17cc53d5-729e-43e7-93f7-53a12b5ec50c",
			cwd,
			title: "Named by WorkBuddy",
			firstMessage: "plan my week",
			messageCount: 2,
		});
	});

	it("prefers the user's own title over the model's", async () => {
		const root = path.join(tempRoot, "workbuddy");
		await workbuddyFixture({
			root,
			project: "p",
			id: "abc",
			cwd: tempRoot,
			title: "Model suggestion",
			customTitle: "Renamed by the user",
		});
		const { WorkbuddySessionStore } = await import("./workbuddy-session-store");

		const [info] = await new WorkbuddySessionStore(root).list();

		expect(info?.title).toBe("Renamed by the user");
	});

	it("reads the cwd from a legacy meta file when no line records one", async () => {
		const root = path.join(tempRoot, "workbuddy");
		const cwd = path.join(tempRoot, "old", "project");
		await workbuddyFixture({
			root,
			project: "p",
			id: "legacy",
			metaCwd: cwd,
			records: [
				{
					type: "message",
					id: "u1",
					timestamp: 1_767_225_602_000,
					role: "user",
					content: [{ type: "input_text", text: "<user_query>old session</user_query>" }],
				},
			],
		});
		const { WorkbuddySessionStore } = await import("./workbuddy-session-store");

		const [info] = await new WorkbuddySessionStore(root).list();

		expect(info?.cwd).toBe(cwd);
	});

	it("leaves harness notices out of the prompt it lists and imports", async () => {
		const root = path.join(tempRoot, "workbuddy");
		await workbuddyFixture({
			root,
			project: "p",
			id: "notices",
			cwd: tempRoot,
			records: [
				{
					type: "message",
					id: "u1",
					timestamp: 1_767_225_602_000,
					role: "user",
					cwd: tempRoot,
					content: [
						{ type: "input_text", text: "<task-notification>\n<status>completed</status>\n</task-notification>" },
					],
				},
				{
					type: "message",
					id: "u2",
					timestamp: 1_767_225_604_000,
					role: "user",
					cwd: tempRoot,
					content: [
						{ type: "input_text", text: "<system-reminder>workspace notes</system-reminder>" },
						{ type: "input_text", text: "<user_query>fix the accent swatch</user_query>" },
					],
				},
			],
		});
		const { WorkbuddySessionStore } = await import("./workbuddy-session-store");
		const store = new WorkbuddySessionStore(root);
		const info = (await store.list())[0];
		if (!info) throw new Error("fixture was not listed");

		const manager = await store.load(info);
		const users = manager
			.getEntries()
			.filter(entry => entry.type === "message" && entry.message.role === "user")
			.map(entry => (entry.type === "message" ? entry.message : undefined));

		expect(info.firstMessage).toBe("fix the accent swatch");
		expect(users).toHaveLength(1);
		expect(users[0]?.role === "user" ? users[0].content : undefined).toBe("fix the accent swatch");
	});

	it("converts one reply per provider message id, keeping its reasoning, text and calls", async () => {
		const root = path.join(tempRoot, "workbuddy");
		await workbuddyFixture({
			root,
			project: "p",
			id: "reply",
			cwd: tempRoot,
			records: [
				{
					type: "message",
					id: "u1",
					timestamp: 1_767_225_602_000,
					role: "user",
					cwd: tempRoot,
					content: [{ type: "input_text", text: "<user_query>read a.ts</user_query>" }],
				},
				{
					type: "reasoning",
					id: "r1",
					timestamp: 1_767_225_603_000,
					cwd: tempRoot,
					providerData: { messageId: "m-1", model: "wb-model" },
					rawContent: [{ type: "reasoning_text", text: "the file is the place to look" }],
				},
				{
					type: "message",
					id: "a1",
					timestamp: 1_767_225_604_000,
					role: "assistant",
					cwd: tempRoot,
					content: [{ type: "output_text", text: "reading it" }],
					providerData: {
						messageId: "m-1",
						model: "wb-model",
						usage: {
							inputTokens: 1000,
							outputTokens: 40,
							inputTokensDetails: [{ cached_tokens: 900 }],
						},
					},
				},
				{
					type: "function_call",
					id: "c1",
					timestamp: 1_767_225_605_000,
					cwd: tempRoot,
					callId: "call-1",
					name: "Read",
					arguments: '{"path":"a.ts"}',
					providerData: {
						messageId: "m-1",
						model: "wb-model",
						usage: { inputTokens: 1000, outputTokens: 40, inputTokensDetails: [{ cached_tokens: 900 }] },
					},
				},
				{
					type: "function_call_result",
					id: "res1",
					timestamp: 1_767_225_606_000,
					cwd: tempRoot,
					callId: "call-1",
					name: "Read",
					status: "completed",
					output: { type: "text", text: "file body" },
				},
			],
		});
		const { WorkbuddySessionStore } = await import("./workbuddy-session-store");
		const store = new WorkbuddySessionStore(root);
		const info = (await store.list())[0];
		if (!info) throw new Error("fixture was not listed");

		const manager = await store.load(info);
		const messages = manager.getEntries().filter(entry => entry.type === "message");
		const assistants = messages.filter(entry => entry.message.role === "assistant");

		expect(messages.map(entry => entry.message.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(assistants).toHaveLength(1);
		const reply = assistants[0];
		if (reply?.message.role !== "assistant") throw new Error("missing assistant entry");
		expect(reply.message.content).toMatchObject([
			{ type: "thinking", thinking: "the file is the place to look" },
			{ type: "text", text: "reading it" },
			{ type: "toolCall", id: "call-1", name: "Read", arguments: { path: "a.ts" } },
		]);
		expect(reply.message.usage).toMatchObject({ input: 100, output: 40, cacheRead: 900 });
		expect(reply.message.model).toBe("wb-model");
		const result = messages.find(entry => entry.message.role === "toolResult");
		if (result?.message.role !== "toolResult") throw new Error("missing tool result entry");
		expect(result.message).toMatchObject({ toolCallId: "call-1", toolName: "Read", isError: false });
	});

	it("marks a tool result the app rejected as an error", async () => {
		const root = path.join(tempRoot, "workbuddy");
		await workbuddyFixture({
			root,
			project: "p",
			id: "rejected",
			cwd: tempRoot,
			records: [
				{
					type: "function_call",
					id: "c1",
					timestamp: 1_767_225_605_000,
					cwd: tempRoot,
					callId: "call-1",
					name: "Bash",
					arguments: "{}",
					providerData: { messageId: "m-1" },
				},
				{
					type: "function_call_result",
					id: "res1",
					timestamp: 1_767_225_606_000,
					cwd: tempRoot,
					callId: "call-1",
					name: "Bash",
					status: "incomplete",
					output: { type: "text", text: "Command rejected: blocked for security" },
				},
			],
		});
		const { WorkbuddySessionStore } = await import("./workbuddy-session-store");
		const store = new WorkbuddySessionStore(root);
		const info = (await store.list())[0];
		if (!info) throw new Error("fixture was not listed");

		const manager = await store.load(info);
		const result = manager
			.getEntries()
			.find(entry => entry.type === "message" && entry.message.role === "toolResult");

		if (result?.type !== "message" || result.message.role !== "toolResult") {
			throw new Error("missing tool result entry");
		}
		expect(result.message.isError).toBe(true);
	});

	it("reads the usage an older session recorded as input_tokens", async () => {
		const root = path.join(tempRoot, "workbuddy");
		await workbuddyFixture({ root, project: "p", id: "old-usage", cwd: tempRoot });
		const { WorkbuddySessionStore } = await import("./workbuddy-session-store");
		const store = new WorkbuddySessionStore(root);
		const info = (await store.list())[0];
		if (!info) throw new Error("fixture was not listed");

		const manager = await store.load(info);
		const reply = manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "assistant");

		if (reply?.type !== "message" || reply.message.role !== "assistant") {
			throw new Error("missing assistant entry");
		}
		expect(reply.message.usage).toMatchObject({ input: 5, output: 5, cacheRead: 7 });
	});

	it("imports into the workspace the session recorded", async () => {
		const root = path.join(tempRoot, "workbuddy");
		const cwd = path.join(tempRoot, "some", "project");
		await fs.mkdir(cwd, { recursive: true });
		await workbuddyFixture({ root, project: "p", id: "importable", cwd, title: "Named by WorkBuddy" });
		const { WorkbuddySessionStore } = await import("./workbuddy-session-store");
		const store = new WorkbuddySessionStore(root);
		const info = (await store.list())[0];
		if (!info) throw new Error("fixture was not listed");

		const imported = await persistForeignSession(store, info, {
			fallbackCwd: tempRoot,
			sessionDir: path.join(tempRoot, "out"),
			suppressBreadcrumb: true,
		});

		expect(imported.getCwd()).toBe(cwd);
		expect(imported.getSessionName()).toBe("Named by WorkBuddy");
		await imported.close();
	});
});

/** A Codex state database: its thread index plus the project root registry. */
function codexStateDatabase(
	file: string,
	options: {
		threads: Array<{ id: string; rolloutPath: string; cwd: string; title?: string; projectId?: string | null }>;
		projects?: Array<{ id: string; name: string; roots: string[] }>;
	},
): void {
	const database = new Database(file);
	try {
		// Older Codex builds predate `threads.project_id`; only a database with
		// the project registry carries that column.
		const projectColumn = options.projects ? ", project_id TEXT" : "";
		database.run(
			`CREATE TABLE threads (id TEXT, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, cwd TEXT, title TEXT, first_user_message TEXT${projectColumn})`,
		);
		for (const thread of options.threads) {
			const values: Array<string | number | null> = [
				thread.id,
				thread.rolloutPath,
				1_767_225_600,
				1_767_225_660,
				thread.cwd,
				thread.title ?? "",
				"",
			];
			if (options.projects) values.push(thread.projectId ?? null);
			database.run(`INSERT INTO threads VALUES (${values.map(() => "?").join(", ")})`, values);
		}
		if (!options.projects) return;
		database.run(
			"CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, metadata TEXT, position INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER)",
		);
		database.run(
			"CREATE TABLE project_roots (project_id TEXT NOT NULL, position INTEGER NOT NULL, path TEXT NOT NULL, PRIMARY KEY (project_id, position))",
		);
		options.projects.forEach((project, position) => {
			database.run("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?)", [
				project.id,
				project.name,
				"{}",
				position,
				0,
				0,
			]);
			project.roots.forEach((root, rootPosition) => {
				database.run("INSERT INTO project_roots VALUES (?, ?, ?)", [project.id, rootPosition, root]);
			});
		});
	} finally {
		database.close();
	}
}

describe("CodexSessionStore workspace identity", () => {
	it("lists the workspace path without the Windows extended-length prefix", async () => {
		const root = path.join(tempRoot, ".codex");
		const rollout = path.join(root, "sessions", "rollout-demo.jsonl");
		await writeJsonl(rollout, [
			{ type: "session_meta", payload: { id: "codex-prefixed", cwd: "D:\\Projects\\Agents\\MusePi" } },
		]);
		codexStateDatabase(path.join(root, "state_5.sqlite"), {
			threads: [
				{ id: "codex-prefixed", rolloutPath: rollout, cwd: "\\\\?\\D:\\Projects\\Agents\\MusePi" },
				{ id: "codex-unc", rolloutPath: rollout, cwd: "\\\\?\\UNC\\server\\share\\project" },
			],
		});

		const sessions = await new CodexSessionStore(root).list();
		const byId = new Map(sessions.map(session => [session.id, session]));

		expect(byId.get("codex-prefixed")?.cwd).toBe("D:\\Projects\\Agents\\MusePi");
		expect(byId.get("codex-unc")?.cwd).toBe("\\\\server\\share\\project");
	});

	it("projects a project's other roots as ordered additional directories", async () => {
		const root = path.join(tempRoot, ".codex");
		const rollout = path.join(root, "sessions", "rollout-demo.jsonl");
		await writeJsonl(rollout, [
			{ type: "session_meta", payload: { id: "codex-project", cwd: "D:\\Projects\\Agents\\MusePi" } },
		]);
		// `threads.project_id` is null on the real database; membership is
		// recovered from the recorded cwd, which matches a project root.
		codexStateDatabase(path.join(root, "state_5.sqlite"), {
			threads: [{ id: "codex-project", rolloutPath: rollout, cwd: "\\\\?\\D:\\Projects\\Agents\\MusePi" }],
			projects: [
				{
					id: "p1",
					name: "agent development",
					roots: [
						"D:\\Projects\\Agents\\MusePi",
						"D:\\Projects\\Agents\\references",
						"D:\\Projects\\Agents\\magpie-agent-musepi",
					],
				},
				{ id: "p2", name: "unrelated", roots: ["D:\\Other"] },
			],
		});

		const [info] = await new CodexSessionStore(root).list();

		expect(info?.cwd).toBe("D:\\Projects\\Agents\\MusePi");
		expect(info?.additionalDirectories).toEqual([
			"D:\\Projects\\Agents\\references",
			"D:\\Projects\\Agents\\magpie-agent-musepi",
		]);
	});

	it("honors threads.project_id over path matching", async () => {
		const root = path.join(tempRoot, ".codex");
		const rollout = path.join(root, "sessions", "rollout-demo.jsonl");
		await writeJsonl(rollout, [{ type: "session_meta", payload: { id: "codex-pinned" } }]);
		codexStateDatabase(path.join(root, "state_5.sqlite"), {
			threads: [{ id: "codex-pinned", rolloutPath: rollout, cwd: "\\\\?\\D:\\Elsewhere", projectId: "p2" }],
			projects: [
				{ id: "p1", name: "first", roots: ["D:\\Projects\\Agents\\MusePi"] },
				{ id: "p2", name: "second", roots: ["D:\\Second\\Main", "D:\\Second\\Shared"] },
			],
		});

		const [info] = await new CodexSessionStore(root).list();

		expect(info?.cwd).toBe("D:\\Elsewhere");
		expect(info?.additionalDirectories).toEqual(["D:\\Second\\Main", "D:\\Second\\Shared"]);
	});

	it("reads a database whose threads table predates its project registry", async () => {
		const root = path.join(tempRoot, ".codex");
		const rollout = path.join(root, "sessions", "rollout-demo.jsonl");
		await writeJsonl(rollout, [
			{ type: "session_meta", payload: { id: "codex-migrating", cwd: "D:\\Projects\\Agents\\MusePi" } },
		]);
		codexStateDatabase(path.join(root, "state_5.sqlite"), {
			threads: [{ id: "codex-migrating", rolloutPath: rollout, cwd: "\\\\?\\D:\\Projects\\Agents\\MusePi" }],
		});
		const database = new Database(path.join(root, "state_5.sqlite"));
		try {
			database.run("CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, position INTEGER)");
			database.run(
				"CREATE TABLE project_roots (project_id TEXT NOT NULL, position INTEGER NOT NULL, path TEXT NOT NULL)",
			);
			database.run("INSERT INTO projects VALUES ('p1', 'agent development', 0)");
			database.run("INSERT INTO project_roots VALUES ('p1', 0, 'D:\\Projects\\Agents\\MusePi')");
			database.run("INSERT INTO project_roots VALUES ('p1', 1, 'D:\\Projects\\Agents\\references')");
		} finally {
			database.close();
		}

		const [info] = await new CodexSessionStore(root).list();

		expect(info?.cwd).toBe("D:\\Projects\\Agents\\MusePi");
		expect(info?.additionalDirectories).toEqual(["D:\\Projects\\Agents\\references"]);
	});

	it("imports the project's other roots into the persisted session header", async () => {
		const root = path.join(tempRoot, ".codex");
		const rollout = path.join(root, "sessions", "rollout-demo.jsonl");
		await writeJsonl(rollout, [
			{
				type: "session_meta",
				payload: {
					id: "codex-project",
					cwd: "D:\\Projects\\Agents\\MusePi",
					runtime_workspace_roots: ["D:\\Projects\\Agents\\MusePi"],
				},
			},
			{
				type: "response_item",
				timestamp: "2026-01-01T00:00:01.000Z",
				payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
			},
		]);
		codexStateDatabase(path.join(root, "state_5.sqlite"), {
			threads: [{ id: "codex-project", rolloutPath: rollout, cwd: "\\\\?\\D:\\Projects\\Agents\\MusePi" }],
			projects: [
				{
					id: "p1",
					name: "agent development",
					roots: ["D:\\Projects\\Agents\\MusePi", "D:\\Projects\\Agents\\references"],
				},
			],
		});
		const store = new CodexSessionStore(root);
		const info = (await store.list())[0];
		if (!info) throw new Error("fixture was not listed");

		const imported = await persistForeignSession(store, info, {
			fallbackCwd: tempRoot,
			sessionDir: path.join(tempRoot, "out"),
			suppressBreadcrumb: true,
		});

		expect(imported.getCwd()).toBe("D:\\Projects\\Agents\\MusePi");
		expect(imported.getAdditionalDirectories()).toEqual(["D:\\Projects\\Agents\\references"]);
		const sessionFile = imported.getSessionFile();
		if (!sessionFile) throw new Error("imported session was not persisted");
		const header = (await fs.readFile(sessionFile, "utf8"))
			.split("\n")
			.filter(line => line.trim().length > 0)
			.map(line => JSON.parse(line) as Record<string, unknown>)
			.find(record => record.type === "session");
		expect(header?.cwd).toBe("D:\\Projects\\Agents\\MusePi");
		expect(header?.additionalDirectories).toEqual(["D:\\Projects\\Agents\\references"]);
		await imported.close();
	});

	it("falls back to the rollout's runtime workspace roots without a project registry", async () => {
		const root = path.join(tempRoot, ".codex");
		const cwd = path.join(tempRoot, "codex-project");
		const rollout = path.join(root, "sessions", "rollout-demo.jsonl");
		await writeJsonl(rollout, [
			{
				type: "session_meta",
				payload: {
					id: "codex-legacy",
					cwd,
					runtime_workspace_roots: [cwd, path.join(tempRoot, "referenced"), path.join(tempRoot, "sibling")],
				},
			},
			{
				type: "response_item",
				timestamp: "2026-01-01T00:00:01.000Z",
				payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
			},
		]);
		codexStateDatabase(path.join(root, "state_5.sqlite"), {
			threads: [{ id: "codex-legacy", rolloutPath: rollout, cwd }],
		});
		const store = new CodexSessionStore(root);
		const info = (await store.list())[0];
		if (!info) throw new Error("fixture was not listed");

		const manager = await store.load(info);

		expect(manager.getCwd()).toBe(cwd);
		expect(manager.getAdditionalDirectories()).toEqual([
			path.join(tempRoot, "referenced"),
			path.join(tempRoot, "sibling"),
		]);
	});

	it("drops an unsafe recorded root instead of importing it", async () => {
		const root = path.join(tempRoot, ".codex");
		const rollout = path.join(root, "sessions", "rollout-demo.jsonl");
		const home = os.homedir();
		await writeJsonl(rollout, [
			{ type: "session_meta", payload: { id: "codex-unsafe", cwd: "D:ProjectsAgentsMusePi" } },
		]);
		// A home directory or a filesystem root is never a secondary workspace
		// root: carrying one in would hand the agent every unrelated project.
		codexStateDatabase(path.join(root, "state_5.sqlite"), {
			threads: [{ id: "codex-unsafe", rolloutPath: rollout, cwd: "D:ProjectsAgentsMusePi" }],
			projects: [
				{
					id: "p1",
					name: "unsafe",
					roots: ["D:ProjectsAgentsMusePi", home, path.parse(home).root],
				},
			],
		});
		const store = new CodexSessionStore(root);
		const info = (await store.list())[0];
		if (!info) throw new Error("fixture was not listed");

		const manager = await store.load(info);

		expect(manager.getAdditionalDirectories()).toEqual([]);
	});

	it("leaves a session single-root when no project or workspace roots are recorded", async () => {
		const root = path.join(tempRoot, ".codex");
		const cwd = path.join(tempRoot, "codex-project");
		const rollout = path.join(root, "sessions", "rollout-demo.jsonl");
		await writeJsonl(rollout, [
			{ type: "session_meta", payload: { id: "codex-single", cwd } },
			{
				type: "response_item",
				timestamp: "2026-01-01T00:00:01.000Z",
				payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
			},
		]);
		codexStateDatabase(path.join(root, "state_5.sqlite"), {
			threads: [{ id: "codex-single", rolloutPath: rollout, cwd }],
			projects: [{ id: "p1", name: "elsewhere", roots: [path.join(tempRoot, "elsewhere")] }],
		});
		const store = new CodexSessionStore(root);
		const info = (await store.list())[0];
		if (!info) throw new Error("fixture was not listed");

		const manager = await store.load(info);

		expect(info.additionalDirectories).toBeUndefined();
		expect(manager.getAdditionalDirectories()).toEqual([]);
	});
});

/** A CodeBuddy Code session file: `projects/<encoded-cwd>/<id>.jsonl`. */
async function codebuddyFixture(options: {
	root: string;
	id: string;
	cwd: string;
	title?: { custom?: string; ai?: string };
}): Promise<void> {
	const dir = path.join(options.root, "projects", options.cwd.replaceAll(/[:\\/]/g, "-"));
	const records: Record<string, unknown>[] = [
		{ type: "session-meta", id: "meta", sessionId: options.id, timestamp: 1_767_225_600_000 },
		{
			type: "message",
			id: "m1",
			role: "user",
			timestamp: 1_767_225_601_000,
			cwd: options.cwd,
			content: [
				{ type: "input_text", text: "<system-reminder>Caveat: generated by a local command.</system-reminder>" },
				{ type: "input_text", text: "explain the build" },
			],
		},
		{
			type: "message",
			id: "m2",
			role: "assistant",
			timestamp: 1_767_225_602_000,
			providerData: { model: "deepseek-v4" },
			content: [
				{ type: "reasoning", text: "checking the build" },
				{ type: "output_text", text: "the build is fine" },
				{ type: "function_call", call_id: "call-1", name: "read_file", arguments: '{"path":"a.ts"}' },
			],
		},
		{
			type: "message",
			id: "m3",
			role: "user",
			timestamp: 1_767_225_603_000,
			content: "<command-name>/model</command-name>",
		},
	];
	if (options.title?.ai) records.push({ type: "ai-title", aiTitle: options.title.ai, timestamp: 1_767_225_604_000 });
	if (options.title?.custom) {
		records.push({ type: "custom-title", customTitle: options.title.custom, timestamp: 1_767_225_605_000 });
	}
	await writeJsonl(path.join(dir, `${options.id}.jsonl`), records);
}

describe("CodebuddySessionStore", () => {
	it("lists the session's own cwd and title, not the encoded folder name", async () => {
		const root = path.join(tempRoot, "codebuddy");
		const cwd = path.join(tempRoot, "some", "project");
		await codebuddyFixture({ root, id: "cb-1", cwd, title: { ai: "Model suggestion" } });
		const { CodebuddySessionStore } = await import("./codebuddy-session-store");

		const [info] = await new CodebuddySessionStore(root).list();

		expect(info?.id).toBe("cb-1");
		expect(info?.cwd).toBe(cwd);
		expect(info?.title).toBe("Model suggestion");
	});

	it("keeps the user's name over the CLI's", async () => {
		const root = path.join(tempRoot, "codebuddy");
		await codebuddyFixture({ root, id: "cb-1", cwd: tempRoot, title: { ai: "Model suggestion", custom: "Renamed" } });
		const { CodebuddySessionStore } = await import("./codebuddy-session-store");

		const [info] = await new CodebuddySessionStore(root).list();

		expect(info?.title).toBe("Renamed");
	});

	it("drops command echoes and injected context from the prompt", async () => {
		const root = path.join(tempRoot, "codebuddy");
		await codebuddyFixture({ root, id: "cb-1", cwd: tempRoot });
		const store = new (await import("./codebuddy-session-store")).CodebuddySessionStore(root);
		const [info] = await store.list();
		if (!info) throw new Error("fixture was not listed");

		const manager = await store.load(info);
		const messages = manager.getEntries().filter(entry => entry.type === "message");

		expect(info.firstMessage).toBe("explain the build");
		expect(messages.map(entry => entry.message.role)).toEqual(["user", "assistant"]);
		const user = messages[0];
		if (user?.message.role !== "user") throw new Error("missing user entry");
		expect(user.message.content).toBe("explain the build");
	});

	it("keeps reasoning, model and the tool call", async () => {
		const root = path.join(tempRoot, "codebuddy");
		await codebuddyFixture({ root, id: "cb-1", cwd: tempRoot });
		const store = new (await import("./codebuddy-session-store")).CodebuddySessionStore(root);
		const info = (await store.list())[0];
		if (!info) throw new Error("fixture was not listed");

		const manager = await store.load(info);
		const assistant = manager
			.getEntries()
			.find(entry => entry.type === "message" && entry.message.role === "assistant");
		if (assistant?.type !== "message" || assistant.message.role !== "assistant") {
			throw new Error("missing assistant entry");
		}

		expect(assistant.message.model).toBe("deepseek-v4");
		expect(assistant.message.content.some(block => block.type === "thinking")).toBe(true);
		expect(assistant.message.content).toContainEqual({
			type: "toolCall",
			id: "call-1",
			name: "read_file",
			arguments: { path: "a.ts" },
		});
	});
});
