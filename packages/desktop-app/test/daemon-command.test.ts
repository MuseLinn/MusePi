import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
// daemon.cjs lives outside tsconfig include (electron/) and has no types.
// @ts-expect-error — untyped CJS module (electron/, outside tsconfig include)
import { daemonCommand } from "../electron/daemon.cjs";

/**
 * daemonCommand resolution precedence. The order is
 * **packaged binary → repo checkout → PATH**, and it is load-bearing: a stale
 * PATH shim (a bunx launcher whose global package was uninstalled) still exists
 * and exits instantly with "Module not found", which surfaces to the user as
 * "daemon exited during startup". So the binary inside the install and the
 * checkout the GUI actually runs from both have to beat PATH.
 *
 * These suites run from a repo checkout, which means the checkout candidate is
 * always reachable — PATH can therefore never *win* here, and a test asserting
 * that it does would only be tautological or wrong. What is observable is the
 * precedence between the candidates that exist, plus the shim guard.
 *
 * Fixtures must clear the guard to be accepted: a Windows executable under
 * 256KB is only taken when a sibling `.bunx` script exists (that pairing is
 * what distinguishes a live bun shim from a dead one), so `fatFixture()` writes
 * a realistic size while the small one deliberately proves the rejection path.
 */
const originalCwd = process.cwd();
const originalPath = process.env.PATH;
const originalPlatform = process.platform;
const electronProcess = process as typeof process & { resourcesPath?: string };
const originalResourcesPath = electronProcess.resourcesPath;
const tempDirs: string[] = [];

/** Above the 256KB bun-shim threshold, so the file is taken as a real binary. */
const REAL_BINARY_BYTES = 300 * 1024;

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-daemon-command-"));
	tempDirs.push(dir);
	return dir;
}

/** The executable path daemonCommand would spawn (program + first arg). */
function resolved(): string {
	const cmd = daemonCommand(8300);
	return cmd.program === "bun" ? String(cmd.args[0]) : String(cmd.program);
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

describe("daemon.cjs daemonCommand — resolution precedence", () => {
	it("prefers the daemon packaged inside the install over PATH", async () => {
		const resources = await tempDir();
		const bundled = path.join(resources, "app.asar.unpacked", "vendor", "daemon", "musepi.exe");
		await fs.mkdir(path.dirname(bundled), { recursive: true });
		await fs.writeFile(bundled, Buffer.alloc(REAL_BINARY_BYTES));
		// A PATH candidate exists too — the packaged binary must still win.
		const pathDir = await tempDir();
		await fs.writeFile(path.join(pathDir, "musepi.exe"), Buffer.alloc(REAL_BINARY_BYTES));
		process.env.PATH = pathDir;
		electronProcess.resourcesPath = resources;
		setWindowsPlatform();

		expect(resolved()).toBe(bundled);
	});

	it("prefers the repo checkout over a PATH CLI (the stale-shim rule)", async () => {
		// Running from a checkout, PATH is never trusted: the GUI spawns the
		// cli.ts it was launched from, so a broken global install cannot take
		// the daemon down. Observable as `bun <repo>/packages/coding-agent/src/cli.ts`.
		const pathDir = await tempDir();
		await fs.writeFile(path.join(pathDir, "musepi.exe"), Buffer.alloc(REAL_BINARY_BYTES));
		process.env.PATH = pathDir;
		delete electronProcess.resourcesPath;
		setWindowsPlatform();

		const target = resolved();
		expect(target.endsWith(path.join("coding-agent", "src", "cli.ts"))).toBe(true);
		expect(target).not.toBe(path.join(pathDir, "musepi.exe"));
	});

	it("rejects a bun package shim whose sibling .bunx script is gone", async () => {
		// The dead-shim case the guard exists for: the .exe is present but the
		// package it launched was uninstalled. Below the size threshold with no
		// `.bunx` sibling it must be skipped rather than spawned.
		const resources = await tempDir();
		const bundled = path.join(resources, "app.asar.unpacked", "vendor", "daemon", "musepi.exe");
		await fs.mkdir(path.dirname(bundled), { recursive: true });
		await fs.writeFile(bundled, "GUI executable"); // tiny, no .bunx sibling
		electronProcess.resourcesPath = resources;
		process.env.PATH = "C:\\foo;C:\\bar";
		setWindowsPlatform();

		expect(resolved()).not.toBe(bundled);
	});

	it("never throws and always yields a spawnable target", async () => {
		// No packaged binary, no PATH CLI: the checkout is the last resort, so
		// the GUI can always start *a* daemon (an empty/undefined program would
		// fail in spawn with an opaque error instead).
		process.env.PATH = "C:\\foo;;C:\\bar";
		delete electronProcess.resourcesPath;
		setWindowsPlatform();

		const cmd = daemonCommand(8300);
		expect(typeof cmd.program).toBe("string");
		expect(cmd.program.length).toBeGreaterThan(0);
		expect(cmd.args).toContain("serve");
	});
});
