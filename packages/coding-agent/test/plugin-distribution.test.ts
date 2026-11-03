import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { runPluginCommand } from "@musepi/pi-coding-agent/cli/plugin-cli";
import { packPlugin } from "@musepi/pi-coding-agent/cli/plugin-pack";
import { PluginInstallService } from "@musepi/pi-coding-agent/daemon/services/plugin-install-service";
import type { PluginInstallView } from "@musepi/pi-coding-agent/extensibility/plugins/management/plugin-install-machine";
import * as piUtils from "@musepi/pi-utils";
import { removeWithRetries } from "@musepi/pi-utils";

interface PackedPlugin {
	name: string;
	version: string;
	filename: string;
	path: string;
}

describe("plugin pack to plugins.install distribution", () => {
	let tmpRoot: string;
	let sourceDir: string;
	let outputDir: string;
	let output: string[];

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-plugin-distribution-"));
		sourceDir = path.join(tmpRoot, "source");
		outputDir = path.join(tmpRoot, "dist");
		const pluginsDir = path.join(tmpRoot, "plugins");
		await fs.mkdir(path.join(pluginsDir, "node_modules"), { recursive: true });
		await fs.mkdir(sourceDir, { recursive: true });

		vi.spyOn(piUtils, "getAgentDir").mockReturnValue(tmpRoot);
		vi.spyOn(piUtils, "getPluginsDir").mockReturnValue(pluginsDir);
		vi.spyOn(piUtils, "getPluginsNodeModules").mockReturnValue(path.join(pluginsDir, "node_modules"));
		vi.spyOn(piUtils, "getPluginsPackageJson").mockReturnValue(path.join(pluginsDir, "package.json"));
		vi.spyOn(piUtils, "getPluginsLockfile").mockReturnValue(path.join(tmpRoot, "musepi-plugins.lock.json"));
		vi.spyOn(piUtils, "getProjectDir").mockReturnValue(tmpRoot);
		vi.spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(path.join(tmpRoot, "plugin-overrides.json"));
		output = [];
		vi.spyOn(console, "log").mockImplementation(message => {
			output.push(String(message));
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(tmpRoot);
	});

	test("packs a pure Cordis plugin whose tarball installs through the GUI service", async () => {
		await Bun.write(
			path.join(sourceDir, "package.json"),
			JSON.stringify({
				name: "cordis-distribution",
				version: "1.2.3",
				files: ["index.ts"],
				musepi: { extensions: ["./index.ts"] },
			}),
		);
		await Bun.write(
			path.join(sourceDir, "index.ts"),
			[
				'export const name = "cordis-distribution";',
				'export const inject = ["commands"];',
				'export function apply(pi) { pi.registerCommand("distributed", { handler: async () => {} }); }',
			].join("\n"),
		);

		await runPluginCommand({
			action: "pack",
			args: [sourceDir],
			flags: { json: true, output: outputDir },
		});
		const packed = JSON.parse(output.join("\n")) as PackedPlugin;
		expect(packed).toEqual({
			name: "cordis-distribution",
			version: "1.2.3",
			filename: "cordis-distribution-1.2.3.tgz",
			path: path.join(outputDir, "cordis-distribution-1.2.3.tgz"),
		});
		expect((await fs.stat(packed.path)).size).toBeGreaterThan(0);

		const states: PluginInstallView[] = [];
		let invalidated = 0;
		let changed = 0;
		const service = new PluginInstallService({
			cwd: () => tmpRoot,
			invalidatePluginCaches: () => {
				invalidated += 1;
			},
			onChanged: () => {
				changed += 1;
			},
			onInstallState: payload => states.push(payload as unknown as PluginInstallView),
			onInstallOutput: () => {},
		});
		try {
			const { installId } = service.install({ spec: packed.path });
			const deadline = Date.now() + 15_000;
			let view: PluginInstallView | undefined;
			while (Date.now() < deadline) {
				view = service.installStatus().installs.find(candidate => candidate.installId === installId);
				if (view && view.state !== "inspecting" && view.state !== "installing") break;
				await Bun.sleep(20);
			}
			expect(view).toMatchObject({
				state: "done",
				name: "cordis-distribution",
				version: "1.2.3",
				specKind: "tarball",
			});
			expect(invalidated).toBe(1);
			expect(changed).toBe(1);
			expect(states.at(-1)?.state).toBe("done");
			const lock = await Bun.file(path.join(tmpRoot, "musepi-plugins.lock.json")).json();
			expect(lock.plugins["cordis-distribution"]).toMatchObject({ version: "1.2.3", enabled: true });
		} finally {
			await service.stop();
		}
	}, 30_000);

	test("refuses to pack a manifest whose extension entry is absent", async () => {
		await Bun.write(
			path.join(sourceDir, "package.json"),
			JSON.stringify({
				name: "broken-distribution",
				version: "1.0.0",
				musepi: { extensions: ["./missing.ts"] },
			}),
		);

		await expect(packPlugin(sourceDir, outputDir)).rejects.toThrow(/missing extension entries: \.\/missing\.ts/);
		expect(await Bun.file(path.join(outputDir, "broken-distribution-1.0.0.tgz")).exists()).toBe(false);
	});
});
