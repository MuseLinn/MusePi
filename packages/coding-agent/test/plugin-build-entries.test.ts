import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@musepi/pi-utils";

describe("plugin package entry checks", () => {
	let fixtureRoot: string;
	let packageRoot: string;
	let pluginDir: string;
	let scriptPath: string;

	beforeEach(async () => {
		fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-plugin-entry-check-"));
		packageRoot = path.join(fixtureRoot, "packages/coding-agent");
		pluginDir = path.join(packageRoot, "src/plugins/shell/tool-test");
		scriptPath = path.join(packageRoot, "scripts/build-plugins.ts");
		await fs.mkdir(path.dirname(scriptPath), { recursive: true });
		await fs.mkdir(path.join(pluginDir, "lib/types"), { recursive: true });
		await Bun.write(path.join(packageRoot, "tsconfig.plugin-host.json"), "{}\n");
		await Bun.write(scriptPath, await Bun.file(path.join(process.cwd(), "scripts/build-plugins.ts")).text());
		await Bun.write(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "musepi-tool-test",
				main: "./lib/index.js",
				types: "./lib/types/index.d.ts",
			}),
		);
		await Bun.write(path.join(pluginDir, "lib/index.js"), "export {};\n");
	});

	afterEach(async () => {
		await removeWithRetries(fixtureRoot);
	});

	test("rejects a missing declared type entry even when the runtime entry exists", () => {
		const result = Bun.spawnSync(["bun", scriptPath, "--check"], {
			cwd: packageRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("shell/tool-test");
		expect(result.stderr.toString()).toContain("lib/types/index.d.ts");
	});

	test("counts a package once when both declared entries are missing", async () => {
		await fs.rm(path.join(pluginDir, "lib/index.js"));
		const result = Bun.spawnSync(["bun", scriptPath, "--check"], {
			cwd: packageRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr.toString()).toContain("failed for 1 of 1 package(s)");
	});

	test("accepts a package whose declared runtime and type entries both exist", async () => {
		await Bun.write(path.join(pluginDir, "lib/types/index.d.ts"), "export {};\n");
		const result = Bun.spawnSync(["bun", scriptPath, "--check"], {
			cwd: packageRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain("verified 1 package(s)");
	});
});
