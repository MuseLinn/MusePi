import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import {
	buildMemoryToolDeveloperInstructions,
	clearMemoryToolDeveloperInstructionsCache,
	getMemoryRoot,
	MEMORY_INSTRUCTIONS_CHARS_PER_TOKEN,
	renderMemoryToolDeveloperInstructionsSnapshot,
	saveLearnedLesson,
} from "@musepi/pi-coding-agent/memories";
import type { ToolSession } from "@musepi/pi-coding-agent/tools";
import { LearnTool } from "@musepi/pi-coding-agent/tools/learn";
import { removeWithRetries } from "@musepi/pi-utils";

/**
 * Memory developer-instructions contract (prompt pluginization — project &
 * volatile context phase).
 *
 * Contract:
 * 1. Length/truncation: the rendered block is bounded by the configured
 *    `memories.summaryInjectionTokenLimit` (approx chars-per-token), marks
 *    clipped text, and drops the lessons when the summary fills the budget.
 * 2. Update triggers refresh: a `learn` save invalidates the per-session
 *    instruction snapshot through the session refresh hook, so the next prompt
 *    rebuild carries the new lesson instead of the frozen one.
 * 3. Refresh failure is contained: a rejecting refresh hook never fails the
 *    lesson write.
 */

describe("memory instructions truncation contract", () => {
	let tmp: string;
	let agentDir: string;
	let settings: Settings;

	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-memory-contract-"));
		agentDir = path.join(tmp, "agent");
		settings = Settings.isolated({ "memory.backend": "local" });
	});
	afterEach(async () => {
		await removeWithRetries(tmp);
	});

	function tokenLimit(): number {
		return settings.get("memories.summaryInjectionTokenLimit") ?? 5000;
	}

	it("bounds a huge summary to the token budget and marks the clip", () => {
		const limit = tokenLimit();
		const huge = `${"summary ".repeat(limit * 2)}\n`;
		const out = renderMemoryToolDeveloperInstructionsSnapshot({ summary: huge, learned: "" }, settings);
		expect(out).toBeDefined();
		expect(out).toContain("[truncated]");
		// Budgeted summary (limit * chars-per-token) plus the marker and the
		// surrounding template — never the raw input.
		expect((out as string).length).toBeLessThanOrEqual(limit * MEMORY_INSTRUCTIONS_CHARS_PER_TOKEN + 1024);
		expect((out as string).length).toBeLessThan(huge.length);
	});

	it("drops the lessons when the truncated summary fills the whole budget", () => {
		const limit = tokenLimit();
		const out = renderMemoryToolDeveloperInstructionsSnapshot(
			{ summary: `${"summary ".repeat(limit * 2)}\n`, learned: "- UNIQUE_LESSON_MARKER" },
			settings,
		);
		expect(out).toBeDefined();
		expect(out).toContain("summary");
		expect(out).not.toContain("UNIQUE_LESSON_MARKER");
	});

	it("keeps summary and lessons intact below the budget with no clip marker", () => {
		const out = renderMemoryToolDeveloperInstructionsSnapshot(
			{ summary: "Short summary.", learned: "- A captured lesson" },
			settings,
		);
		expect(out).toContain("Short summary.");
		expect(out).toContain("- A captured lesson");
		expect(out).not.toContain("[truncated]");
	});

	it("renders nothing for an empty snapshot", () => {
		expect(renderMemoryToolDeveloperInstructionsSnapshot(undefined, settings)).toBeUndefined();
		expect(renderMemoryToolDeveloperInstructionsSnapshot({ summary: "", learned: "" }, settings)).toBeUndefined();
	});

	it("applies the same contract through the disk-backed builder", async () => {
		const limit = tokenLimit();
		const root = getMemoryRoot(agentDir, settings.getCwd());
		await Bun.write(path.join(root, "memory_summary.md"), `${"summary ".repeat(limit * 2)}\n`);
		await saveLearnedLesson(agentDir, settings.getCwd(), { content: "UNIQUE_LESSON_MARKER" });
		const out = await buildMemoryToolDeveloperInstructions(agentDir, settings);
		expect(out).toBeDefined();
		expect(out).toContain("[truncated]");
		expect(out).not.toContain("UNIQUE_LESSON_MARKER");
		expect((out as string).length).toBeLessThanOrEqual(limit * MEMORY_INSTRUCTIONS_CHARS_PER_TOKEN + 1024);
	});
});

