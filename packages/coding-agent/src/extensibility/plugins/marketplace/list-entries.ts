/**
 * Wire-shape transform for `marketplace.list` RPC.
 *
 * Walks every marketplace in the user's registry, lists the catalog plugins,
 * then merges in `installed` / `installedScope` / `installedVersion` /
 * `updateAvailable` from the user + project installed-plugins registries so
 * the GUI can flip each card between Install / Upgrade / Remove without a
 * second round-trip. Project entries take precedence over user entries
 * (matches `MarketplaceManager.uninstallPlugin` disambiguation).
 *
 * Kept as a free function so it can be unit-tested without spinning up a
 * daemon server. The daemon `marketplace.list` handler calls this and
 * caches the result for 10s.
 */

import { getInstalledPlugin } from "./registry";
import type { InstalledPluginsRegistry, MarketplacePluginEntry, MarketplacesRegistry } from "./types";
import { buildPluginId } from "./types";
import { isNewerVersion } from "./version";

export interface MarketplaceListEntry {
	name: string;
	marketplace: string;
	/** Catalog version (what installing now would deliver). */
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
	/** Version of the active (project-over-user) install, when installed. */
	installedVersion?: string;
	/** Catalog version is newer than the active install. */
	updateAvailable?: boolean;
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
	const projectEntry = projectReg !== null ? getInstalledPlugin(projectReg, id)?.[0] : undefined;
	const userEntry = getInstalledPlugin(userReg, id)?.[0];
	// Project scope wins: it is the entry the runtime actually loads, so the
	// version/update state must describe that install, not the shadowed one.
	const installedEntry = projectEntry ?? userEntry;
	const installedScope: "user" | "project" | null =
		projectEntry !== undefined ? "project" : userEntry !== undefined ? "user" : null;
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
		installedVersion: installedEntry?.version,
		updateAvailable:
			installedEntry !== undefined && p.version !== undefined && isNewerVersion(p.version, installedEntry.version),
	};
}
