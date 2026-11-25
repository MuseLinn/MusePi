import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { MemoryService } from "@musepi/pi-coding-agent/daemon/services/memory-service";
import type { LiveSession } from "@musepi/pi-coding-agent/daemon/session-host";
import {
	buildMemoryToolDeveloperInstructions,
	clearGlobalMemoryData,
	getGlobalMemoryRoot,
	getMemoryRoot,
	saveLearnedLesson,
} from "@musepi/pi-coding-agent/memories";
import { isGlobalMemoryScopeAvailable } from "@musepi/pi-coding-agent/memory-backend/global-scope";
import { getAgentDir, removeWithRetries, setAgentDir } from "@musepi/pi-utils";

describe("MuseMem cross-project lessons", () => {
	let tmp: string;
	let agentDir: string;
	let cwdA: string;
	let cwdB: string;

	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "musemem-global-"));
		agentDir = path.join(tmp, "agent");
		cwdA = path.join(tmp, "proj-a");
		cwdB = path.join(tmp, "proj-b");
	});
	afterEach(async () => {
		await removeWithRetries(tmp);
	});

	async function settingsFor(cwd: string, overrides: Record<string, unknown> = {}): Promise<Settings> {
		const settings = Settings.isolated({ "memory.backend": "musemem", ...overrides } as never);
		await settings.reloadForCwd(cwd);
		return settings;
	}

	it("migrates the former local backend id and the legacy enabled flag", () => {
		expect(Settings.isolated({ memory: { backend: "local" } } as never).get("memory.backend")).toBe("musemem");
		expect(Settings.isolated({ memories: { enabled: true } } as never).get("memory.backend")).toBe("musemem");
		expect(Settings.isolated({ memories: { enabled: false } } as never).get("memory.backend")).toBe("off");
	});

	it("writes a global lesson to _global with its source, leaving the project file untouched", async () => {
		await saveLearnedLesson(agentDir, cwdA, {
			content: "PowerShell variables expand before bash sees them",
			scope: "global",
		});

		const globalText = await Bun.file(path.join(getGlobalMemoryRoot(agentDir), "learned.md")).text();
		expect(globalText).toContain("- PowerShell variables expand before bash sees them");
		expect(globalText).toMatch(/_\(from proj-a, \d{4}-\d{2}-\d{2}\)_/);
		expect(await Bun.file(path.join(getMemoryRoot(agentDir, cwdA), "learned.md")).exists()).toBe(false);
	});

	it("injects project lessons before global ones, and the global one reaches another project", async () => {
		await saveLearnedLesson(agentDir, cwdA, { content: "Project A uses a 60s gateway timeout" });
		await saveLearnedLesson(agentDir, cwdA, {
			content: "Bash strips dollar signs in double quotes on Windows",
			scope: "global",
		});

		const forA = (await buildMemoryToolDeveloperInstructions(agentDir, await settingsFor(cwdA))) ?? "";
		expect(forA).toContain("Project A uses a 60s gateway timeout");
		expect(forA).toContain("Bash strips dollar signs in double quotes on Windows");
		expect(forA.indexOf("Project A uses a 60s gateway timeout")).toBeLessThan(
			forA.indexOf("Bash strips dollar signs in double quotes on Windows"),
		);
		expect(forA).toContain("Cross-project lessons");

		const forB = (await buildMemoryToolDeveloperInstructions(agentDir, await settingsFor(cwdB))) ?? "";
		expect(forB).toContain("Bash strips dollar signs in double quotes on Windows");
		expect(forB).not.toContain("Project A uses a 60s gateway timeout");
	});

	it("keeps global lessons out of both the gate and the prompt when musemem.globalScope is off", async () => {
		await saveLearnedLesson(agentDir, cwdA, {
			content: "Global fact that should stay hidden",
			scope: "global",
		});
		const settings = await settingsFor(cwdA, { "musemem.globalScope": false });

		expect(isGlobalMemoryScopeAvailable({ settings })).toBe(false);
		const out = (await buildMemoryToolDeveloperInstructions(agentDir, settings)) ?? "";
		expect(out).not.toContain("Global fact that should stay hidden");
	});

	it("clears the shared file without touching project lessons", async () => {
		await saveLearnedLesson(agentDir, cwdA, { content: "Project lesson" });
		await saveLearnedLesson(agentDir, cwdA, { content: "Shared lesson", scope: "global" });

		await clearGlobalMemoryData(agentDir);

		expect(await Bun.file(path.join(getGlobalMemoryRoot(agentDir), "learned.md")).exists()).toBe(false);
		const projectText = await Bun.file(path.join(getMemoryRoot(agentDir, cwdA), "learned.md")).text();
		expect(projectText).toContain("- Project lesson");
	});

	it("clears only the shared file through the daemon memory service", async () => {
		await saveLearnedLesson(agentDir, cwdA, { content: "Project daemon lesson" });
		await saveLearnedLesson(agentDir, cwdA, { content: "Global daemon lesson", scope: "global" });

		const previousAgentDir = getAgentDir();
		setAgentDir(agentDir);
		try {
			const settings = await settingsFor(cwdA);
			const service = new MemoryService({
				cwd: () => cwdA,
				settings: () => settings,
				allSessions: () => ([] as LiveSession[]).values(),
			});
			await service.clear({ scope: "global" });
		} finally {
			setAgentDir(previousAgentDir);
		}

		expect(await Bun.file(path.join(getGlobalMemoryRoot(agentDir), "learned.md")).exists()).toBe(false);
		expect(await Bun.file(path.join(getMemoryRoot(agentDir, cwdA), "learned.md")).text()).toContain(
			"- Project daemon lesson",
		);
	});

	it("deduplicates the same global fact by body when it is learned again", async () => {
		await saveLearnedLesson(agentDir, cwdA, { content: "Same global fact", scope: "global" });
		await saveLearnedLesson(agentDir, cwdB, { content: "Same global fact", scope: "global" });

		const lines = (await Bun.file(path.join(getGlobalMemoryRoot(agentDir), "learned.md")).text()).trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("Same global fact");
	});
});
