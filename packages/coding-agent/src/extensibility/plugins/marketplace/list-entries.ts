/**
 * Wire-shape transform for `marketplace.list` RPC.
 *
 * Walks every marketplace in the user's registry, lists the catalog plugins,
 * then merges in `installed` / `installedScope` from the user + project
 * installed-plugins registries so the GUI can flip each card between
 * Install / Remove without a second round-trip. Project entries take
 * precedence over user entries (matches `MarketplaceManager.uninstallPlugin`
 * disambiguation).
 *
 * Kept as a free function so it can be unit-tested without spinning up a
 * daemon server. The daemon `marketplace.list` handler calls this and
 * caches the result for 10s.
 */

import { getInstalledPlugin } from "./registry";
import type { InstalledPluginsRegistry, MarketplacePluginEntry, MarketplacesRegistry } from "./types";
import { buildPluginId } from "./types";

export interface MarketplaceListEntry {
	name: string;
	marketplace: string;
	version?: string;
	description?: string;
	author?: string;
	category?: string;
	tags?: readonly string[];
	homepage?: string;
	repository?: string;
	license?: string;
	icon?: string;
	installed: boolean;
	installedScope: "user" | "project" | null;
}

export interface MarketplaceListInput {
	registry: MarketplacesRegistry;
	/** Per-marketplace catalog plugins. The outer key is the marketplace name. */
	catalogs: ReadonlyMap<string, readonly MarketplacePluginEntry[]>;
	userRegistry: InstalledPluginsRegistry;
	projectRegistry: InstalledPluginsRegistry | null;
}

export function listMarketplaceEntries(input: MarketplaceListInput): MarketplaceListEntry[] {
	const entries: MarketplaceListEntry[] = [];
	for (const mkt of input.registry.marketplaces) {
		const plugins = input.catalogs.get(mkt.name) ?? [];
		for (const p of plugins) {
			entries.push(buildEntry(p, mkt.name, input.userRegistry, input.projectRegistry));
		}
	}
	return entries;
}

function buildEntry(
	p: MarketplacePluginEntry,
	marketplaceName: string,
	userReg: InstalledPluginsRegistry,
	projectReg: InstalledPluginsRegistry | null,
): MarketplaceListEntry {
	const id = buildPluginId(p.name, marketplaceName);
	const inProject = projectReg !== null && (getInstalledPlugin(projectReg, id)?.length ?? 0) > 0;
	const inUser = (getInstalledPlugin(userReg, id)?.length ?? 0) > 0;
	const installedScope: "user" | "project" | null = inProject ? "project" : inUser ? "user" : null;
	return {
		name: p.name,
		marketplace: marketplaceName,
		version: p.version,
		description: p.description,
		author: typeof p.author === "string" ? p.author : p.author?.name,
		category: p.category,
		tags: p.tags,
		homepage: p.homepage,
		repository: p.repository,
		license: p.license,
		icon: p.icon,
		installed: installedScope !== null,
		installedScope,
	};
}
