import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@musepi/pi-coding-agent/config/settings";
import { registerMemoryBackendProvider } from "@musepi/pi-coding-agent/memory-backend/providers";
import type { MemoryBackend } from "@musepi/pi-coding-agent/memory-backend/types";
import { CommandController } from "@musepi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@musepi/pi-coding-agent/modes/types";

function createMemoryContext(backend: string) {
	const showWarning = vi.fn();
	const ctx = {
		settings: Settings.isolated({ "memory.backend": backend }),
		sessionManager: { getCwd: () => "/tmp/project" },
		session: undefined,
		showWarning,
	} as unknown as InteractiveModeContext;
	return { ctx, showWarning };
}

describe("CommandController /memory stats and /memory diagnose", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("tells the user memory is off instead of naming a nonexistent 'off backend' for /memory stats", async () => {
		const { ctx, showWarning } = createMemoryContext("off");
		const controller = new CommandController(ctx);

		await controller.handleMemoryCommand("/memory stats");

		expect(showWarning).toHaveBeenCalledWith("Memory backend is off — there is nothing to show.");
	});

	it("tells the user memory is off instead of naming a nonexistent 'off backend' for /memory diagnose", async () => {
		const { ctx, showWarning } = createMemoryContext("off");
		const controller = new CommandController(ctx);

		await controller.handleMemoryCommand("/memory diagnose");

		expect(showWarning).toHaveBeenCalledWith("Memory backend is off — there is nothing to show.");
	});

	it("still names the backend when it has no stats hook", async () => {
		const { ctx, showWarning } = createMemoryContext("musemem");
		const dispose = registerMemoryBackendProvider({
			id: "musemem",
			create: () =>
				({
					id: "musemem",
					start() {},
					async buildDeveloperInstructions() {},
					async clear() {},
					async enqueue() {},
				}) as MemoryBackend,
		});
		try {
			const controller = new CommandController(ctx);
			await controller.handleMemoryCommand("/memory stats");
			expect(showWarning).toHaveBeenCalledWith("Memory stats is not available for the musemem backend.");
		} finally {
			dispose();
		}
	});
});
