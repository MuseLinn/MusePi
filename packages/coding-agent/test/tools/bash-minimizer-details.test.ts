import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@musepi/pi-coding-agent/config/settings";
import * as statsModule from "@musepi/pi-coding-agent/session/shell-minimizer-stats";
import { BashTool, type BashToolDetails } from "@musepi/pi-coding-agent/tools/bash";

let tempDir = "";

beforeEach(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bash-minimizer-details-"));
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: tempDir });
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("BashTool minimization details", () => {
	it("exposes native byte counts and the persisted raw artifact in the public tool result", async () => {
		const settings = await Settings.init({ inMemory: true, cwd: tempDir });
		const settingsPath = path.join(tempDir, "minimizer.toml");
		fs.writeFileSync(
			settingsPath,
			'schema_version = 1\n[filters.printf]\nmatch_command = "^printf$"\nhead_lines = 2\n',
		);
		settings.set("shellMinimizer.settingsPath", settingsPath);
		settings.set("shellMinimizer.only", ["printf"]);
		vi.spyOn(statsModule, "recordShellMinimization").mockResolvedValue(undefined);
		const artifactPath = path.join(tempDir, "42.bash-original.txt");
		const session = {
			settings,
			cwd: tempDir,
			skills: [],
			getSessionId: () => "s1",
			getArtifactsDir: () => tempDir,
			isToolActive: () => false,
			allocateOutputArtifact: async () => ({ id: "42", path: artifactPath }),
		};
		const tool = new BashTool(session as unknown as ConstructorParameters<typeof BashTool>[0]);

		const result = await tool.execute("call-1", { command: "printf 'hello\\n%.0s' {1..200}" });

		expect(result.details).toMatchObject({
			minimization: { filter: "pipeline", inputBytes: 1200, outputBytes: 33, artifactId: "42" },
		} satisfies Partial<BashToolDetails>);
		expect(fs.readFileSync(artifactPath, "utf8")).toHaveLength(1200);
	});
});
