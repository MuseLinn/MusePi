import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { MemoryService } from "@musepi/pi-coding-agent/daemon/services/memory-service";
import type { LiveSession } from "@musepi/pi-coding-agent/daemon/session-host";
import { hindsightBackend } from "@musepi/pi-coding-agent/hindsight/backend";
import { getMemoryRoot, saveLearnedLesson } from "@musepi/pi-coding-agent/memories";
import { musememBackend } from "@musepi/pi-coding-agent/memory-backend/musemem-backend";
import { offBackend } from "@musepi/pi-coding-agent/memory-backend/off-backend";
import { memoryBackendCapabilities } from "@musepi/pi-coding-agent/memory-backend/types";
import type { AgentSession } from "@musepi/pi-coding-agent/session/agent-session";
import { getAgentDir, removeWithRetries, setAgentDir } from "@musepi/pi-utils";

describe("MuseMem status, stats and diagnostics", () => {
	let tmp: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "musemem-status-"));
		agentDir = path.join(tmp, "agent");
		cwd = path.join(tmp, "proj");
	});
	afterEach(async () => {
		await removeWithRetries(tmp);
	});

	function sessionSettings(overrides: Record<string, unknown> = {}): Settings {
		return Settings.isolated({ "memory.backend": "musemem", ...overrides } as never);
	}

	it("reports the project scope, state DB, and lesson counts", async () => {
		await saveLearnedLesson(agentDir, cwd, { content: "Project lesson" });
		await saveLearnedLesson(agentDir, cwd, { content: "Global lesson", scope: "global" });

		const status = await musememBackend.status?.({
			agentDir,
			cwd,
			session: { settings: sessionSettings() } as unknown as AgentSession,
		});
		expect(status?.backend).toBe("musemem");
		expect(status?.writable).toBe(true);
		expect(status?.scope).toBe(path.basename(getMemoryRoot(agentDir, cwd)));
		expect(status?.projectLessons).toBe(1);
		expect(status?.globalLessons).toBe(1);
		expect(status?.globalScope).toBe(true);
		expect(status?.summaryBytes).toBe(0);
		expect(status?.message).toContain("project lessons: 1");
		expect(status?.message).toContain("global lessons: 1");
	});

	it("renders project and global lesson counts in stats", async () => {
		const root = getMemoryRoot(agentDir, cwd);
		await fs.mkdir(root, { recursive: true });
		await Bun.write(path.join(root, "memory_summary.md"), "summary text");
		await Bun.write(path.join(root, "MEMORY.md"), "# long term");
		await saveLearnedLesson(agentDir, cwd, { content: "Project lesson" });
		await saveLearnedLesson(agentDir, cwd, { content: "Global lesson", scope: "global" });

		const stats =
			(await musememBackend.stats?.(agentDir, cwd, { settings: sessionSettings() } as unknown as AgentSession)) ??
			"";
		expect(stats).toContain("Project lessons: 1");
		expect(stats).toContain("Global lessons: 1");
		expect(stats).toContain("Summary (memory_summary.md)");
		expect(stats).toContain("Long-term memory (MEMORY.md)");
		expect(stats).toContain("State DB");
	});

	it("warns in diagnostics when no summary or state DB exists", async () => {
		const diagnose =
			(await musememBackend.diagnose?.(agentDir, cwd, { settings: sessionSettings() } as unknown as AgentSession)) ??
			"";
		expect(diagnose).toContain("Backend: musemem");
		expect(diagnose).toContain("Warnings");
		expect(diagnose).toContain("no consolidated summary yet");
		expect(diagnose).toContain("state DB is missing");
	});

	it("marks global lessons as off in stats when musemem.globalScope is false", async () => {
		await saveLearnedLesson(agentDir, cwd, { content: "Global lesson", scope: "global" });
		const stats =
			(await musememBackend.stats?.(agentDir, cwd, {
				settings: sessionSettings({ "musemem.globalScope": false }),
			} as unknown as AgentSession)) ?? "";
		expect(stats).toContain("disabled by musemem.globalScope");
	});
});

describe("backend capabilities follow the implemented hooks", () => {
	it("MuseMem reports stats, diagnostics and a global clear", () => {
		expect(memoryBackendCapabilities(musememBackend)).toEqual({
			stats: true,
			diagnose: true,
			queue: false,
			clearGlobal: true,
		});
	});

	it("off reports nothing beyond status", () => {
		expect(memoryBackendCapabilities(offBackend)).toEqual({
			stats: false,
			diagnose: false,
			queue: false,
			clearGlobal: false,
		});
	});

	it("Hindsight reports a status but no stats-only actions", () => {
		expect(memoryBackendCapabilities(hindsightBackend)).toMatchObject({
			stats: false,
			diagnose: false,
			clearGlobal: false,
		});
	});

	it("the daemon status carries the capabilities so the GUI can hide dead buttons", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "musemem-capabilities-"));
		const agentDir = path.join(tmp, "agent");
		const cwd = path.join(tmp, "proj");
		const previousAgentDir = getAgentDir();
		setAgentDir(agentDir);
		try {
			const settings = Settings.isolated({ "memory.backend": "musemem" });
			const service = new MemoryService({
				cwd: () => cwd,
				settings: () => settings,
				allSessions: () => ([] as LiveSession[]).values(),
			});
			const res = (await service.status({})) as {
				id: string;
				status: { capabilities?: Record<string, boolean> };
			};
			expect(res.id).toBe("musemem");
			expect(res.status.capabilities).toMatchObject({ stats: true, diagnose: true, clearGlobal: true });
		} finally {
			setAgentDir(previousAgentDir);
			await removeWithRetries(tmp);
		}
	});
});

describe("Hindsight status", () => {
	it("reports the configured bank and scoping when the session state exists", async () => {
		const settings = Settings.isolated({ "memory.backend": "hindsight", "hindsight.bankId": "team" });
		const status = await hindsightBackend.status?.({
			agentDir: path.join(os.tmpdir(), "unused-agent"),
			cwd: process.cwd(),
			session: {
				settings,
				getHindsightSessionState: () => undefined,
			} as unknown as AgentSession,
		});
		expect(status?.backend).toBe("hindsight");
		expect(status?.scope).toBeDefined();
		expect(status?.message).toMatch(/Bank:|Hindsight needs hindsight.apiUrl/);
	});
});
