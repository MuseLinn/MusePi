import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as piUtils from "@musepi/pi-utils";
import { type PackageManagerRunner, PluginManager } from "./manager";

/**
 * A rolled-back install has to leave the plugins directory in a state the next
 * boot can load from. Restoring the manifest, the lockfile, and the one package
 * directory is most of that, but not all of it: the package manager writes the
 * whole dependency tree, so a plugin that was already installed and had nothing
 * to do with the run can have its transitive dependencies hoisted, deduplicated
 * or replaced. That plugin's directory is not in the snapshot, so without a
 * repair the restored files describe the pre-run state while the tree on disk is
 * a mixture of the two.
 *
 * The repair is defined by which flags the second run carries, and it must be
 * reached on every rollback path — including one that failed before the
 * installed package's name was known.
 */
describe("PluginManager rollback repair", () => {
	let dir: string;
	let nodeModules: string;
	let calls: string[][];

	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "plugin-rollback-"));
		nodeModules = path.join(dir, "node_modules");
		calls = [];
		spyOn(piUtils, "getPluginsDir").mockReturnValue(dir);
		spyOn(piUtils, "getPluginsNodeModules").mockReturnValue(nodeModules);
		spyOn(piUtils, "getPluginsPackageJson").mockReturnValue(path.join(dir, "package.json"));
		spyOn(piUtils, "getPluginsLockfile").mockReturnValue(path.join(dir, "musepi-plugins.lock.json"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	/**
	 * A package manager that succeeds without writing anything.
	 *
	 * The install therefore completes its package-manager step and then fails
	 * validation, because the tree it was supposed to write does not exist — the
	 * same observable outcome a real rollback follows, without a package manager
	 * or a network in the test.
	 */
	function stubRunner(): PackageManagerRunner {
		return async argv => {
			calls.push([...argv]);
			return { exitCode: 0, stdoutTail: "", stderrTail: "" };
		};
	}

	it("reinstalls from the restored lockfile when the run had one", async () => {
		await Bun.write(path.join(dir, "bun.lock"), "lock-before-this-run");
		await Bun.write(path.join(dir, "package.json"), JSON.stringify({ dependencies: { "acme-plugin": "1.0.0" } }));
		const manager = new PluginManager(dir, stubRunner());

		await manager.install("acme-plugin").catch(() => undefined);

		// The repair reproduces the restored lock rather than resolving anew, so
		// it must not be allowed to rewrite it.
		expect(calls.some(argv => argv.includes("--frozen-lockfile"))).toBe(true);
		expect(calls.some(argv => argv.includes("--no-save"))).toBe(false);
	});

	it("installs without writing files when the run had no lockfile", async () => {
		// A plugins directory that has never been installed into has no lock. The
		// repair must not create one, or the next boot reads a lock describing a
		// state this directory was never in.
		await Bun.write(path.join(dir, "package.json"), JSON.stringify({ dependencies: { "acme-plugin": "1.0.0" } }));
		const manager = new PluginManager(dir, stubRunner());

		await manager.install("acme-plugin").catch(() => undefined);

		expect(calls.some(argv => argv.includes("--no-save"))).toBe(true);
		expect(calls.some(argv => argv.includes("--frozen-lockfile"))).toBe(false);
	});

	it("still runs the repair when the failure came before the package name was known", async () => {
		// The package manager can fail outright, which leaves no installed name to
		// clean up. The tree was still touched by the attempt, so the repair is
		// not optional on that path.
		await Bun.write(path.join(dir, "bun.lock"), "lock-before-this-run");
		await Bun.write(path.join(dir, "package.json"), JSON.stringify({ dependencies: { "acme-plugin": "1.0.0" } }));
		const manager = new PluginManager(dir, async argv => {
			calls.push([...argv]);
			if (argv[1] === "install" && !argv.includes("--frozen-lockfile")) {
				return { exitCode: 1, stdoutTail: "", stderrTail: "network unreachable" };
			}
			return { exitCode: 0, stdoutTail: "", stderrTail: "" };
		});

		await expect(manager.install("acme-plugin")).rejects.toThrow(/network unreachable/);

		expect(calls.some(argv => argv.includes("--frozen-lockfile"))).toBe(true);
	});
});
