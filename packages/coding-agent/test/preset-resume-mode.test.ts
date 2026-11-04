/**
 * Resume must not lose the persisted preset. The CLI reads the session header
 * through `buildSessionOptions`; the daemon rehydrates a history session through
 * `DaemonSessionHost.activate`. Both used to ignore `header.modeId`, so a chat
 * session reopened with the full work prompt and full tool slate.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Args } from "@musepi/pi-coding-agent/cli/args";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { DaemonSessionHost, JOURNAL_DIR } from "@musepi/pi-coding-agent/daemon/session-host";
import { ViewStore, viewStorePath } from "@musepi/pi-coding-agent/daemon/view-store";
import { buildSessionOptions } from "@musepi/pi-coding-agent/main";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { computeDefaultSessionDir } from "@musepi/pi-coding-agent/session/session-paths";
import { FileSessionStorage } from "@musepi/pi-coding-agent/session/session-storage";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "./helpers/isolate-agent-dir";

const CHAT_PERSONA_HEAD = "你是一名简洁的对话助手。";

function resumeArgs(cwd: string): Args {
	return {
		continue: true,
		cwd,
		messages: [],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
	} as unknown as Args;
}

async function writeTranscript(
	workspace: string,
	sessionId: string,
	modeId: string,
	// Tests that do not need the daemon's session discovery keep the file
	// inside the workspace; the daemon suite passes its isolated default root.
	sessionDir: string = path.join(workspace, ".sessions"),
): Promise<{ transcript: string; sessionDir: string }> {
	await fs.promises.mkdir(sessionDir, { recursive: true });
	const transcript = path.join(sessionDir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
	const header = {
		type: "session",
		version: 3,
		id: sessionId,
		timestamp: new Date().toISOString(),
		cwd: workspace,
		modeId,
	};
	const message = JSON.stringify({
		type: "message",
		id: crypto.randomBytes(4).toString("hex"),
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "user",
			timestamp: Date.now(),
			content: [{ type: "text", text: "seed" }],
		},
	});
	await fs.promises.writeFile(transcript, `${JSON.stringify(header)}\n${message}\n`);
	return { transcript, sessionDir };
}

describe("CLI --continue/--resume restores the header preset", () => {
	test("buildSessionOptions carries header.modeId when no --preset is given", async () => {
		const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), "preset-resume-cli-"));
		try {
			const sessionId = crypto.randomUUID();
			const { transcript, sessionDir } = await writeTranscript(workspace, sessionId, "chat");
			const manager = await SessionManager.open(transcript, sessionDir, undefined, { suppressBreadcrumb: true });

			const options = await buildSessionOptions(
				resumeArgs(workspace),
				[],
				manager,
				{} as never,
				Settings.isolated({}),
			);

			expect(options.modeId).toBe("chat");
		} finally {
			await fs.promises.rm(workspace, { recursive: true, force: true });
		}
	});

	test("an explicit --preset still wins over the header preset", async () => {
		const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), "preset-resume-cli-explicit-"));
		try {
			const sessionId = crypto.randomUUID();
			const { transcript, sessionDir } = await writeTranscript(workspace, sessionId, "chat");
			const manager = await SessionManager.open(transcript, sessionDir, undefined, { suppressBreadcrumb: true });
			const args = { ...resumeArgs(workspace), preset: "work" } as Args;

			const options = await buildSessionOptions(args, [], manager, {} as never, Settings.isolated({}));

			expect(options.modeId).toBe("work");
		} finally {
			await fs.promises.rm(workspace, { recursive: true, force: true });
		}
	});
});

describe("daemon activate restores the header preset", () => {
	let isolatedAgentDir = "";
	let modesDir = "";
	let previousModesDir: string | undefined;

	beforeAll(async () => {
		isolatedAgentDir = await isolateAgentDirForTest("preset-activate-mode-");
		modesDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "preset-activate-modes-"));
		previousModesDir = process.env.MUSEPI_MODES_DIR;
		process.env.MUSEPI_MODES_DIR = modesDir;
	});

	afterAll(async () => {
		if (previousModesDir === undefined) delete process.env.MUSEPI_MODES_DIR;
		else process.env.MUSEPI_MODES_DIR = previousModesDir;
		await restoreAgentDirForTest(isolatedAgentDir);
		await fs.promises.rm(modesDir, { recursive: true, force: true });
	}, 30000);

	test("a history session with header.modeId=chat reopens with its persona and narrowed slate", async () => {
		const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), "preset-activate-ws-"));
		const sessionId = crypto.randomUUID();
		const host = new DaemonSessionHost({ cwd: workspace });
		try {
			const { transcript } = await writeTranscript(
				workspace,
				sessionId,
				"chat",
				computeDefaultSessionDir(workspace, new FileSessionStorage()),
			);
			new ViewStore(viewStorePath(JOURNAL_DIR)).upsert(sessionId, {
				cursor: 0,
				entries: [],
				agents: [],
				state: { isStreaming: false, queuedMessageCount: 0, cwd: workspace, participants: [] },
				header: {
					type: "session",
					version: 3,
					id: sessionId,
					timestamp: new Date().toISOString(),
					cwd: workspace,
					modeId: "chat",
				},
			} as unknown as Parameters<ViewStore["upsert"]>[1]);

			const live = await host.activate(sessionId);
			expect(live.agentSession.systemPrompt.join("\n")).toContain(CHAT_PERSONA_HEAD);
			expect(live.agentSession.getActiveToolNames()).not.toContain("read");
			host.close(sessionId);
			await Bun.sleep(200);
			await fs.promises.rm(transcript, { force: true });
		} finally {
			host.dispose();
			new ViewStore(viewStorePath(JOURNAL_DIR)).remove(sessionId);
			await fs.promises.rm(path.join(JOURNAL_DIR, `${sessionId}.journal.jsonl`), { force: true }).catch(() => {});
			await fs.promises.rm(computeDefaultSessionDir(workspace, new FileSessionStorage()), {
				recursive: true,
				force: true,
			});
			await fs.promises.rm(workspace, { recursive: true, force: true });
		}
	}, 90000);
});
