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
		// `all` is the inventory view: host-scope packages ship too.
		expect((await discoverBundledPluginPaths({ scope: "all" })).length).toBe(discovered.length);
	} finally {
		if (previous === undefined) delete process.env.MUSEPI_BUNDLED_PLUGIN_ROOTS;
		else process.env.MUSEPI_BUNDLED_PLUGIN_ROOTS = previous;
		await fs.rm(fixture, { recursive: true, force: true });
	}
});

test("keeps host-scope packages out of the session mount", async () => {
	const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "musepi-bundled-plugin-scope-"));
	const previous = process.env.MUSEPI_BUNDLED_PLUGIN_ROOTS;
	try {
		const pluginDir = path.join(fixture, "bundled-plugins", "host-plugin");
		await Bun.write(
			path.join(pluginDir, "package.json"),
			JSON.stringify({ name: "host-plugin", musepi: { extensions: ["./index.ts"], scope: "host" } }),
		);
		await Bun.write(path.join(pluginDir, "index.ts"), "export function apply() {}\n");
		process.env.MUSEPI_BUNDLED_PLUGIN_ROOTS = path.join(fixture, "bundled-plugins");

		const sessionScope = await discoverBundledPluginPaths();
		expect(sessionScope).toEqual([]);
		const hostScope = (await discoverBundledPluginPaths({ scope: "host" })).map(entry => entry.replaceAll("\\", "/"));
		expect(hostScope).toEqual([path.join(pluginDir, "index.ts").replaceAll("\\", "/")]);
		expect(await discoverBundledPluginPaths({ scope: "all" })).toHaveLength(1);
	} finally {
		if (previous === undefined) delete process.env.MUSEPI_BUNDLED_PLUGIN_ROOTS;
		else process.env.MUSEPI_BUNDLED_PLUGIN_ROOTS = previous;
		await fs.rm(fixture, { recursive: true, force: true });
	}
});
