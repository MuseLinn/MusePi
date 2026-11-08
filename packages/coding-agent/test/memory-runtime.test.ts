import { describe, expect, it } from "bun:test";
import { TempDir } from "@musepi/pi-utils";
import { Settings } from "../src/config/settings";
import { createMemoryRuntimeContext } from "../src/memory-backend/runtime";

describe("MemoryRuntimeContext", () => {
	it("reports off and exposes no-op maintenance without a session", async () => {
		const dir = TempDir.createSync("@memory-runtime-off-");
		try {
			const runtime = createMemoryRuntimeContext({ agentDir: dir.path(), cwd: dir.path() });
			expect(await runtime.backend()).toBe("off");
			expect(await runtime.status()).toMatchObject({ backend: "off", active: false });
			expect(await runtime.view()).toBeUndefined();
			expect(await runtime.stats()).toBeUndefined();
			expect(await runtime.diagnose()).toBeUndefined();
			await expect(runtime.clear()).resolves.toBeUndefined();
			await expect(runtime.enqueue()).resolves.toBeUndefined();
		} finally {
			await dir.remove();
		}
	});

	it("routes backend selection and view through the configured backend", async () => {
		const dir = TempDir.createSync("@memory-runtime-local-");
		try {
			const settings = Settings.isolated({ "memory.backend": "local" });
			const session = {
				settings,
				sessionManager: { getCwd: () => dir.path(), getSessionFile: () => null },
			} as never;
			const runtime = createMemoryRuntimeContext({ agentDir: dir.path(), cwd: dir.path(), session });
			expect(await runtime.backend()).toBe("local");
			expect(await runtime.status()).toMatchObject({ backend: "local", writable: true, searchable: false });
			expect(await runtime.view()).toBeUndefined();
		} finally {
			await dir.remove();
		}
	});
});
