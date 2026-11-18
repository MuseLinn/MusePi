import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DshSessionStore } from "./dsh-session-store";
import { persistForeignSession } from "./foreign-session-import";

/**
 * A DeepSeek Harness session folder: one record per line, header first, under
 * `<root>/sessions/<project>/<session id>/`. The newer format's file carries a
 * generation in its name; `compressed` writes one zstd frame per record, the
 * way a live session appends.
 */
async function dshSession(options: {
	root: string;
	id: string;
	cwd: string;
	title?: string;
	records?: Record<string, unknown>[];
	generation?: number;
	compressed?: boolean;
	delegationDepth?: number;
	parentSession?: string;
}): Promise<string> {
	const dir = path.join(options.root, "sessions", "project", options.id);
	const generation = options.generation ?? 4;
	const lines: Record<string, unknown>[] = [
		{
			type: "session",
			version: generation,
			id: options.id,
			createdAt: 1_767_225_600_000,
			cwd: options.cwd,
			isSeeded: false,
			delegationDepth: options.delegationDepth ?? 0,
			...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
		},
		...(options.records ?? []),
		...(options.title === undefined
			? []
			: [
					{
						type: "session/title",
						seq: 99,
						time: 1_767_225_699_000,
						data: { title: options.title, source: { kind: "provider" } },
					},
				]),
	];
	await fs.mkdir(dir, { recursive: true });
	const name = `session${generation === 1 ? "" : `.v${generation}`}.jsonl`;
	if (options.compressed) {
		const frames = lines.map(line => Bun.zstdCompressSync(`${JSON.stringify(line)}\n`));
		await Bun.write(path.join(dir, `${name}.zstd`), Buffer.concat(frames));
		return dir;
	}
	await Bun.write(path.join(dir, name), `${lines.map(line => JSON.stringify(line)).join("\n")}\n`);
	return dir;
}

/** A prompt the user typed; the harness marks those `source.kind: "user"`. */
function dshPrompt(text: string, time: number): Record<string, unknown> {
	return {
		type: "user/message",
		seq: 1,
		time,
		data: { content: [{ type: "text", text }], source: { kind: "user" }, role: "user" },
	};
}

/** Context the harness injects for the model, not something the user sent. */
function dshContext(text: string, kind: string, time: number): Record<string, unknown> {
	return {
		type: "user/message",
		seq: 2,
		time,
		data: { content: [{ type: "text", text }], source: { kind }, role: "user" },
	};
}

let tempRoot: string;

beforeEach(async () => {
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-dsh-identity-"));
});

