import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as piUtils from "@musepi/pi-utils";
import { type PackageManagerRunner, PluginManager } from "./manager";

/**
 * Build-script approval at the manager layer: the plugins project defaults
 * to denying lifecycle scripts, surfaces what bun blocked, and merges
 * person-approved names before installing.
 *
 * The package-manager seam is stubbed (no bun, no network); the filesystem
 * is a real temp dir isolated through the same `getPlugins*` spies the
 * rollback tests use. A minimal `node_modules/acme-plugin/package.json`
 * fixture carries the install past manifest resolution so the success path
 * (including the post-install `bun pm untrusted` probe) is exercised.
 */
describe("PluginManager build approval", () => {
	let dir: string;
	let calls: string[][];

	const UNTRUSTED = [
		"bun pm untrusted v1.4.2",
		"",
		".\\node_modules\\core-js @3.39.0",
		' » [postinstall]: node -e "x"',
		"",
	].join("\n");

	function stubRunner(): PackageManagerRunner {
		return async argv => {
			calls.push([...argv]);
			if (argv.includes("untrusted")) {
				return { exitCode: 0, stdoutTail: UNTRUSTED, stderrTail: "" };
			}
			return { exitCode: 0, stdoutTail: "", stderrTail: "" };
		};
	}

	async function packageJson(): Promise<Record<string, unknown>> {
		return (await Bun.file(path.join(dir, "package.json")).json()) as Record<string, unknown>;
	}

	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "plugin-build-approval-"));
		calls = [];
		spyOn(piUtils, "getPluginsDir").mockReturnValue(dir);
		spyOn(piUtils, "getPluginsNodeModules").mockReturnValue(path.join(dir, "node_modules"));
		spyOn(piUtils, "getPluginsPackageJson").mockReturnValue(path.join(dir, "package.json"));
		spyOn(piUtils, "getPluginsLockfile").mockReturnValue(path.join(dir, "musepi-plugins.lock.json"));
		await Bun.write(
			path.join(dir, "node_modules", "acme-plugin", "package.json"),
			JSON.stringify({ name: "acme-plugin", version: "1.0.0" }),
		);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("creates the plugins project default-deny and reports blocked builds", async () => {
		const manager = new PluginManager(dir, stubRunner());
		const installed = await manager.install("acme-plugin");

		expect((await packageJson()).trustedDependencies).toEqual([]);
		expect(installed.pendingBuilds).toEqual(["core-js"]);
		expect(calls.some(argv => argv.includes("untrusted"))).toBe(true);
	});

	it("merges approved builds before installing and preserves them", async () => {
		const manager = new PluginManager(dir, stubRunner());
		await manager.install("acme-plugin", { approvedBuilds: ["core-js", "core-js", " "] });

		expect((await packageJson()).trustedDependencies).toEqual(["core-js"]);
	});

	it("never revokes existing approvals", async () => {
		await Bun.write(
			path.join(dir, "package.json"),
			JSON.stringify({ name: "musepi-plugins", dependencies: {}, trustedDependencies: ["old"] }),
		);
		const manager = new PluginManager(dir, stubRunner());
		await manager.install("acme-plugin", { approvedBuilds: ["core-js"] });

		expect((await packageJson()).trustedDependencies).toEqual(["old", "core-js"]);
	});
});
