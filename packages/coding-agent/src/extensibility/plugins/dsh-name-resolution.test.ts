import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { getConfigDirName } from "@musepi/pi-utils/dirs";
import { resolvePluginName, resolvePluginNames } from "./dsh-name-resolution";

/**
 * A DSH patch row names its plugin by npm package name because the Loader
 * imports that package. This host locates a plugin by the directory it was
 * installed into, so a bundle cannot be read until its names become paths.
 *
 * The failure this protects against is not "the name did not resolve" but "the
 * wrong plugin resolved": applying a row's config and enablement to a plugin that
 * merely shares a name prefix would misconfigure something nobody asked about.
 */
/**
 * Build a plugins root the loader will actually enumerate.
 *
 * The path is derived from `getConfigDirName` rather than spelled out, because
 * a test that hard-codes `.musepi` stops finding anything the moment the config
 * directory is renamed or redirected, and it fails as "not installed" — which
 * looks like a resolver bug rather than a fixture that moved.
 *
 * @returns the home directory to pass as the resolver's home.
 */
async function pluginsRoot(entries: { name: string; enabled?: boolean; manifest?: boolean }[]): Promise<string> {
	const home = await mkdtemp(path.join(tmpdir(), "dsh-resolve-"));
	const root = path.join(home, getConfigDirName(), "plugins");
	await mkdir(path.join(root, "node_modules"), { recursive: true });

	const dependencies: Record<string, string> = {};
	const plugins: Record<string, unknown> = {};
	for (const entry of entries) {
		const pkgDir = path.join(root, "node_modules", entry.name);
		await mkdir(pkgDir, { recursive: true });
		await writeFile(
			path.join(pkgDir, "package.json"),
			JSON.stringify({
				name: entry.name,
				version: "1.0.0",
				...(entry.manifest === false ? {} : { musepi: { extensions: ["index.ts"] } }),
			}),
		);
		dependencies[entry.name] = "1.0.0";
		plugins[entry.name] = { version: "1.0.0", enabledFeatures: null, enabled: entry.enabled ?? true };
	}

	await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies }));
	await writeFile(path.join(root, "musepi-plugins.lock.json"), JSON.stringify({ plugins }));
	return home;
}

describe("resolvePluginName", () => {
	it("resolves an installed, enabled plugin to its directory", async () => {
		const home = await pluginsRoot([{ name: "@deepseek-ai/dsh-agent" }]);
		try {
			expect(await resolvePluginName("@deepseek-ai/dsh-agent", home, home)).toEqual({
				status: "resolved",
				pluginPath: path.join(home, getConfigDirName(), "plugins", "node_modules", "@deepseek-ai/dsh-agent"),
				scope: "user",
			});
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("says a switched-off plugin is disabled rather than missing", async () => {
		// The distinction the compatibility layer reports against. "Not installed"
		// would send someone looking for a package they already have, and it is
		// not a decision the loader is free to make on their behalf.
		const home = await pluginsRoot([{ name: "@deepseek-ai/dsh-agent", enabled: false }]);
		try {
			expect(await resolvePluginName("@deepseek-ai/dsh-agent", home, home)).toEqual({ status: "disabled" });
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("says a package it has never heard of is not installed", async () => {
		const home = await pluginsRoot([{ name: "@deepseek-ai/dsh-agent" }]);
		try {
			expect(await resolvePluginName("@deepseek-ai/dsh-other", home, home)).toEqual({ status: "not-installed" });
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("does not resolve one name to another that merely starts with it", async () => {
		// A prefix match would apply a bundle row to the wrong plugin.
		const home = await pluginsRoot([{ name: "@deepseek-ai/dsh-agent-tools" }]);
		try {
			expect(await resolvePluginName("@deepseek-ai/dsh-agent", home, home)).toEqual({ status: "not-installed" });
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("ignores a directory that is not a plugin at all", async () => {
		// Present in node_modules but declaring no plugin block, so the loader
		// would never load it and the bundle must not act on it.
		const home = await pluginsRoot([{ name: "some-library", manifest: false }]);
		try {
			expect(await resolvePluginName("some-library", home, home)).toEqual({ status: "not-installed" });
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("resolvePluginNames", () => {
	it("resolves a bundle's names once each, in declared order", async () => {
		// A patch file names the same package across several layers. Resolving it
		// repeatedly would re-read both plugin roots for nothing, and the layer
		// order is what decides which row wins.
		const home = await pluginsRoot([{ name: "@deepseek-ai/dsh-agent" }, { name: "@deepseek-ai/dsh-hooks" }]);
		try {
			const resolved = await resolvePluginNames(
				["@deepseek-ai/dsh-agent", "@deepseek-ai/dsh-hooks", "@deepseek-ai/dsh-agent"],
				home,
				home,
			);
			expect(resolved.map(r => r.name)).toEqual(["@deepseek-ai/dsh-agent", "@deepseek-ai/dsh-hooks"]);
			expect(resolved.map(r => r.resolution.status)).toEqual(["resolved", "resolved"]);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("keeps a bundle readable when one of its names does not resolve", async () => {
		// A bundle declaring three rows with two of them installed is worth
		// reporting on. Failing the whole file would leave the working rows
		// unapplied and say nothing about why.
		const home = await pluginsRoot([{ name: "@deepseek-ai/dsh-agent" }]);
		try {
			const resolved = await resolvePluginNames(["@deepseek-ai/dsh-agent", "missing-pkg"], home, home);
			expect(resolved.map(r => r.resolution.status)).toEqual(["resolved", "not-installed"]);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});
