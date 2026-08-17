/**
 * Daemon sessions must behave like interactive ones: project/global
 * SYSTEM.md and APPEND_SYSTEM.md are merged into the session prompt inputs
 * (TUI parity — main.ts buildSessionOptions does the same). Test the shared
 * module function directly with a scratch project dir.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sessionPromptInputs } from "../../src/daemon/server";

async function tmpDir(): Promise<string> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "daemon-prompt-"));
	return dir;
}

describe("sessionPromptInputs", () => {
	test("merges project SYSTEM.md and APPEND_SYSTEM.md", async () => {
		const dir = await tmpDir();
		try {
			const omp = path.join(dir, ".musepi");
			await fs.promises.mkdir(omp, { recursive: true });
			await fs.promises.writeFile(path.join(omp, "SYSTEM.md"), "You are the project's custom agent.");
			await fs.promises.writeFile(path.join(omp, "APPEND_SYSTEM.md"), "Remember the house style.");

			const inputs = await sessionPromptInputs(dir);
			expect(inputs.customSystemPrompt).toContain("You are the project's custom agent.");
			expect(inputs.appendSystemPrompt).toContain("Remember the house style.");
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("returns empty when no prompt files exist", async () => {
		const dir = await tmpDir();
		try {
			const inputs = await sessionPromptInputs(dir);
			expect(inputs.customSystemPrompt).toBeUndefined();
			expect(inputs.appendSystemPrompt).toBeUndefined();
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});

	test("project file wins over global", async () => {
		const dir = await tmpDir();
		try {
			const omp = path.join(dir, ".musepi");
			await fs.promises.mkdir(omp, { recursive: true });
			await fs.promises.writeFile(path.join(omp, "SYSTEM.md"), "Project-level system prompt.");

			const inputs = await sessionPromptInputs(dir);
			expect(inputs.customSystemPrompt).toContain("Project-level");
			// Global must not override the project file.
			expect(inputs.customSystemPrompt).not.toContain("global");
		} finally {
			await fs.promises.rm(dir, { recursive: true, force: true });
		}
	});
});
