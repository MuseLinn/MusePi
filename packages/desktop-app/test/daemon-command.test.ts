import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
// daemon.cjs lives outside tsconfig include (electron/) and has no types.
// @ts-expect-error — untyped CJS module (electron/, outside tsconfig include)
import { daemonCommand } from "../electron/daemon.cjs";

const originalCwd = process.cwd();
const originalPath = process.env.PATH;
const originalPlatform = process.platform;
const electronProcess = process as typeof process & { resourcesPath?: string };
const originalResourcesPath = electronProcess.resourcesPath;
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-daemon-command-"));
	tempDirs.push(dir);
	return dir;
}

function setWindowsPlatform(): void {
	Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
}

afterEach(async () => {
	process.chdir(originalCwd);
	process.env.PATH = originalPath;
	Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
	if (originalResourcesPath === undefined) {
		delete electronProcess.resourcesPath;
	} else {
		electronProcess.resourcesPath = originalResourcesPath;
	}
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { force: true, recursive: true })));
});

describe("daemon.cjs daemonCommand — Windows PATH resolution", () => {
	it("ignores empty PATH entries instead of resolving musepi.exe from cwd", async () => {
		const cwd = await tempDir();
		const resources = await tempDir();
		const bundled = path.join(resources, "app.asar.unpacked", "vendor", "daemon", "musepi.exe");
		await fs.writeFile(path.join(cwd, "musepi.exe"), "GUI executable");
		await fs.mkdir(path.dirname(bundled), { recursive: true });
		await fs.writeFile(bundled, "bundled daemon");
		process.chdir(cwd);
		process.env.PATH = "C:\\foo;;C:\\bar";
		electronProcess.resourcesPath = resources;
		setWindowsPlatform();

		expect(daemonCommand(8300).program).toBe(bundled);
	});

	it("uses the resolved executable for a real PATH CLI", async () => {
		const cliDir = await tempDir();
		const cli = path.join(cliDir, "musepi.exe");
		await fs.writeFile(cli, "CLI executable");
		process.env.PATH = cliDir;
		setWindowsPlatform();

		expect(daemonCommand(8300).program).toBe(path.resolve(cli));
	});

	it("falls back to the bundled daemon when PATH has no CLI", async () => {
		const resources = await tempDir();
		const bundled = path.join(resources, "app.asar.unpacked", "vendor", "daemon", "musepi.exe");
		await fs.mkdir(path.dirname(bundled), { recursive: true });
		await fs.writeFile(bundled, "bundled daemon");
		process.env.PATH = "C:\\foo;C:\\bar";
		electronProcess.resourcesPath = resources;
		setWindowsPlatform();

		expect(daemonCommand(8300).program).toBe(bundled);
	});
});
