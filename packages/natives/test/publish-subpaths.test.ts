import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { prepareNativeCorePackage } from "../../../scripts/ci-release-publish.ts";

function assertSucceeded(result: { exitCode: number; stdout: Buffer; stderr: Buffer }, operation: string): void {
	expect(
		result.exitCode,
		`${operation}\nstdout: ${result.stdout.toString()}\nstderr: ${result.stderr.toString()}`,
	).toBe(0);
}

it("installs every lazy native subpath from the published core tarball", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-published-subpaths-"));
	try {
		const packageDir = path.join(root, "package");
		const packDir = path.join(root, "pack");
		const appDir = path.join(root, "app");
		await fs.mkdir(packDir, { recursive: true });
		await fs.mkdir(appDir, { recursive: true });
		await fs.cp(path.join(import.meta.dir, "../native"), path.join(packageDir, "native"), {
			recursive: true,
			filter: source => !source.endsWith(".node"),
		});
		await fs.copyFile(path.join(import.meta.dir, "../README.md"), path.join(packageDir, "README.md"));
		await fs.copyFile(path.join(import.meta.dir, "../package.json"), path.join(packageDir, "package.json"));

		const manifest = await prepareNativeCorePackage(packageDir, false);
		// Subpath resolution needs neither platform leaves nor development catalogs.
		manifest.optionalDependencies = {};
		manifest.devDependencies = {};
		await Bun.write(path.join(packageDir, "package.json"), JSON.stringify(manifest));

		const packed = Bun.spawnSync([process.execPath, "pm", "pack", "--quiet", "--destination", packDir], {
			cwd: packageDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		assertSucceeded(packed, "pack the release-shaped native core");
		const tarball = (await fs.readdir(packDir)).find(file => file.endsWith(".tgz"));
		expect(tarball).toBeDefined();

		await Bun.write(path.join(appDir, "package.json"), JSON.stringify({ private: true, type: "module" }));
		const installed = Bun.spawnSync([process.execPath, "add", path.join(packDir, tarball!)], {
			cwd: appDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		assertSucceeded(installed, "install the native core tarball");

		const imported = Bun.spawnSync(
			[
				process.execPath,
				"-e",
				`const processTools = await import("@musepi/pi-natives/process");
			const fileLocks = await import("@musepi/pi-natives/file-lock");
			if (typeof processTools.processFromPid !== "function" || typeof processTools.isProcessRunning !== "function" || typeof processTools.waitForProcessExit !== "function") throw new Error("incomplete process export");
			if (typeof fileLocks.tryAcquireFileLock !== "function") throw new Error("incomplete file-lock export");`,
			],
			{
				cwd: appDir,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		assertSucceeded(imported, "import lazy subpaths without a native addon");
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 30_000);
