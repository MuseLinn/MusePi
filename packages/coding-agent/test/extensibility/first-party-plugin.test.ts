import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { loadLegacyPiModule } from "@musepi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";
import { parseMarketplaceCatalog } from "@musepi/pi-coding-agent/extensibility/plugins/marketplace/fetcher";
import { formatRepoState } from "../../../musepi-git/src/format.ts";

// The bundled catalog and its first-party plugin are two artifacts that can
// drift apart silently: a renamed directory, a moved source file, or a
// manifest pointing at a path nobody edits any more. Nothing at runtime
// complains — the store just shows a plugin that fails to install, or an
// extension that never loads. These cases pin the seams between them.

// repo `packages/` — three levels up from packages/coding-agent/test/extensibility.
const PACKAGES = path.resolve(import.meta.dir, "..", "..", "..");
const CATALOG_PATH = path.join(PACKAGES, "marketplace.json");

async function readCatalog() {
	const content = await fs.readFile(CATALOG_PATH, "utf8");
	// The real parser, not a hand-rolled shape check: a catalog this loader
	// would reject is exactly the failure worth catching in CI.
	return { catalog: parseMarketplaceCatalog(content, CATALOG_PATH), content };
}

describe("bundled marketplace catalog", () => {
	it("parses with the loader's own catalog parser", async () => {
		const { catalog } = await readCatalog();
		expect(catalog.name).toBe("musepi");
		expect(catalog.owner.name).toBe("MusePi");
	});

	it("has no dangling plugin source", async () => {
		const { catalog } = await readCatalog();
		expect(catalog.plugins.length).toBeGreaterThan(0);

		for (const plugin of catalog.plugins) {
			// Relative sources resolve against the catalog's own directory.
			expect(typeof plugin.source).toBe("string");
			const resolved = path.resolve(PACKAGES, String(plugin.source));
			const stat = await fs.stat(resolved).catch(() => null);
			expect({
				plugin: plugin.name,
				exists: stat?.isDirectory() ?? false,
			}).toEqual({
				plugin: plugin.name,
				exists: true,
			});
		}
	});
});

describe("musepi-git plugin package", () => {
	it("declares extension entries that exist", async () => {
		const pkgDir = path.join(PACKAGES, "musepi-git");
		const pkg = JSON.parse(await fs.readFile(path.join(pkgDir, "package.json"), "utf8")) as {
			musepi?: { extensions?: string[] };
		};
		const entries = pkg.musepi?.extensions;
		expect(Array.isArray(entries)).toBe(true);
		expect(entries?.length ?? 0).toBeGreaterThan(0);

		for (const entry of entries ?? []) {
			const stat = await fs.stat(path.join(pkgDir, entry)).catch(() => null);
			expect({ entry, exists: stat?.isFile() ?? false }).toEqual({
				entry,
				exists: true,
			});
		}
	});

	it("loads through the compat loader and registers /git", async () => {
		const entry = path.join(PACKAGES, "musepi-git", "src", "index.ts");
		const mod = (await loadLegacyPiModule(entry)) as {
			default?: (pi: unknown) => void;
		};

		expect(typeof mod.default).toBe("function");

		// Minimal stand-in for the extension API: the plugin's job is to call
		// registerCommand, and nothing else is load-bearing here.
		const commands = new Map<string, { description?: string }>();
		mod.default?.({
			registerCommand: (name: string, opts: { description?: string }) => {
				commands.set(name, opts);
			},
			sendMessage: async () => {},
		});

		expect([...commands.keys()]).toEqual(["git"]);
		expect(commands.get("git")?.description).toContain("branch");
	});
});

describe("musepi-git state rendering", () => {
	it("names the branch and only mentions non-zero counters", () => {
		expect(
			formatRepoState({
				inRepo: true,
				root: "/r",
				branch: "main",
				staged: 0,
				unstaged: 2,
				untracked: 0,
			}),
		).toBe("main ~2");
	});

	it("marks a detached HEAD rather than printing a stale branch", () => {
		expect(
			formatRepoState({
				inRepo: true,
				root: "/r",
				detached: true,
				commit: "abc1234",
			}),
		).toBe("detached@abc1234");
	});

	it("distinguishes 'no repository' from 'no commits yet'", () => {
		expect(formatRepoState({ inRepo: false })).toBe("no repo");
		expect(formatRepoState({ inRepo: true, root: "/r", note: "no commits yet" })).toBe("HEAD? (no commits yet)");
	});
});