describe("memory instructions update triggers a session refresh", () => {
	let tmp: string;
	let agentDir: string;
	let settings: Settings;

	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-memory-refresh-"));
		agentDir = path.join(tmp, "agent");
		settings = Settings.isolated({ "memory.backend": "local" });
	});
	afterEach(async () => {
		await removeWithRetries(tmp);
	});

	function sessionWithFile(sessionFile: string) {
		return { sessionManager: { getSessionFile: () => sessionFile } };
	}

	it("serves a frozen snapshot until the cache is explicitly invalidated", async () => {
		const session = sessionWithFile("session-freeze.jsonl");
		expect(await buildMemoryToolDeveloperInstructions(agentDir, settings, session)).toBeUndefined();

		await saveLearnedLesson(agentDir, settings.getCwd(), { content: "Written after the freeze" });
		// Still frozen: a save alone must not silently rewrite the cached prefix.
		expect(await buildMemoryToolDeveloperInstructions(agentDir, settings, session)).toBeUndefined();

		// The refresh hook clears the per-session snapshot; the next rebuild
		// re-reads disk and carries the new lesson.
		clearMemoryToolDeveloperInstructionsCache(session);
		const out = await buildMemoryToolDeveloperInstructions(agentDir, settings, session);
		expect(out).toContain("- Written after the freeze");
	});

	function localSession(hooks: { refreshMemoryInstructions?: () => Promise<void> } = {}): ToolSession {
		const toolSettings = Settings.isolated({ "autolearn.enabled": true, "memory.backend": "local" });
		spyOn(toolSettings, "getAgentDir").mockReturnValue(agentDir);
		spyOn(toolSettings, "getCwd").mockReturnValue(settings.getCwd());
		return {
			cwd: settings.getCwd(),
			hasUI: false,
			skipPythonPreflight: true,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: toolSettings,
			...hooks,
		};
	}

	it("invokes the session refresh hook after a successful local learn", async () => {
		let refreshCalls = 0;
		const tool = new LearnTool(
			localSession({
				refreshMemoryInstructions: async () => {
					refreshCalls += 1;
				},
			}),
		);
		const result = await tool.execute("1", { memory: "Refresh-triggering lesson" });
		expect(result.content).toBeDefined();
		expect(refreshCalls).toBe(1);
	});

	it("does not invoke the refresh hook when the lesson is empty", async () => {
		let refreshCalls = 0;
		const tool = new LearnTool(
			localSession({
				refreshMemoryInstructions: async () => {
					refreshCalls += 1;
				},
			}),
		);
		await expect(tool.execute("1", { memory: "   " })).rejects.toThrow(/empty/i);
		expect(refreshCalls).toBe(0);
	});

	it("contains a refresh failure: the lesson is still stored and the tool succeeds", async () => {
		const tool = new LearnTool(
			localSession({
				refreshMemoryInstructions: async () => {
					throw new Error("prompt rebuild failed");
				},
			}),
		);
		const result = await tool.execute("1", { memory: "Stored despite refresh failure" });
		const text = result.content.map(block => (block.type === "text" ? block.text : "")).join("");
		expect(text).toContain("Lesson stored");
		const learned = await Bun.file(path.join(getMemoryRoot(agentDir, settings.getCwd()), "learned.md")).text();
		expect(learned).toContain("- Stored despite refresh failure");
	});
});
