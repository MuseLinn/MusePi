import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let fakeHome = "";
vi.mock("node:os", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:os")>();
	return { ...original, homedir: () => fakeHome };
});

describe("import-claude", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "import-claude-"));
		fakeHome = tempDir;
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	// Each test fresh-imports to avoid module-level CLAUDE_DIR caching
	async function freshScanClaudeConfig() {
		vi.resetModules();
		const mod = await import("../src/foreign-sessions/import-claude.ts");
		return mod.scanClaudeConfig();
	}

	it("returns null settings and empty skills when no claude config exists", async () => {
		const result = await freshScanClaudeConfig();
		expect(result.settings).toBeNull();
		expect(result.skills).toEqual([]);
	});

	it("detects MCP servers from settings.json with proper type field", async () => {
		const claudeDir = join(tempDir, ".claude");
		mkdirSync(claudeDir, { recursive: true });
		writeFileSync(
			join(claudeDir, "settings.json"),
			JSON.stringify({
				mcpServers: {
					"my-server": {
						type: "stdio",
						command: "node",
						args: ["server.js"],
					},
				},
			}),
			"utf-8",
		);

		const result = await freshScanClaudeConfig();
		expect(result.settings).not.toBeNull();
		expect(result.settings!.mcpServers).toHaveLength(1);
		expect(result.settings!.mcpServers[0].name).toBe("my-server");
		expect(result.settings!.mcpServers[0].transport).toBe("stdio");
	});

	it("scans skills from the claude skills directory", async () => {
		const claudeDir = join(tempDir, ".claude");
		const skillsDir = join(claudeDir, "skills");
		mkdirSync(skillsDir, { recursive: true });
		writeFileSync(join(skillsDir, "my-skill.md"), "# My Skill\nA test skill.", "utf-8");

		const result = await freshScanClaudeConfig();
		expect(result.skills.length).toBeGreaterThanOrEqual(1);
		expect(result.skills[0].name).toBe("my-skill");
	});

	it("returns ClaudeImportPreview interface correctly", async () => {
		const result = await freshScanClaudeConfig();
		expect(result).toHaveProperty("settings");
		expect(result).toHaveProperty("skills");
		expect(Array.isArray(result.skills)).toBe(true);
	});
});
