import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import {
	type ExternalExecutableProbeDependencies,
	probeExternalExecutable,
} from "@musepi/pi-coding-agent/task/external-executable-probe";

function dependencies(
	run: ExternalExecutableProbeDependencies["run"],
	resolved = "D:/tools/codex.exe",
): ExternalExecutableProbeDependencies {
	return {
		which: () => resolved,
		run,
	};
}

describe("external executable probe", () => {
	it("resolves the product from PATH and reports its version", async () => {
		const result = await probeExternalExecutable("", "codex", os.tmpdir(), {
			...dependencies(async (executable, cwd) => {
				expect(executable).toBe("D:/tools/codex.exe");
				expect(cwd).toBe(os.tmpdir());
				return { exitCode: 0, stdout: "codex 1.2.3\n", stderr: "" };
			}),
			which: (command, options) => {
				expect(command).toBe("codex");
				expect(options?.cwd).toBe(os.tmpdir());
				return "D:/tools/codex.exe";
			},
		});

		expect(result).toEqual({ available: true, path: "D:/tools/codex.exe", version: "codex 1.2.3" });
	});

	it("reports a missing explicit executable without starting a process", async () => {
		const result = await probeExternalExecutable("D:/missing/codex.exe", "codex", os.tmpdir(), {
			which: () => null,
			run: async () => {
				throw new Error("must not run");
			},
		});

		expect(result).toEqual({ available: false, reason: "not-found", path: undefined });
	});

	it("returns process failures with bounded diagnostic output", async () => {
		const result = await probeExternalExecutable("codex", "codex", os.tmpdir(), {
			...dependencies(async () => ({ exitCode: 2, stdout: "", stderr: `denied\n${"x".repeat(1000)}` })),
			which: () => "D:/tools/codex.exe",
		});

		expect(result.available).toBe(false);
		if (result.available) throw new Error("probe unexpectedly succeeded");
		expect(result.reason).toBe("failed");
		expect(result.path).toBe("D:/tools/codex.exe");
		expect(result.error).toContain("exited with code 2");
		expect(result.error).toContain("denied");
		expect(result.error?.length).toBeLessThan(600);
	});

	it("runs a real executable through the default process runner", async () => {
		const result = await probeExternalExecutable(process.execPath, "bun", os.tmpdir());

		expect(result.available).toBe(true);
		if (result.available) expect(result.version).toContain(Bun.version);
	});
});
