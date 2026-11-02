import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { discoverBundledPluginPaths } from "../src/discovery/builtin";

test("discovers the two plugin roots supplied by a packaged desktop daemon", async () => {
	const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-bundled-plugin-roots-"));
	const previous = process.env.MUSEPI_BUNDLED_PLUGIN_ROOTS;
	try {
		for (const [root, name] of [
			["bundled-plugins", "daemon-plugin"],
			["desktop-plugins", "desktop-plugin"],
		] as const) {
			const pluginDir = path.join(fixture, root, name);
			await Bun.write(
				path.join(pluginDir, "package.json"),
				JSON.stringify({ name, musepi: { extensions: ["./index.ts"] } }),
			);
			await Bun.write(path.join(pluginDir, "index.ts"), "export default function plugin() {}\n");
		}
		process.env.MUSEPI_BUNDLED_PLUGIN_ROOTS = [
			path.join(fixture, "bundled-plugins"),
			path.join(fixture, "desktop-plugins"),
		].join(path.delimiter);

		const discovered = (await discoverBundledPluginPaths()).map(entry => entry.replaceAll("\\", "/"));
		expect(discovered).toContain(
			path.join(fixture, "bundled-plugins", "daemon-plugin", "index.ts").replaceAll("\\", "/"),
		);
		expect(discovered).toContain(
			path.join(fixture, "desktop-plugins", "desktop-plugin", "index.ts").replaceAll("\\", "/"),
		);
	} finally {
		if (previous === undefined) delete process.env.MUSEPI_BUNDLED_PLUGIN_ROOTS;
		else process.env.MUSEPI_BUNDLED_PLUGIN_ROOTS = previous;
		await fs.rm(fixture, { recursive: true, force: true });
	}
});
