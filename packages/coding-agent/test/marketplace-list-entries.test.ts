import { describe, expect, test } from "bun:test";
import { listMarketplaceEntries } from "../src/extensibility/plugins/marketplace/list-entries";
import type {
	InstalledPluginEntry,
	InstalledPluginsRegistry,
	MarketplacePluginEntry,
	MarketplacesRegistry,
} from "../src/extensibility/plugins/marketplace/types";
import { buildPluginId } from "../src/extensibility/plugins/marketplace/types";

function plugin(over: Partial<MarketplacePluginEntry>): MarketplacePluginEntry {
	return {
		name: "demo",
		source: "./plugins/demo",
		...over,
	} as MarketplacePluginEntry;
}

function registry(marketplaces: { name: string }[]): MarketplacesRegistry {
	return {
		version: 1,
		marketplaces: marketplaces.map(m => ({
			name: m.name,
			sourceType: "local",
			sourceUri: "/tmp/x",
			catalogPath: `/tmp/${m.name}/marketplace.json`,
			addedAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
		})),
	};
}

function installed(entries: Record<string, InstalledPluginEntry[]>): InstalledPluginsRegistry {
	return { version: 2, plugins: entries };
}

describe("marketplace list-entries", () => {
	test("returns one entry per marketplace plugin with default installed state", () => {
		const reg = registry([{ name: "alpha" }, { name: "beta" }]);
		const catalogs = new Map([
			["alpha", [plugin({ name: "lint" }), plugin({ name: "fmt" })]],
			["beta", [plugin({ name: "github" })]],
		]);
		const result = listMarketplaceEntries({
			registry: reg,
			catalogs,
			userRegistry: installed({}),
			projectRegistry: null,
		});
		expect(result.map(r => `${r.marketplace}/${r.name}`).sort()).toEqual(["alpha/fmt", "alpha/lint", "beta/github"]);
		expect(result.every(e => !e.installed && e.installedScope === null)).toBe(true);
	});

	test("marks entries installed in user registry", () => {
		const reg = registry([{ name: "alpha" }]);
		const id = buildPluginId("lint", "alpha");
		const catalogs = new Map([["alpha", [plugin({ name: "lint" })]]]);
		const result = listMarketplaceEntries({
			registry: reg,
			catalogs,
			userRegistry: installed({
				[id]: [
					{
						scope: "user",
						installPath: "/tmp/x",
						version: "0.0.0",
						installedAt: "2026-01-01T00:00:00Z",
						lastUpdated: "2026-01-01T00:00:00Z",
					},
				],
			}),
			projectRegistry: null,
		});
		expect(result[0].installed).toBe(true);
		expect(result[0].installedScope).toBe("user");
	});

	test("project scope wins over user scope", () => {
		const reg = registry([{ name: "alpha" }]);
		const id = buildPluginId("lint", "alpha");
		const catalogs = new Map([["alpha", [plugin({ name: "lint" })]]]);
		const baseEntry = {
			installPath: "/tmp/x",
			version: "0.0.0",
			installedAt: "2026-01-01T00:00:00Z",
			lastUpdated: "2026-01-01T00:00:00Z",
		};
		const result = listMarketplaceEntries({
			registry: reg,
			catalogs,
			userRegistry: installed({ [id]: [{ scope: "user", ...baseEntry }] }),
			projectRegistry: installed({ [id]: [{ scope: "project", ...baseEntry }] }),
		});
		expect(result[0].installedScope).toBe("project");
	});

	test("extracts author name from object form", () => {
		const reg = registry([{ name: "alpha" }]);
		const catalogs = new Map([
			[
				"alpha",
				[
					plugin({
						name: "lint",
						author: { name: "Alice" },
					}),
				],
			],
		]);
		const result = listMarketplaceEntries({
			registry: reg,
			catalogs,
			userRegistry: installed({}),
			projectRegistry: null,
		});
		expect(result[0].author).toBe("Alice");
	});

	test("keeps string author verbatim", () => {
		const reg = registry([{ name: "alpha" }]);
		const catalogs = new Map([["alpha", [plugin({ name: "lint", author: { name: "Alice" } })]]]);
		const result = listMarketplaceEntries({
			registry: reg,
			catalogs,
			userRegistry: installed({}),
			projectRegistry: null,
		});
		expect(result[0].author).toBe("Alice");
	});
});
