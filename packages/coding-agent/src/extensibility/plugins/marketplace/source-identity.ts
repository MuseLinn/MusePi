/**
 * Which repository (and directory inside it) a catalog plugin entry reads its
 * code from.
 *
 * Used twice:
 *   - install records the identity on the installed entry, and
 *   - upgrade compares the catalog's identity with the recorded one, so an
 *     update can only move within the same repo and the same directory.
 *
 * A catalog entry that names its own repository (`github` / `url` /
 * `git-subdir`) reads from there; a relative `./plugins/x` source reads from
 * the marketplace's own repository. `npm` sources are rejected elsewhere and
 * carry no repository, so they resolve to nothing.
 */

import * as os from "node:os";
import * as path from "node:path";

import type { MarketplaceCatalogMetadata, MarketplacePluginEntry, MarketplaceRegistryEntry } from "./types";

export interface PluginSourceIdentity {
	/** Repository URL or local path the plugin's files are read from. */
	repo?: string;
	/** Directory inside `repo`; empty when the repository root is the plugin. */
	path: string;
}

/** GitHub shorthand (`owner/repo`) → its clone URL; full URLs pass through. */
export function repositoryUrl(value: string): string {
	if (value.includes("://") || value.startsWith("git@")) return value;
	return `https://github.com/${value}.git`;
}

/** Comparison form of a repository: no trailing slash, no `.git` suffix. */
export function normalizeRepoKey(repo: string | undefined): string {
	if (repo === undefined) return "";
	return repo
		.trim()
		.replace(/\/+$/, "")
		.replace(/\.git$/i, "");
}

/** Comparison form of a directory inside a repository. */
export function normalizeSourcePath(value: string | undefined): string {
	if (value === undefined || value.length === 0) return "";
	const slashed = value.replace(/\\/g, "/");
	const trimmed = slashed.replace(/^\.\/+/, "").replace(/\/+$/, "");
	return trimmed === "." ? "" : trimmed;
}

/**
 * Identity for one catalog entry. `catalogMetadata.pluginRoot` is applied to
 * relative sources exactly the way `resolvePluginSource` does it, so the
 * recorded path matches the directory the plugin was copied from.
 */
export function pluginSourceIdentity(
	plugin: Pick<MarketplacePluginEntry, "source">,
	marketplace: Pick<MarketplaceRegistryEntry, "sourceType" | "sourceUri">,
	catalogMetadata?: MarketplaceCatalogMetadata,
): PluginSourceIdentity {
	const { source } = plugin;

	if (typeof source === "string") {
		const pluginRoot = catalogMetadata?.pluginRoot;
		const relative = normalizeSourcePath(pluginRoot ? path.posix.join(pluginRoot, source.slice(2)) : source.slice(2));
		return { repo: marketplaceRepository(marketplace), path: relative };
	}

	switch (source.source) {
		case "github":
			return { repo: `https://github.com/${source.repo}.git`, path: "" };
		case "url":
			return { repo: source.url, path: "" };
		case "git-subdir":
			return { repo: repositoryUrl(source.url), path: normalizeSourcePath(source.path) };
		case "npm":
			return { path: "" };
	}
}

function marketplaceRepository(marketplace: Pick<MarketplaceRegistryEntry, "sourceType" | "sourceUri">): string {
	if (marketplace.sourceType === "local") {
		return path.resolve(
			marketplace.sourceUri.startsWith("~/") ? expandHome(marketplace.sourceUri) : marketplace.sourceUri,
		);
	}
	if (marketplace.sourceType === "github") return repositoryUrl(marketplace.sourceUri);
	return marketplace.sourceUri;
}

function expandHome(value: string): string {
	if (!value.startsWith("~/")) return value;
	return path.join(os.homedir(), value.slice(2));
}

/**
 * True when two identities name the same code location: the same repository
 * and, unless one side reports no directory at all, the same directory inside
 * it. Callers only compare identities built from catalog metadata.
 */
export function samePluginSource(left: PluginSourceIdentity, right: PluginSourceIdentity): boolean {
	if (normalizeRepoKey(left.repo) !== normalizeRepoKey(right.repo)) return false;
	return normalizeSourcePath(left.path) === normalizeSourcePath(right.path);
}
