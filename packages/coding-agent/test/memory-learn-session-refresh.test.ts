/**
 * Production learn-refresh wiring contract (real createAgentSession).
 *
 * `LearnTool` calls `session.refreshMemoryInstructions?.()` after a successful
 * lesson save (tools/learn.ts). The production toolSession literal in sdk.ts
 * must wire that hook to `clearMemoryToolDeveloperInstructionsCache(session)` +
 * `session.refreshBaseSystemPrompt()` so the frozen per-session memory
 * instruction snapshot is dropped and the next base prompt carries the new
 * lesson.
 *
 * Unlike memory-instructions-refresh.test.ts — which injects a manual hook into
 * a hand-built ToolSession and therefore masks missing production wiring — this
 * test builds a REAL session through `createAgentSession` (isolated agentDir +
 * in-memory session store) and executes learn through the session's actual
 * tool registry. No hook is injected anywhere.
 *
 * Contract:
 * 1. The session's initial memory prompt is frozen with the pre-seeded lesson.
 * 2. A learn save through the real LearnTool clears the cache and rebuilds the
 *    base system prompt, so the next `session.systemPrompt` contains the new
 *    lesson — and each lesson exactly once (no duplicated memory block).
 * 3. The lesson is stored even when the refresh fails (LearnTool's own catch
 *    contains the failure).
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@musepi/pi-ai";
import { getBundledModel } from "@musepi/pi-catalog/models";
import { ModelRegistry } from "@musepi/pi-coding-agent/config/model-registry";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { getMemoryRoot, saveLearnedLesson } from "@musepi/pi-coding-agent/memories";
import { createAgentSession } from "@musepi/pi-coding-agent/sdk";
import type { AgentSession } from "@musepi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@musepi/pi-coding-agent/session/session-manager";
import type { LearnTool } from "@musepi/pi-coding-agent/tools/learn";
import { removeWithRetries } from "@musepi/pi-utils";

const INITIAL_LESSON = "INITIAL_LESSON_UNIQUE_MARKER";
const NEW_LESSON = "NEW_LESSON_UNIQUE_MARKER";

function occurrences(text: string, needle: string): number {
	return text.split(needle).length - 1;
}

describe("learn refresh wiring in a real session", () => {
	let home: string;
	let projectDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let originalHome: string | undefined;
	let originalUserProfile: string | undefined;
	const sessions: AgentSession[] = [];

	beforeEach(async () => {
		home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "musepi-learn-refresh-home-"));
		projectDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "musepi-learn-refresh-project-"));
		originalHome = process.env.HOME;
		originalUserProfile = process.env.USERPROFILE;
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		// Pre-seed one lesson so the session's initial memory prompt is frozen
		// with a known snapshot before any learn call.
		await saveLearnedLesson(home, projectDir, { content: INITIAL_LESSON });
		authStorage = await AuthStorage.create(path.join(home, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose().catch(() => {});
		authStorage.close();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
		await removeWithRetries(home);
		await removeWithRetries(projectDir);
	});

	async function createMemorySession(): Promise<AgentSession> {
		const settings = Settings.isolated({
			"autolearn.enabled": true,
			"memory.backend": "local",
			"compaction.enabled": false,
		});
		// The local backend resolves the memory root through the settings, so the
		// session must read/write the isolated agentDir and project cwd — never
		// the developer machine's real agent directory.
		spyOn(settings, "getAgentDir").mockReturnValue(home);
		spyOn(settings, "getCwd").mockReturnValue(projectDir);
		const { session } = await createAgentSession({
			cwd: projectDir,
			agentDir: home,
			profileHome: home,
			modelRegistry,
			authStorage,
			// In-memory session store: never touches the production session store.
			sessionManager: SessionManager.inMemory(projectDir),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		sessions.push(session);
		return session;
	}

	it("refreshes the base system prompt with the new lesson after a real learn save", async () => {
		const session = await createMemorySession();
		const initialPrompt = session.systemPrompt.join("\n\n");
		expect(initialPrompt).toContain(INITIAL_LESSON);
		expect(occurrences(initialPrompt, INITIAL_LESSON)).toBe(1);

		// Execute learn through the session's real tool registry — no injected
		// refresh hook anywhere on the tool session.
		const learn = session.getToolByName("learn") as LearnTool | undefined;
		expect(learn).toBeDefined();
		const result = await learn!.execute("learn-refresh-1", { memory: NEW_LESSON });
		const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("");
		expect(text).toContain("Lesson stored");

		const refreshedPrompt = session.systemPrompt.join("\n\n");
		expect(refreshedPrompt).toContain(NEW_LESSON);
		expect(occurrences(refreshedPrompt, NEW_LESSON)).toBe(1);
		expect(refreshedPrompt).toContain(INITIAL_LESSON);
		expect(occurrences(refreshedPrompt, INITIAL_LESSON)).toBe(1);

		// The lesson actually reached the isolated memory root.
		const learned = await Bun.file(path.join(getMemoryRoot(home, projectDir), "learned.md")).text();
		expect(learned).toContain(`- ${NEW_LESSON}`);
	});
});
