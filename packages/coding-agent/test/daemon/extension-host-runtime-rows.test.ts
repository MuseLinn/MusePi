/**
 * extensions.list host plugin rows must carry live runtime diagnostics.
 *
 * Host-scope packages run on the process-level cordis runtime, while the user
 * plugin runtime feeds the rest of the list. The two runtimes are folded into
 * one inspection map; without that merge the row still lists as active but
 * `runtime.fiberState` / `runtime.effects` silently disappear at the tenancy
 * boundary.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import { ExtensionService } from "../../src/daemon/services/extension-service";
import { ensureHostPlugins, resetHostPlugins } from "../../src/extensibility/plugins/runtime/host-runtime";
import { isolateAgentDirForTest, restoreAgentDirForTest } from "../helpers/isolate-agent-dir";

interface ListedHostRow {
	name: string;
	kind: string;
	state: string;
	runtime?: { fiberState: string; effects: number; operational: string };
}

describe("extensions.list host plugin runtime rows", () => {
	let agentDir: string;
	let cwd: string;
	let modesDir: string;
	let listed: { extensions: ListedHostRow[] };
	const bundledRoots = process.env.MUSEPI_BUNDLED_PLUGIN_ROOTS;

	beforeAll(async () => {
		agentDir = await isolateAgentDirForTest("omp-host-runtime-row-");
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-host-runtime-cwd-"));
		modesDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-host-runtime-modes-"));
		// The shipped packages, not another suite's fixture tree.
		delete process.env.MUSEPI_BUNDLED_PLUGIN_ROOTS;
		await resetHostPlugins();
		await ensureHostPlugins(process.cwd());

		const service = new ExtensionService({
			settings: () => Settings.isolated(),
			ensureRegistry: async () => {},
			cwd: () => cwd,
			webUrl: () => null,
			webPortFile: () => path.join(agentDir, "web.port"),
			onChanged: () => {},
			modesDir: () => modesDir,
			home: () => os.homedir(),
			defaultPresetId: async () => "",
		});
		listed = (await service.list()) as { extensions: ListedHostRow[] };
	}, 120_000);

	afterAll(async () => {
		await resetHostPlugins();
		if (bundledRoots === undefined) delete process.env.MUSEPI_BUNDLED_PLUGIN_ROOTS;
		else process.env.MUSEPI_BUNDLED_PLUGIN_ROOTS = bundledRoots;
		await Promise.all([
			restoreAgentDirForTest(agentDir),
			fs.rm(cwd, { recursive: true, force: true }),
			fs.rm(modesDir, { recursive: true, force: true }),
		]);
	}, 60_000);

	test("shows the host row's live fiber state and effect count", () => {
		const hmr = listed.extensions.find(entry => entry.name === "hmr");
		expect(hmr).toMatchObject({
			kind: "plugin-module",
			state: "active",
			runtime: { fiberState: "ACTIVE", effects: 1, operational: "running" },
		});

		const sharpshooter = listed.extensions.find(entry => entry.name === "memory-sharpshooter");
		expect(sharpshooter).toMatchObject({
			kind: "plugin-module",
			state: "active",
			runtime: { fiberState: "ACTIVE", effects: 0, operational: "running" },
		});
	});
});
