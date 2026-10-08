import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@musepi/pi-agent-core";
import type { UsageReport } from "@musepi/pi-ai";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@musepi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@musepi/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@musepi/pi-coding-agent/modes/theme/theme";
import type { AgentSessionEvent } from "@musepi/pi-coding-agent/session/agent-session";
import { AgentSession } from "@musepi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@musepi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@musepi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import { Text } from "@musepi/pi-tui";
import { TempDir } from "@musepi/pi-utils";

const usageReports: UsageReport[] = [
	{
		provider: "openai-codex",
		fetchedAt: 1_700_000_000_000,
		limits: [
			{
				id: "codex-weekly",
				label: "Weekly",
				scope: { provider: "openai-codex", tier: "pro", accountId: "acct-1" },
				window: { id: "weekly", label: "weekly" },
				amount: { remainingFraction: 0.25, unit: "requests" },
				status: "ok",
			},
		],
		metadata: { email: "user@example.com" },
	},
];

describe("issue #6767 /usage output during streaming", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let streaming = true;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-issue-6767-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 test model");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		streaming = true;
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
		mode = new InteractiveMode(session, "test");
		mode.isInitialized = true;
		mode.ui.requestRender = vi.fn();
	});

	afterEach(async () => {
		mode?.stop();
		HistoryStorage.resetInstance();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("keeps /usage out of the transcript entirely, streaming or not", async () => {
		// The original bug (#6767) was /usage printing into the conversation while
		// a turn was still streaming, which duplicated in native scrollback. The
		// command now opens a dashboard instead of writing to the transcript at
		// any point — so the property to hold is that the transcript is untouched,
		// not that a deferred row appears once the turn ends. This test asserted
		// the older deferred-row shape and has been red since /usage became a
		// dashboard; it is restated here against the contract that replaced it.
		const streamedReply = new Text("agent is streaming", 0, 0);
		mode.chatContainer.addChild(streamedReply);

		await mode.handleUsageCommand(usageReports);

		// Mid-stream: nothing added. The dashboard is a separate surface, so a
		// block appearing here is what would duplicate.
		expect(mode.chatContainer.children).toEqual([streamedReply]);

		streaming = false;
		await mode.eventController.handleEvent({ type: "agent_end", messages: [] } as AgentSessionEvent);

		// After the turn ends: still nothing. The dashboard does not become a
		// transcript row once it is safe to print one.
		expect(mode.chatContainer.children).toEqual([streamedReply]);
		const transcript = mode.chatContainer.render(80).join("\n");
		expect(transcript).not.toMatch(/Usage \(/);
	});
});