afterEach(async () => {
	await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("DshSessionStore", () => {
	it("lists the session's own id, cwd and title from its header and title event", async () => {
		const root = path.join(tempRoot, "dsh");
		const cwd = path.join(tempRoot, "some", "project");
		await dshSession({ root, id: "session-abc", cwd, title: "Named by DSH", records: [dshPrompt("hello", 1)] });

		const [info] = await new DshSessionStore(root).list();

		expect(info?.id).toBe("session-abc");
		expect(info?.cwd).toBe(cwd);
		expect(info?.title).toBe("Named by DSH");
		expect(info?.firstMessage).toBe("hello");
	});

	it("does not list a subagent session as a session of its own", async () => {
		const root = path.join(tempRoot, "dsh");
		await dshSession({ root, id: "session-parent", cwd: tempRoot, records: [dshPrompt("hello", 1)] });
		await dshSession({
			root,
			id: "session-child",
			cwd: tempRoot,
			delegationDepth: 1,
			parentSession: "session-parent",
			records: [dshPrompt("delegate", 2)],
		});

		const sessions = await new DshSessionStore(root).list();

		expect(sessions.map(session => session.id)).toEqual(["session-parent"]);
	});

	it("drops injected context so one turn is not four user messages", async () => {
		const root = path.join(tempRoot, "dsh");
		await dshSession({
			root,
			id: "session-abc",
			cwd: tempRoot,
			records: [
				dshContext("Current runtime context. This snapshot supersedes…", "runtime-context", 1),
				dshContext("A skill is a reusable set of task-specific instructions…", "skill-catalog", 2),
				dshPrompt("plan my week", 3),
				dshContext("Time sampled while preparing turn 1", "time-context", 4),
			],
		});
		const store = new DshSessionStore(root);
		const [info] = await store.list();
		if (!info) throw new Error("fixture was not listed");

		const manager = await store.load(info);
		const messages = manager.getEntries().filter(entry => entry.type === "message");

		expect(info.messageCount).toBe(1);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.message.role).toBe("user");
	});

	it("keeps reasoning, text, the tool call and its result in order", async () => {
		const root = path.join(tempRoot, "dsh");
		await dshSession({
			root,
			id: "session-abc",
			cwd: tempRoot,
			records: [
				dshPrompt("read a.ts", 1_767_225_601_000),
				{
					type: "assistant/message",
					seq: 3,
					time: 1_767_225_602_000,
					data: {
						message: {
							role: "assistant",
							source: { kind: "model", provider: "opencode-go", model: "opencode-go/deepseek-v4.1" },
							content: [
								{ type: "reasoning", text: "thinking it over" },
								{ type: "text", text: "reading" },
								{ type: "tool-call", id: "call-1", name: "read", arguments: '{"path":"a.ts"}' },
							],
						},
						usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 6, totalTokens: 20 },
					},
				},
				{
					type: "tool/result",
					seq: 4,
					time: 1_767_225_603_000,
					data: {
						message: {
							role: "tool",
							toolCallId: "call-1",
							isError: false,
							content: [{ type: "text", text: "file body" }],
						},
					},
				},
			],
		});
		const store = new DshSessionStore(root);
		const [info] = await store.list();
		if (!info) throw new Error("fixture was not listed");

		const manager = await store.load(info);
		const messages = manager.getEntries().filter(entry => entry.type === "message");

		expect(messages.map(entry => entry.message.role)).toEqual(["user", "assistant", "toolResult"]);
		const assistant = messages[1];
		if (assistant?.message.role !== "assistant") throw new Error("missing assistant entry");
		expect(assistant.message.content.map(block => block.type)).toEqual(["thinking", "text", "toolCall"]);
		expect(assistant.message.content.find(block => block.type === "toolCall")).toMatchObject({
			id: "call-1",
			name: "read",
			arguments: { path: "a.ts" },
		});
		expect(assistant.message.provider).toBe("opencode-go");
		expect(assistant.message.usage).toMatchObject({ input: 10, output: 4, cacheRead: 6, cacheWrite: 0 });
		const result = messages[2];
		if (result?.message.role !== "toolResult") throw new Error("missing tool result entry");
		expect(result.message).toMatchObject({ toolCallId: "call-1", toolName: "read", isError: false });
	});

	it("names a tool result from its call when the result carries no name", async () => {
		const root = path.join(tempRoot, "dsh");
		await dshSession({
			root,
			id: "session-abc",
			cwd: tempRoot,
			records: [
				dshPrompt("run it", 1_767_225_601_000),
				{
					type: "tool/call",
					seq: 2,
					time: 1_767_225_602_000,
					data: { callId: "call-9", name: "pwsh", arguments: "{}" },
				},
				{
					type: "tool/result",
					seq: 3,
					time: 1_767_225_603_000,
					data: { message: { role: "tool", toolCallId: "call-9", content: [{ type: "text", text: "ok" }] } },
				},
			],
		});
		const store = new DshSessionStore(root);
		const [info] = await store.list();
		if (!info) throw new Error("fixture was not listed");

		const manager = await store.load(info);
		const result = manager
			.getEntries()
			.find(entry => entry.type === "message" && entry.message.role === "toolResult");
		if (result?.type !== "message" || result.message.role !== "toolResult") throw new Error("missing tool result");
		expect(result.message.toolName).toBe("pwsh");
	});

	it("reads the newest generation and the compressed encoding", async () => {
		const root = path.join(tempRoot, "dsh");
		const cwd = path.join(tempRoot, "project");
		// An older generation stays behind when a session is carried over.
		await dshSession({ root, id: "session-abc", cwd, generation: 1, title: "Stale", records: [dshPrompt("old", 1)] });
		await dshSession({
			root,
			id: "session-abc",
			cwd,
			generation: 4,
			compressed: true,
			title: "Current",
			records: [dshPrompt("new", 2)],
		});
		const store = new DshSessionStore(root);
		const [info] = await store.list();
		if (!info) throw new Error("fixture was not listed");

		const manager = await store.load(info);

		expect(info.title).toBe("Current");
		expect(info.firstMessage).toBe("new");
		expect(manager.getSessionName()).toBe("Current");
	});

	it("keeps the frames a live session finished and ignores its torn tail", async () => {
		const root = path.join(tempRoot, "dsh");
		const dir = await dshSession({
			root,
			id: "session-live",
			cwd: tempRoot,
			compressed: true,
			records: [
				dshPrompt("first prompt", 1_767_225_601_000),
				{
					type: "assistant/message",
					seq: 2,
					time: 1_767_225_602_000,
					data: { message: { role: "assistant", content: [{ type: "text", text: "an answer still streaming" }] } },
				},
			],
		});
		// A frame still being written ends the file; a whole-file decoder rejects it.
		const file = path.join(dir, "session.v4.jsonl.zstd");
		const bytes = await Bun.file(file).bytes();
		await Bun.write(file, bytes.subarray(0, bytes.length - 10));
		const store = new DshSessionStore(root);
		const [info] = await store.list();
		if (!info) throw new Error("fixture was not listed");

		const manager = await store.load(info);

		expect(info.firstMessage).toBe("first prompt");
		expect(manager.getEntries().filter(entry => entry.type === "message")).toHaveLength(1);
	});

	it("imports into the workspace the session ran in", async () => {
		const root = path.join(tempRoot, "dsh");
		const cwd = path.join(tempRoot, "some", "project");
		await fs.mkdir(cwd, { recursive: true });
		await dshSession({ root, id: "session-abc", cwd, title: "Named by DSH", records: [dshPrompt("hello", 1)] });
		const store = new DshSessionStore(root);
		const info = (await store.list())[0];
		if (!info) throw new Error("fixture was not listed");

		const imported = await persistForeignSession(store, info, {
			fallbackCwd: tempRoot,
			sessionDir: path.join(tempRoot, "out"),
			suppressBreadcrumb: true,
		});

		expect(imported.getCwd()).toBe(cwd);
		expect(imported.getSessionName()).toBe("Named by DSH");
		await imported.close();
	});
});
