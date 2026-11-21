/**
 * MarketplaceManager — orchestrates registry, fetcher, resolver, and cache.
 *
 * Constructor takes explicit paths for testability (same pattern as registry.ts).
 * The `clearPluginRootsCache` dependency is injected so callers can provide
 * the real `clearClaudePluginRootsCache` while tests supply a counter stub.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { isEnoent, logger, pathIsWithin } from "@musepi/pi-utils";
import * as git from "../../../utils/git";
import { codexPluginIcon } from "../compat/codex-plugin-icon";
import { readCompatibilityExemptions, resolveCompatibilityPath } from "../compat/compatibility-store";
import { compatibilityGateForExtensionPath, pluginCompatibilityWarning } from "../compat/plugin-compatibility";
import { adaptThirdPartyCordisPlugin } from "../compat/third-party-cordis";
import { normalizePluginRuntimeConfig } from "../profile/runtime-config";
import type { PluginRuntimeConfig } from "../runtime/types";

import { cachePlugin } from "./cache";
import { defaultMarketplaceCatalog, withDefaultMarketplaces } from "./default-marketplaces";
import { readMarketplacePluginDetail } from "./detail";
import {
	classifySource,
	fetchMarketplace,
	parseMarketplaceCatalog,
	promoteCloneToCache,
	readMarketplaceCatalog,
} from "./fetcher";
import {
	addInstalledPlugin,
	addMarketplaceEntry,
	collectReferencedPaths,
	getInstalledPlugin,
	getMarketplaceEntry,
	readInstalledPluginsRegistry,
	readMarketplacesRegistry,
	removeInstalledPlugin,
	removeMarketplaceEntry,
	writeInstalledPluginsRegistry,
	writeMarketplacesRegistry,
} from "./registry";
import type { PluginSourceIdentity } from "./source-identity";
import { normalizeSourcePath, pluginSourceIdentity, samePluginSource } from "./source-identity";
import { resolvePluginSource } from "./source-resolver";
import type {
	InstalledPluginEntry,
	InstalledPluginSummary,
	InstalledPluginsRegistry,
	MarketplaceCatalog,
	MarketplaceCatalogMetadata,
	MarketplacePluginEntry,
	MarketplaceRegistryEntry,
	MarketplacesRegistry,
	PluginSource,
} from "./types";
import { buildPluginId, parsePluginId } from "./types";
import { isNewerVersion, listRemotePluginVersions, type PluginVersionRef, sortVersionRefs } from "./version";

const RUNTIME_PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const MAX_RUNTIME_PACKAGE_NAME_LENGTH = 214;

function assertRuntimePackageName(name: string): string {
	if (name.length > MAX_RUNTIME_PACKAGE_NAME_LENGTH || !RUNTIME_PACKAGE_NAME_RE.test(name)) {
		throw new Error(`Invalid marketplace plugin package name: ${JSON.stringify(name)}`);
	}
	return name;
}

/**
 * Pin a catalog entry's source to one Git ref. A catalog `sha` would win over
 * the tag inside `git.clone`, so it is dropped when the user chose a version.
 */
function withSourceRef(entry: MarketplacePluginEntry, ref: string): MarketplacePluginEntry {
	const source = entry.source as Exclude<PluginSource, string> & { sha?: string };
	const { sha: _sha, ...rest } = source;
	return { ...entry, source: { ...rest, ref } as PluginSource };
}

/** Human-readable source for guard messages: `repo` or `repo (dir)`. */
function describeSource(identity: PluginSourceIdentity): string {
	const repo = identity.repo ?? "its marketplace";
	const dir = normalizeSourcePath(identity.path);
	return dir.length > 0 ? `${repo} (${dir})` : repo;
}

// ── Options ──────────────────────────────────────────────────────────────────

export interface MarketplaceManagerOptions {
	marketplacesRegistryPath: string;
	installedRegistryPath: string;
	/**
	 * Path to the project-scoped installed_plugins.json.
	 * Required when installPlugin / uninstallPlugin is called with scope: "project".
	 * Resolved by resolveActiveProjectRegistryPath(cwd) in callers.
	 */
	projectInstalledRegistryPath?: string;
	marketplacesCacheDir: string;
	pluginsCacheDir: string;
	/** Injected for testing; production callers pass clearClaudePluginRootsCache.
	 *  Receives any additional file paths that should also be invalidated from the fs cache.
	 */
	clearPluginRootsCache?: (extraPaths?: readonly string[]) => void;
	/**
	 * 兼容性预检豁免清单路径（回退保护②）。缺省 configRoot/compatibility.json；
	 * 测试可指向隔离路径。坏文件按零豁免处理（fail-safe），不阻塞安装。
	 */
	compatibilityExemptionsPath?: string;
	/** Include the two reviewed built-in catalogs without installing their plugins. */
	includeDefaultMarketplaces?: boolean;
	/**
	 * 可选版本来源：插件仓库的 tag 列表。缺省读 `git ls-remote --tags`；
	 * 返回空数组 = 该仓库没有可选版本（回退 catalog 版本）。
	 */
	listVersions?: (repo: string) => Promise<PluginVersionRef[]>;
}

/** What the detail dialog shows for one plugin's version list. */
export interface PluginVersionChoices {
	/** Newest first. Always includes the catalog version and the installed version. */
	versions: PluginVersionRef[];
	/**
	 * The catalog now resolves to a different repository (or directory) than
	 * the installed copy — replacing it is a reinstall, not an update.
	 */
	sourceChanged: boolean;
}

export interface PluginInstallOptions {
	force?: boolean;
	scope?: "user" | "project";
	expectedVersion?: string;
	/** Install exactly this published version instead of the catalog's latest. */
	targetVersion?: string;
	/** Keep the previous install's cache directory on disk until the caller commits. */
	retainPrevious?: boolean;
}

export interface PluginUpgradeOptions {
	/** Move to this published version; omitted means the catalog's version. */
	targetVersion?: string;
	/** Version the user saw when confirming — refuses a catalog that moved. */
	expectedVersion?: string;
	/**
	 * Allow a catalog that now resolves to a different repository/directory.
	 * The caller sets this only after an explicit reinstall confirmation.
	 */
	allowReplace?: boolean;
}

// ── Manager ──────────────────────────────────────────────────────────────────

export class MarketplaceManager {
	#opts: MarketplaceManagerOptions;

	constructor(options: MarketplaceManagerOptions) {
		this.#opts = options;
	}

	// Invalidate fs caches for all registry paths the manager writes, then clear plugin roots.
	#clearCache(): void {
		const extra = this.#opts.projectInstalledRegistryPath
			? ([this.#opts.projectInstalledRegistryPath] as readonly string[])
			: undefined;
		this.#opts.clearPluginRootsCache?.(extra);
	}

	async #readMarketplacesRegistry(): Promise<MarketplacesRegistry> {
		return withDefaultMarketplaces(await readMarketplacesRegistry(this.#opts.marketplacesRegistryPath), this.#opts);
	}

	// ── Marketplace lifecycle ─────────────────────────────────────────────────

	async addMarketplace(source: string): Promise<MarketplaceRegistryEntry> {
		const reg = await this.#readMarketplacesRegistry();
		const existingNames = new Set(reg.marketplaces.map(m => m.name));
		const duplicateDefault = reg.marketplaces.find(entry => entry.sourceUri === source);
		if (this.#opts.includeDefaultMarketplaces && duplicateDefault) {
			throw new Error(`Marketplace "${duplicateDefault.name}" already exists`);
		}

		const { catalog, clonePath } = await fetchMarketplace(source, this.#opts.marketplacesCacheDir);

		if (existingNames.has(catalog.name)) {
			if (clonePath) {
				await fs.rm(clonePath, { recursive: true, force: true }).catch(() => {});
			}
			throw new Error(`Marketplace "${catalog.name}" already exists`);
		}

		// Promote the temp clone to its final cache location now that we know it's not a duplicate.
		if (clonePath) {
			await promoteCloneToCache(clonePath, this.#opts.marketplacesCacheDir, catalog.name);
		}

		const sourceType = classifySource(source);
		const normalizedSource =
			sourceType === "local"
				? path.resolve(source.startsWith("~/") ? path.join(os.homedir(), source.slice(2)) : source)
				: source;

		const catalogPath = path.join(this.#opts.marketplacesCacheDir, catalog.name, "marketplace.json");

		// Persist the fetched catalog so subsequent reads don't require re-fetching.
		await Bun.write(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

		const now = new Date().toISOString();
		const entry: MarketplaceRegistryEntry = {
			name: catalog.name,
			sourceType,
			sourceUri: normalizedSource,
			catalogPath,
			addedAt: now,
			updatedAt: now,
		};

		const updated = addMarketplaceEntry(reg, entry);
		await writeMarketplacesRegistry(this.#opts.marketplacesRegistryPath, updated);

		logger.debug("Marketplace added", { name: catalog.name, sourceType });
		return entry;
	}

	async removeMarketplace(name: string): Promise<void> {
		if (this.#opts.includeDefaultMarketplaces && defaultMarketplaceCatalog(name)) {
			throw new Error(`Marketplace "${name}" not found`);
		}
		const reg = await this.#readMarketplacesRegistry();
		// removeMarketplaceEntry throws if not found — propagate to caller.
		const updated = removeMarketplaceEntry(reg, name);
		await writeMarketplacesRegistry(this.#opts.marketplacesRegistryPath, updated);

		await fs.rm(path.join(this.#opts.marketplacesCacheDir, name), {
			recursive: true,
			force: true,
		});

		logger.debug("Marketplace removed", { name });
	}

	async updateMarketplace(name: string): Promise<MarketplaceRegistryEntry> {
		const reg = await this.#readMarketplacesRegistry();
		const existing = getMarketplaceEntry(reg, name);
		if (!existing) {
			throw new Error(`Marketplace "${name}" not found`);
		}

		const { catalog, clonePath } = await fetchMarketplace(existing.sourceUri, this.#opts.marketplacesCacheDir);

		// Guard against upstream catalog silently renaming itself — the registry
		// entry is keyed by name, so a drift would corrupt the entry on next read.
		if (catalog.name !== name) {
			if (clonePath) {
				await fs.rm(clonePath, { recursive: true, force: true }).catch(() => {});
			}
			throw new Error(
				`Marketplace catalog name changed from "${name}" to "${catalog.name}". ` +
					`Remove and re-add the marketplace to update.`,
			);
		}

		// Promote the temp clone to its final cache location now that drift check passed.
		if (clonePath) {
			await promoteCloneToCache(clonePath, this.#opts.marketplacesCacheDir, catalog.name);
		}

		// Overwrite cached catalog
		await Bun.write(existing.catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

		const updatedEntry: MarketplaceRegistryEntry = {
			...existing,
			updatedAt: new Date().toISOString(),
		};

		const updatedReg = {
			...reg,
			marketplaces: reg.marketplaces.map(m => (m.name === name ? updatedEntry : m)),
		};
		await writeMarketplacesRegistry(this.#opts.marketplacesRegistryPath, updatedReg);

		logger.debug("Marketplace updated", { name });
		return updatedEntry;
	}

	async updateAllMarketplaces(): Promise<MarketplaceRegistryEntry[]> {
		const marketplaces = await this.listMarketplaces();
		const results: MarketplaceRegistryEntry[] = [];
		for (const m of marketplaces) {
			const updated = await this.updateMarketplace(m.name);
			results.push(updated);
		}
		return results;
	}

	async listMarketplaces(): Promise<MarketplaceRegistryEntry[]> {
		const reg = await this.#readMarketplacesRegistry();
		return reg.marketplaces;
	}

	// ── Plugin discovery ──────────────────────────────────────────────────────

	async listAvailablePlugins(marketplace?: string): Promise<MarketplacePluginEntry[]> {
		const reg = await this.#readMarketplacesRegistry();

		if (marketplace !== undefined) {
			const entry = reg.marketplaces.find(m => m.name === marketplace);
			if (!entry) {
				throw new Error(`Marketplace "${marketplace}" not found`);
			}
			const catalog = await this.#readCatalog(entry);
			return catalog.plugins;
		}

		const all: MarketplacePluginEntry[] = [];
		for (const entry of reg.marketplaces) {
			const catalog = await this.#readCatalog(entry);
			all.push(...catalog.plugins);
		}
		return all;
	}

	async getPluginInfo(name: string, marketplace: string): Promise<MarketplacePluginEntry | null> {
		const plugins = await this.listAvailablePlugins(marketplace);
		return plugins.find(p => p.name === name) ?? null;
	}

	// ── Install / uninstall ───────────────────────────────────────────────────

	async installPlugin(
		name: string,
		marketplace: string,
		options?: PluginInstallOptions,
	): Promise<InstalledPluginEntry> {
		const force = options?.force ?? false;
		const scope = options?.scope ?? "user";
		const registryPath = this.#registryPath(scope);
		const targetVersion = options?.targetVersion;

		// A target version has to be a ref the repository really publishes:
		// resolve it before any clone, so an unavailable version fails before
		// the first disk write.
		const ref =
			targetVersion === undefined ? undefined : await this.#resolveTargetRef(name, marketplace, targetVersion);

		const { pluginEntry, sourcePath, tempCloneRoot, marketplaceEntry, catalogMetadata, catalogVersion } =
			await this.#preparePluginSource(name, marketplace, { ref });

		// Trust gate for GUI confirmations: the caller approved a specific
		// catalog version, so refuse to install a different one. Checked before
		// the cache or registry is written; a source clone lives in a temp dir
		// either way. Catalogs without a version cannot be pinned. A chosen
		// target version is compared against the catalog, not the tag: the user
		// picked that tag, and an older catalog still named it.
		if (
			options?.expectedVersion !== undefined &&
			catalogVersion !== undefined &&
			catalogVersion !== options.expectedVersion
		) {
			throw new Error(
				`Plugin "${name}@${marketplace}" changed since it was reviewed: ` +
					`expected version ${options.expectedVersion}, catalog now has ${catalogVersion}`,
			);
		}

		const pluginId = buildPluginId(name, marketplace);

		// 3. Check if already installed
		const instReg = await readInstalledPluginsRegistry(registryPath);
		const existing = getInstalledPlugin(instReg, pluginId);
		if (existing && existing.length > 0 && !force) {
			throw new Error(`Plugin "${pluginId}" is already installed. Use force option to reinstall.`);
		}

		// 回退保护②：兼容性预检在缓存/登记**之前**——源已解析、插件代码
		// 尚未 import。拒绝 = 结构化错误（不带任何盘副作用;tempCloneRoot 由
		// 下方 finally 清理）;豁免命中放行但打警告。与宿主/会话装配共用同一
		// 判定函数。malformed peer 元数据按 dsh 口径拒绝（gate 不空且非豁免）。
		{
			const exemptionsPath = this.#opts.compatibilityExemptionsPath ?? resolveCompatibilityPath();
			const { exemptions, warnings } = readCompatibilityExemptions(exemptionsPath);
			for (const warning of warnings) logger.warn(warning);
			const gate = await compatibilityGateForExtensionPath(sourcePath, exemptions);
			if (gate && gate.status !== "exempted") {
				const message = pluginCompatibilityWarning(gate);
				if (tempCloneRoot) {
					await fs.rm(tempCloneRoot, { recursive: true, force: true }).catch(() => {});
				}
				throw new Error(message);
			}
			if (gate) logger.warn("compatibility exemption active, installing anyway", { plugin: name });
		}

		// 5. Determine version: an explicitly chosen version wins, then catalog
		//    entry > plugin manifest > git SHA > fallback
		let version!: string;
		let cachePath!: string;
		try {
			version = targetVersion ?? (await this.#resolvePluginVersion(pluginEntry, sourcePath));
			cachePath = await cachePlugin(sourcePath, this.#opts.pluginsCacheDir, marketplace, name, version);
			await adaptThirdPartyCordisPlugin(cachePath);
			await this.#writeEmbeddedLspConfig(pluginEntry, cachePath);
			await this.#writeEmbeddedDapConfig(pluginEntry, cachePath);
		} finally {
			// Clean up temp clone dirs created by resolvePluginSource; leave user-supplied local dirs alone
			if (tempCloneRoot) {
				await fs.rm(tempCloneRoot, { recursive: true, force: true }).catch(() => {});
			}
		}

		const packageName = await this.#resolvePluginPackageName(cachePath, name);
		const previousPackageNames = await this.#resolveInstalledPackageNames(existing ?? [], name);

		// Only now clean up old entries — new cache succeeded, so it is safe to remove old ones.
		// An upgrade keeps them until it commits (`retainPrevious`), so a failure in
		// the steps below still has the previous copy to restore.
		if (existing && existing.length > 0) {
			// Remove from scope-appropriate registry first, then cross-check refs before disk deletion.
			const prunedReg = removeInstalledPlugin(await readInstalledPluginsRegistry(registryPath), pluginId);
			await writeInstalledPluginsRegistry(registryPath, prunedReg);

			if (!options?.retainPrevious) await this.#deleteUnreferencedInstalls(existing, cachePath);
		}

		// 6. Build and register the entry, preserving enabled state from previous install
		const now = new Date().toISOString();
		// Carry over enabled flag from existing entry — a disabled plugin must stay disabled after upgrade
		const wasDisabled = existing?.some(e => e.enabled === false);
		const sourceIdentity = pluginSourceIdentity(pluginEntry, marketplaceEntry, catalogMetadata);
		const installedEntry: InstalledPluginEntry = {
			scope,
			installPath: cachePath,
			version,
			installedAt: now,
			lastUpdated: now,
			...(sourceIdentity.repo ? { sourceRepo: sourceIdentity.repo } : {}),
			...(sourceIdentity.path ? { sourcePath: sourceIdentity.path } : {}),
			...(wasDisabled ? { enabled: false } : {}),
		};

		const freshInstReg = await readInstalledPluginsRegistry(registryPath);
		const newInstReg = addInstalledPlugin(freshInstReg, pluginId, installedEntry);
		await writeInstalledPluginsRegistry(registryPath, newInstReg);

		await this.#registerRuntimePlugin(scope, packageName, cachePath, version, wasDisabled ? false : undefined);
		// Retire the old package name only once the new link exists: a failure
		// before this point leaves the previous runtime config (feature toggles
		// included) untouched for the caller's rollback.
		for (const previousPackageName of previousPackageNames) {
			if (previousPackageName !== packageName) {
				await this.#removeRuntimePlugin(scope, previousPackageName);
			}
		}

		this.#clearCache();

		logger.debug("Plugin installed", { pluginId, version, cachePath });
		return installedEntry;
	}

	async #writeEmbeddedLspConfig(entry: MarketplacePluginEntry, cachePath: string): Promise<void> {
		const lspServers = entry.lspServers;
		if (!lspServers) return;

		const targetPath = path.join(cachePath, ".lsp.json");
		if (typeof lspServers === "string") {
			const sourcePath = path.resolve(cachePath, lspServers);
			if (!pathIsWithin(cachePath, sourcePath)) {
				throw new Error(`Plugin "${entry.name}" lspServers path escapes the plugin directory`);
			}
			const content = await Bun.file(sourcePath).text();
			await Bun.write(targetPath, content);
			return;
		}

		await Bun.write(targetPath, `${JSON.stringify({ servers: lspServers }, null, 2)}\n`);
	}

	async #writeEmbeddedDapConfig(entry: MarketplacePluginEntry, cachePath: string): Promise<void> {
		const dapAdapters = entry.dapAdapters;
		if (!dapAdapters) return;

		if (typeof dapAdapters === "string") {
			const sourcePath = path.resolve(cachePath, dapAdapters);
			if (!pathIsWithin(cachePath, sourcePath)) {
				throw new Error(`Plugin "${entry.name}" dapAdapters path escapes the plugin directory`);
			}
			const extension = path.extname(sourcePath).toLowerCase();
			const targetFilename = extension === ".yaml" || extension === ".yml" ? `.dap${extension}` : ".dap.json";
			const targetPath = path.join(cachePath, targetFilename);
			const content = await Bun.file(sourcePath).text();
			await Bun.write(targetPath, content);
			return;
		}

		const targetPath = path.join(cachePath, ".dap.json");
		await Bun.write(targetPath, `${JSON.stringify({ adapters: dapAdapters }, null, 2)}\n`);
	}

	async getPluginDetail(name: string, marketplace: string) {
		const { pluginEntry, sourcePath, tempCloneRoot } = await this.#preparePluginSource(name, marketplace);
		try {
			return await readMarketplacePluginDetail(sourcePath, pluginEntry);
		} finally {
			if (tempCloneRoot) await fs.rm(tempCloneRoot, { recursive: true, force: true }).catch(() => {});
		}
	}

	/**
	 * Icons for catalog entries that declare none: the plugin's own
	 * `.codex-plugin/plugin.json` logo — the same file the detail dialog shows.
	 * Only catalog-relative sources that already live inside the marketplace
	 * clone are resolved; a remote plugin source is never cloned just to paint
	 * a list card. Keyed by `name@marketplace`.
	 */
	async listCatalogIcons(): Promise<Map<string, string>> {
		const icons = new Map<string, string>();
		const reg = await this.#readMarketplacesRegistry();
		for (const entry of reg.marketplaces) {
			let catalog: MarketplaceCatalog;
			try {
				catalog = await this.#readCatalog(entry);
			} catch {
				continue;
			}
			const root = this.#resolveMarketplaceRoot(entry);
			for (const plugin of catalog.plugins) {
				if (plugin.icon || typeof plugin.source !== "string") continue;
				const dir = path.resolve(root, plugin.source);
				if (!pathIsWithin(root, dir)) continue;
				const icon = await codexPluginIcon(dir);
				if (icon) icons.set(buildPluginId(plugin.name, entry.name), icon);
			}
		}
		return icons;
	}

	/** Marketplace registry entry for `marketplace`, re-fetching a default catalog whose cache is gone. */
	async #resolveMarketplaceEntry(marketplace: string): Promise<MarketplaceRegistryEntry> {
		const mktReg = await this.#readMarketplacesRegistry();
		let mktEntry = getMarketplaceEntry(mktReg, marketplace);
		if (!mktEntry) throw new Error(`Marketplace "${marketplace}" not found`);
		if (
			this.#opts.includeDefaultMarketplaces &&
			defaultMarketplaceCatalog(marketplace) &&
			mktEntry.sourceType !== "local"
		) {
			let rootExists = false;
			try {
				rootExists = (await fs.stat(this.#resolveMarketplaceRoot(mktEntry))).isDirectory();
			} catch (err) {
				if (!isEnoent(err)) throw err;
			}
			if (!rootExists) {
				await this.updateMarketplace(marketplace);
				const refreshed = getMarketplaceEntry(await this.#readMarketplacesRegistry(), marketplace);
				if (!refreshed) throw new Error(`Marketplace "${marketplace}" not found after refresh`);
				mktEntry = refreshed;
			}
		}
		return mktEntry;
	}

	/**
	 * Resolve a plugin to a source directory.
	 *
	 * With `ref`, the source is read at that Git tag instead of the catalog's
	 * current state: an object source just takes the ref, a relative source
	 * clones the marketplace repository at the tag and resolves the same
	 * relative path in that checkout (its catalog names the plugin there).
	 */
	async #preparePluginSource(name: string, marketplace: string, options?: { ref?: string }) {
		const mktEntry = await this.#resolveMarketplaceEntry(marketplace);
		const catalog = await this.#readCatalog(mktEntry);
		const catalogEntry = catalog.plugins.find(p => p.name === name);
		if (!catalogEntry) throw new Error(`Plugin "${name}" not found in marketplace "${marketplace}"`);
		// The catalog's own version, captured before a pin can replace it: the
		// trust gate below compares against what the catalog names, not against
		// the older tag the caller deliberately chose.
		const catalogVersion = catalogEntry.version;
		let pluginEntry = catalogEntry;

		let marketplaceClonePath = this.#resolveMarketplaceRoot(mktEntry);
		let catalogMetadata: MarketplaceCatalogMetadata | undefined = catalog.metadata;
		let pinnedCloneRoot: string | undefined;

		if (options?.ref) {
			if (typeof pluginEntry.source === "string") {
				const repo = pluginSourceIdentity(pluginEntry, mktEntry, catalogMetadata).repo;
				if (!repo) {
					throw new Error(
						`Plugin "${name}@${marketplace}" has no Git-backed repository; version selection is unavailable.`,
					);
				}
				pinnedCloneRoot = path.join(os.tmpdir(), `marketplace-${crypto.randomUUID()}`);
				try {
					await git.clone(repo, pinnedCloneRoot, { ref: options.ref });
					const { catalogPath, content } = await readMarketplaceCatalog(pinnedCloneRoot, {
						relativeDisplayPaths: true,
					});
					const pinnedCatalog = parseMarketplaceCatalog(content, catalogPath);
					const pinnedEntry = pinnedCatalog.plugins.find(p => p.name === name);
					if (!pinnedEntry) {
						throw new Error(`Plugin "${name}" is not part of marketplace "${marketplace}" at ${options.ref}.`);
					}
					pluginEntry = pinnedEntry;
					marketplaceClonePath = pinnedCloneRoot;
					catalogMetadata = pinnedCatalog.metadata;
				} catch (err) {
					await fs.rm(pinnedCloneRoot, { recursive: true, force: true }).catch(() => {});
					throw err;
				}
			} else {
				pluginEntry = withSourceRef(pluginEntry, options.ref);
			}
		}

		if (mktEntry.sourceType === "url" && typeof pluginEntry.source === "string") {
			if (pinnedCloneRoot) await fs.rm(pinnedCloneRoot, { recursive: true, force: true }).catch(() => {});
			throw new Error(
				`Plugin "${name}" uses a relative source path but marketplace "${marketplace}" was added via URL. ` +
					`Relative sources require a git or local marketplace. Re-add the marketplace using its git URL.`,
			);
		}

		let resolved: { dir: string; tempCloneRoot?: string };
		try {
			resolved = await resolvePluginSource(pluginEntry, {
				marketplaceClonePath,
				catalogMetadata,
				tmpDir: os.tmpdir(),
			});
		} catch (err) {
			if (pinnedCloneRoot) await fs.rm(pinnedCloneRoot, { recursive: true, force: true }).catch(() => {});
			throw err;
		}
		return {
			pluginEntry,
			sourcePath: resolved.dir,
			tempCloneRoot: resolved.tempCloneRoot ?? pinnedCloneRoot,
			marketplaceEntry: mktEntry,
			catalogMetadata,
			catalogVersion,
		};
	}

	/**
	 * Selectable versions for one plugin: the repository's tags, plus the
	 * catalog version and the installed version so the list always explains
	 * both ends even when the repository publishes no tags.
	 */
	async pluginVersionChoices(name: string, marketplace: string): Promise<PluginVersionChoices> {
		const marketplaceEntry = await this.#resolveMarketplaceEntry(marketplace);
		const catalog = await this.#readCatalog(marketplaceEntry);
		const pluginEntry = catalog.plugins.find(p => p.name === name);
		if (!pluginEntry) throw new Error(`Plugin "${name}" not found in marketplace "${marketplace}"`);

		const identity = pluginSourceIdentity(pluginEntry, marketplaceEntry, catalog.metadata);
		let listed: PluginVersionRef[] = [];
		if (identity.repo) {
			try {
				listed = await (this.#opts.listVersions ?? listRemotePluginVersions)(identity.repo);
			} catch (err) {
				logger.warn("Failed to list plugin versions", { plugin: name, marketplace, error: String(err) });
			}
		}

		const byVersion = new Map(listed.map(version => [version.version, version]));
		const ensure = (version: string | undefined): void => {
			if (version !== undefined && version.length > 0 && !byVersion.has(version)) {
				// No tag publishes it; the catalog (or the installed copy) is the
				// only source, so there is no ref an install could check out.
				byVersion.set(version, { version, ref: "" });
			}
		};
		ensure(pluginEntry.version);
		const installed = await this.#findInBothRegistries(buildPluginId(name, marketplace));
		ensure(installed.projectEntries?.[0]?.version ?? installed.userEntries?.[0]?.version);

		const active = installed.projectEntries?.[0] ?? installed.userEntries?.[0];
		const sourceChanged =
			active?.sourceRepo !== undefined &&
			!samePluginSource(identity, { repo: active.sourceRepo, path: active.sourcePath ?? "" });

		return { versions: sortVersionRefs([...byVersion.values()]), sourceChanged };
	}

	/** Git ref that delivers `targetVersion`, or undefined when the catalog already is that version. */
	async #resolveTargetRef(name: string, marketplace: string, targetVersion: string): Promise<string | undefined> {
		const marketplaceEntry = await this.#resolveMarketplaceEntry(marketplace);
		const catalog = await this.#readCatalog(marketplaceEntry);
		const pluginEntry = catalog.plugins.find(p => p.name === name);
		if (!pluginEntry) throw new Error(`Plugin "${name}" not found in marketplace "${marketplace}"`);
		if (pluginEntry.version === targetVersion) return undefined;

		const { versions } = await this.pluginVersionChoices(name, marketplace);
		const match = versions.find(candidate => candidate.version === targetVersion);
		if (!match || match.ref.length === 0) {
			throw new Error(`Version ${targetVersion} is not published for plugin "${name}@${marketplace}".`);
		}
		return match.ref;
	}

	/**
	 * Delete cache directories of `entries` that neither registry references
	 * any more. `keepPath` is the directory the caller is about to register,
	 * so a same-version reinstall never deletes the copy it just wrote.
	 */
	async #deleteUnreferencedInstalls(entries: readonly InstalledPluginEntry[], keepPath?: string): Promise<void> {
		if (entries.length === 0) return;
		const [userReg, projectReg] = await Promise.all([
			readInstalledPluginsRegistry(this.#opts.installedRegistryPath),
			this.#opts.projectInstalledRegistryPath
				? readInstalledPluginsRegistry(this.#opts.projectInstalledRegistryPath)
				: Promise.resolve({ version: 2 as const, plugins: {} as Record<string, InstalledPluginEntry[]> }),
		]);
		const referenced = collectReferencedPaths(userReg, projectReg);
		for (const entry of entries) {
			if (entry.installPath === keepPath) continue;
			if (referenced.has(entry.installPath)) continue;
			await fs.rm(entry.installPath, { recursive: true, force: true }).catch(() => {});
		}
	}

	/**
	 * Resolve plugin version from multiple sources:
	 * 1. Catalog entry version (if set)
	 * 2. Plugin manifest (.claude-plugin/plugin.json, Agent Plugins root plugin.json, or package.json)
	 * 3. Git SHA from source (truncated to 7 chars)
	 * 4. Fallback "0.0.0"
	 */
	async #resolvePluginVersion(entry: MarketplacePluginEntry, sourcePath: string): Promise<string> {
		// 1. Catalog entry version
		if (entry.version) return entry.version;

		// 2. Plugin manifest
		for (const manifestPath of [
			path.join(sourcePath, ".claude-plugin", "plugin.json"),
			path.join(sourcePath, "plugin.json"),
			path.join(sourcePath, "package.json"),
		]) {
			try {
				const content = await Bun.file(manifestPath).json();
				if (typeof content?.version === "string" && content.version) {
					return content.version;
				}
			} catch {
				// Missing or invalid — try next
			}
		}

		// 3. Git SHA from source definition
		if (typeof entry.source === "object" && "sha" in entry.source && entry.source.sha) {
			return entry.source.sha.slice(0, 7);
		}

		return "0.0.0";
	}

	/** Validates and removes a marketplace plugin, or only validates when `dryRun` is set. */
	async uninstallPlugin(pluginId: string, scope?: "user" | "project", options?: { dryRun?: boolean }): Promise<void> {
		const parsed = parsePluginId(pluginId);
		if (!parsed) {
			throw new Error(`Invalid plugin ID format: "${pluginId}". Expected "name@marketplace".`);
		}

		const { userEntries, projectEntries, userReg, projectReg } = await this.#findInBothRegistries(pluginId);
		const inUser = userEntries && userEntries.length > 0;
		const inProject = projectEntries && projectEntries.length > 0;

		if (!inUser && !inProject) {
			throw new Error(`Plugin "${pluginId}" is not installed`);
		}

		// Disambiguation: if installed in both scopes and no explicit scope, require one.
		let targetScope: "user" | "project";
		if (inUser && inProject) {
			if (!scope) {
				throw new Error(
					`Plugin "${pluginId}" is installed in both user and project scope. Use --scope user or --scope project to specify which to remove.`,
				);
			}
			targetScope = scope;
		} else if (inProject) {
			if (scope === "user") {
				throw new Error(`Plugin "${pluginId}" is not installed in user scope`);
			}
			targetScope = "project";
		} else {
			if (scope === "project") {
				throw new Error(`Plugin "${pluginId}" is not installed in project scope`);
			}
			targetScope = "user";
		}

		const targetEntries = targetScope === "project" ? projectEntries! : userEntries!;
		const targetReg = targetScope === "project" ? projectReg : userReg;
		const registryPath = this.#registryPath(targetScope);
		const packageNames = await this.#resolveInstalledPackageNames(targetEntries, parsed.name);

		if (options?.dryRun) {
			return;
		}

		const updatedReg = removeInstalledPlugin(targetReg, pluginId);
		await writeInstalledPluginsRegistry(registryPath, updatedReg);

		// Read both registries AFTER removal — only delete paths no longer referenced by either.
		const [freshUserReg, freshProjectReg] = await Promise.all([
			readInstalledPluginsRegistry(this.#opts.installedRegistryPath),
			this.#opts.projectInstalledRegistryPath
				? readInstalledPluginsRegistry(this.#opts.projectInstalledRegistryPath)
				: Promise.resolve({ version: 2 as const, plugins: {} as Record<string, InstalledPluginEntry[]> }),
		]);
		const referenced = collectReferencedPaths(freshUserReg, freshProjectReg);

		for (const entry of targetEntries) {
			if (!referenced.has(entry.installPath)) {
				await fs.rm(entry.installPath, { recursive: true, force: true });
			}
		}

		for (const packageName of packageNames) {
			await this.#removeRuntimePlugin(targetScope, packageName);
		}

		this.#clearCache();

		logger.debug("Plugin uninstalled", { pluginId, scope: targetScope });
	}

	// ── Plugin state ──────────────────────────────────────────────────────────

	async listInstalledPlugins(): Promise<InstalledPluginSummary[]> {
		const userReg = await readInstalledPluginsRegistry(this.#opts.installedRegistryPath);
		const projectReg = this.#opts.projectInstalledRegistryPath
			? await readInstalledPluginsRegistry(this.#opts.projectInstalledRegistryPath)
			: null;

		// Only enabled project installs shadow user installs — a disabled project copy leaves
		// the user entry as the active one and must not be reported as shadowed.
		const activeProjectIds = new Set(
			projectReg
				? Object.entries(projectReg.plugins)
						.filter(([, entries]) => entries.length > 0 && entries[0].enabled !== false)
						.map(([id]) => id)
				: [],
		);
		const results: InstalledPluginSummary[] = [];

		// Project entries first
		if (projectReg) {
			for (const [id, entries] of Object.entries(projectReg.plugins)) {
				results.push({ id, scope: "project", entries });
			}
		}
		// User entries (shadow-marked if overridden by project)
		for (const [id, entries] of Object.entries(userReg.plugins)) {
			results.push({
				id,
				scope: "user",
				entries,
				...(activeProjectIds.has(id) ? { shadowedBy: "project" as const } : {}),
			});
		}
		return results;
	}

	async setPluginEnabled(pluginId: string, enabled: boolean, scope?: "user" | "project"): Promise<void> {
		const { userEntries, projectEntries, userReg, projectReg } = await this.#findInBothRegistries(pluginId);

		const inUser = userEntries && userEntries.length > 0;
		const inProject = projectEntries && projectEntries.length > 0;

		if (!inUser && !inProject) {
			throw new Error(`Plugin "${pluginId}" is not installed`);
		}

		// Disambiguation: if installed in both scopes and no explicit scope, require one.
		let targetScope: "user" | "project";
		if (inUser && inProject) {
			if (!scope) {
				throw new Error(
					`Plugin "${pluginId}" is installed in both user and project scope. Use --scope user or --scope project to specify which to modify.`,
				);
			}
			targetScope = scope;
		} else if (inProject) {
			if (scope === "user") {
				throw new Error(`Plugin "${pluginId}" is not installed in user scope`);
			}
			targetScope = "project";
		} else {
			if (scope === "project") {
				throw new Error(`Plugin "${pluginId}" is not installed in project scope`);
			}
			targetScope = "user";
		}

		const reg = targetScope === "project" ? projectReg : userReg;
		const entries = targetScope === "project" ? projectEntries! : userEntries!;
		const registryPath = this.#registryPath(targetScope);

		const updated = {
			...reg,
			plugins: {
				...reg.plugins,
				[pluginId]: entries.map(e => ({ ...e, enabled })),
			},
		};
		await writeInstalledPluginsRegistry(registryPath, updated);

		const fallbackName = parsePluginId(pluginId)?.name ?? pluginId;
		const packageNames = await this.#resolveInstalledPackageNames(entries, fallbackName);
		for (const packageName of packageNames) {
			await this.#setRuntimePluginEnabled(targetScope, packageName, enabled);
		}

		this.#clearCache();

		logger.debug("Plugin enabled state changed", { pluginId, enabled, scope: targetScope });
	}

	// ── Update / upgrade ─────────────────────────────────────────────────────

	// Refresh marketplace catalogs that haven't been updated in more than 24 h.
	// Per-marketplace failures are silently swallowed — offline is fine.
	async refreshStaleMarketplaces(): Promise<void> {
		const reg = await this.#readMarketplacesRegistry();
		const staleMs = 24 * 60 * 60 * 1000;
		for (const entry of reg.marketplaces) {
			if (Date.now() - Date.parse(entry.updatedAt) >= staleMs) {
				try {
					await this.updateMarketplace(entry.name);
				} catch {
					// Network or parse failure — leave stale, try next time.
				}
			}
		}
	}

	// Compare installed plugin versions against their catalog entries.
	// Returns one entry per (pluginId, scope) pair where the catalog declares a newer version.
	// Catalog entries without a version field are skipped.
	async checkForUpdates(): Promise<Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }>> {
		const mktReg = await this.#readMarketplacesRegistry();
		const updates: Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }> = [];

		// Keyed by (path, scope) so each scope is checked independently.
		// A plugin current in user scope but stale in project scope must still appear.
		const registryEntries: Array<[string, "user" | "project"]> = [[this.#opts.installedRegistryPath, "user"]];
		if (this.#opts.projectInstalledRegistryPath) {
			registryEntries.push([this.#opts.projectInstalledRegistryPath, "project"]);
		}

		for (const [regPath, scope] of registryEntries) {
			const instReg = await readInstalledPluginsRegistry(regPath);
			for (const [pluginId, entries] of Object.entries(instReg.plugins)) {
				const parsed = parsePluginId(pluginId);
				if (!parsed) continue;
				const installed = entries[0];
				if (!installed) continue;

				const mktEntry = mktReg.marketplaces.find(m => m.name === parsed.marketplace);
				if (!mktEntry) continue;

				let catalogVersion: string | undefined;
				try {
					const catalog = await this.#readCatalog(mktEntry);
					catalogVersion = catalog.plugins.find(p => p.name === parsed.name)?.version;
				} catch {
					continue;
				}

				if (!catalogVersion || catalogVersion === installed.version) continue;

				// Treat newer semver as an update; fall back to inequality for non-semver tags.
				if (isNewerVersion(catalogVersion, installed.version)) {
					updates.push({ pluginId, scope, from: installed.version, to: catalogVersion });
				}
			}
		}

		return updates;
	}

	/**
	 * Move an installed plugin to a newer version.
	 *
	 * - `targetVersion` picks a published version; omitted means the catalog's
	 *   current version (the pre-existing "latest" behaviour).
	 * - A target older than the installed version is refused: the only way to
	 *   go back is removing the plugin and installing explicitly.
	 * - A catalog that now resolves to another repository or directory is a
	 *   replacement, not an update; it is refused unless `allowReplace` was
	 *   confirmed as a reinstall.
	 * - The previous cache directory survives the install, so any failure
	 *   restores the previous registry entry and runtime link instead of
	 *   leaving the plugin half-installed.
	 */
	async upgradePlugin(
		pluginId: string,
		scope?: "user" | "project",
		options: PluginUpgradeOptions = {},
	): Promise<InstalledPluginEntry> {
		const parsed = parsePluginId(pluginId);
		if (!parsed) {
			throw new Error(`Invalid plugin ID: "${pluginId}". Expected "name@marketplace".`);
		}

		const { userEntries, projectEntries } = await this.#findInBothRegistries(pluginId);

		const inUser = userEntries && userEntries.length > 0;
		const inProject = projectEntries && projectEntries.length > 0;

		if (!inUser && !inProject) {
			throw new Error(`Plugin "${pluginId}" is not installed`);
		}

		let resolvedScope: "user" | "project";
		if (inUser && inProject) {
			if (!scope) {
				throw new Error(
					`Plugin "${pluginId}" is installed in both user and project scope. Use --scope user or --scope project to specify which to upgrade.`,
				);
			}
			resolvedScope = scope;
		} else if (inProject) {
			if (scope === "user") throw new Error(`Plugin "${pluginId}" is not installed in user scope`);
			resolvedScope = "project";
		} else {
			if (scope === "project") throw new Error(`Plugin "${pluginId}" is not installed in project scope`);
			resolvedScope = "user";
		}

		const previousEntries = (resolvedScope === "project" ? projectEntries : userEntries)!;
		const previous = previousEntries[0]!;

		const marketplaceEntry = await this.#resolveMarketplaceEntry(parsed.marketplace);
		const catalog = await this.#readCatalog(marketplaceEntry);
		const catalogEntry = catalog.plugins.find(p => p.name === parsed.name);
		if (!catalogEntry) {
			throw new Error(`Plugin "${pluginId}" is no longer in marketplace "${parsed.marketplace}".`);
		}

		const targetVersion = options.targetVersion ?? catalogEntry.version;
		if (
			targetVersion !== undefined &&
			targetVersion !== previous.version &&
			!isNewerVersion(targetVersion, previous.version)
		) {
			throw new Error(
				`Plugin "${pluginId}" is installed at ${previous.version}; refusing to downgrade to ${targetVersion}. ` +
					`Remove the plugin and install the older version explicitly.`,
			);
		}

		// Same repository, same directory: an update moves the copy, it never
		// swaps it for another project's code.
		if (previous.sourceRepo !== undefined) {
			const targetIdentity = pluginSourceIdentity(catalogEntry, marketplaceEntry, catalog.metadata);
			const installedIdentity = { repo: previous.sourceRepo, path: previous.sourcePath ?? "" };
			if (!samePluginSource(targetIdentity, installedIdentity) && !options.allowReplace) {
				throw new Error(
					`Plugin "${pluginId}" now resolves to ${describeSource(targetIdentity)} ` +
						`instead of ${describeSource(installedIdentity)}. Replacing a plugin with a different ` +
						`Git source requires an explicit reinstall.`,
				);
			}
		}

		let installed: InstalledPluginEntry;
		try {
			installed = await this.installPlugin(parsed.name, parsed.marketplace, {
				force: true,
				scope: resolvedScope,
				targetVersion: options.targetVersion,
				expectedVersion: options.expectedVersion,
				retainPrevious: true,
			});
		} catch (error) {
			await this.#restorePreviousInstall(resolvedScope, pluginId, previousEntries);
			await this.#prunePluginCache(parsed.marketplace, parsed.name);
			throw error;
		}
		// The upgrade is committed; cleaning up the previous copy is best-effort
		// and must not undo a successful install.
		await this.#deleteUnreferencedInstalls(previousEntries);
		return installed;
	}

	/**
	 * Put the previous registry entry and runtime link back after a failed
	 * upgrade. Best-effort: the registry write is what matters, and a failure
	 * here must not mask the original error.
	 */
	async #restorePreviousInstall(
		scope: "user" | "project",
		pluginId: string,
		entries: readonly InstalledPluginEntry[],
	): Promise<void> {
		const registryPath = this.#registryPath(scope);
		try {
			const reg = await readInstalledPluginsRegistry(registryPath);
			await writeInstalledPluginsRegistry(registryPath, {
				...reg,
				plugins: { ...reg.plugins, [pluginId]: [...entries] },
			});
		} catch (err) {
			logger.warn("Failed to restore the previous plugin registry entry", { pluginId, error: String(err) });
		}

		const active = entries[0];
		if (active) {
			try {
				const fallbackName = parsePluginId(pluginId)?.name ?? pluginId;
				const packageName = await this.#resolvePluginPackageName(active.installPath, fallbackName);
				await this.#registerRuntimePlugin(scope, packageName, active.installPath, active.version, active.enabled);
			} catch (err) {
				logger.warn("Failed to restore the previous plugin runtime link", { pluginId, error: String(err) });
			}
		}
		this.#clearCache();
	}

	/** Drop cache directories of `name@marketplace` that no registry references. */
	async #prunePluginCache(marketplace: string, name: string): Promise<void> {
		const prefix = `${marketplace}___${name}___`;
		let entries: string[];
		try {
			entries = await fs.readdir(this.#opts.pluginsCacheDir);
		} catch {
			return;
		}
		const [userReg, projectReg] = await Promise.all([
			readInstalledPluginsRegistry(this.#opts.installedRegistryPath),
			this.#opts.projectInstalledRegistryPath
				? readInstalledPluginsRegistry(this.#opts.projectInstalledRegistryPath)
				: Promise.resolve({ version: 2 as const, plugins: {} as Record<string, InstalledPluginEntry[]> }),
		]);
		const referenced = collectReferencedPaths(userReg, projectReg);
		for (const entry of entries) {
			if (!entry.startsWith(prefix)) continue;
			const fullPath = path.join(this.#opts.pluginsCacheDir, entry);
			if (referenced.has(fullPath)) continue;
			await fs.rm(fullPath, { recursive: true, force: true }).catch(() => {});
		}
	}

	// Upgrade a plugin across all scopes where it is installed.
	// Returns one entry per scope upgraded (0–2 entries).
	async upgradePluginAcrossScopes(
		pluginId: string,
		options: PluginUpgradeOptions = {},
	): Promise<InstalledPluginEntry[]> {
		const parsed = parsePluginId(pluginId);
		if (!parsed) {
			throw new Error(`Invalid plugin ID: "${pluginId}". Expected "name@marketplace".`);
		}

		const { userEntries, projectEntries } = await this.#findInBothRegistries(pluginId);

		const inUser = userEntries && userEntries.length > 0;
		const inProject = projectEntries && projectEntries.length > 0;

		if (!inUser && !inProject) {
			throw new Error(`Plugin "${pluginId}" is not installed`);
		}

		const results: InstalledPluginEntry[] = [];

		if (inProject) {
			const entry = await this.upgradePlugin(pluginId, "project", options);
			results.push(entry);
		}
		if (inUser) {
			const entry = await this.upgradePlugin(pluginId, "user", options);
			results.push(entry);
		}

		return results;
	}

	// Upgrade every (pluginId, scope) pair that checkForUpdates reports as outdated.
	// Only stale scopes are touched; a current user install is not re-installed when only
	// the project scope is stale. Per-entry failures are skipped — partial success is returned.
	async upgradeAllPlugins(): Promise<
		Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }>
	> {
		const updates = await this.checkForUpdates();
		const results: Array<{ pluginId: string; scope: "user" | "project"; from: string; to: string }> = [];
		for (const update of updates) {
			try {
				const entry = await this.upgradePlugin(update.pluginId, update.scope);
				results.push({ pluginId: update.pluginId, scope: update.scope, from: update.from, to: entry.version });
			} catch {
				// Skip this entry; partial upgrades are better than none.
			}
		}
		return results;
	}

	// ── Private helpers ───────────────────────────────────────────────────────

	#runtimeRoot(scope: "user" | "project"): string {
		return path.dirname(this.#registryPath(scope));
	}

	#nodeModulesPath(scope: "user" | "project"): string {
		return path.join(this.#runtimeRoot(scope), "node_modules");
	}

	#runtimeLockPath(scope: "user" | "project"): string {
		return path.join(this.#runtimeRoot(scope), "musepi-plugins.lock.json");
	}

	async #loadRuntimeConfig(scope: "user" | "project"): Promise<PluginRuntimeConfig> {
		try {
			return normalizePluginRuntimeConfig(await Bun.file(this.#runtimeLockPath(scope)).json());
		} catch (err) {
			if (isEnoent(err)) return normalizePluginRuntimeConfig({});
			logger.warn("Failed to load marketplace plugin runtime config", {
				path: this.#runtimeLockPath(scope),
				error: String(err),
			});
			return normalizePluginRuntimeConfig({});
		}
	}

	async #writeRuntimeConfig(scope: "user" | "project", config: PluginRuntimeConfig): Promise<void> {
		await Bun.write(this.#runtimeLockPath(scope), JSON.stringify(config, null, 2));
	}

	async #resolvePluginPackageName(installPath: string, fallbackName: string): Promise<string> {
		try {
			const pkg: { name?: unknown } = await Bun.file(path.join(installPath, "package.json")).json();
			const name = typeof pkg.name === "string" && pkg.name.length > 0 ? pkg.name : fallbackName;
			return assertRuntimePackageName(name);
		} catch (err) {
			if (isEnoent(err)) return assertRuntimePackageName(fallbackName);
			throw err;
		}
	}

	#runtimePackagePath(scope: "user" | "project", packageName: string): string {
		const nodeModules = path.resolve(this.#nodeModulesPath(scope));
		const linkPath = path.resolve(nodeModules, assertRuntimePackageName(packageName));
		const relative = path.relative(nodeModules, linkPath);
		if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
			throw new Error(`Marketplace plugin package path escapes node_modules: ${JSON.stringify(packageName)}`);
		}
		return linkPath;
	}

	async #resolveInstalledPackageNames(
		entries: readonly InstalledPluginEntry[],
		fallbackName: string,
	): Promise<Set<string>> {
		const packageNames = new Set<string>();
		for (const entry of entries) {
			packageNames.add(await this.#resolvePluginPackageName(entry.installPath, fallbackName));
		}
		return packageNames;
	}

	async #registerRuntimePlugin(
		scope: "user" | "project",
		packageName: string,
		cachePath: string,
		version: string,
		enabled: boolean | undefined,
	): Promise<void> {
		const linkPath = this.#runtimePackagePath(scope, packageName);
		await fs.mkdir(path.dirname(linkPath), { recursive: true });
		await fs.rm(linkPath, { recursive: true, force: true });
		await fs.symlink(cachePath, linkPath, process.platform === "win32" ? "junction" : "dir");

		const config = await this.#loadRuntimeConfig(scope);
		const previous = config.plugins[packageName];
		config.plugins[packageName] = {
			version,
			enabledFeatures: previous?.enabledFeatures ?? null,
			enabled: enabled ?? previous?.enabled ?? true,
		};
		await this.#writeRuntimeConfig(scope, config);
	}

	async #removeRuntimePlugin(scope: "user" | "project", packageName: string): Promise<void> {
		await fs.rm(this.#runtimePackagePath(scope, packageName), { recursive: true, force: true });

		const config = await this.#loadRuntimeConfig(scope);
		delete config.plugins[packageName];
		delete config.settings[packageName];
		await this.#writeRuntimeConfig(scope, config);
	}

	async #setRuntimePluginEnabled(scope: "user" | "project", packageName: string, enabled: boolean): Promise<void> {
		const config = await this.#loadRuntimeConfig(scope);
		const previous = config.plugins[packageName];
		if (!previous) return;

		config.plugins[packageName] = { ...previous, enabled };
		await this.#writeRuntimeConfig(scope, config);
	}

	#registryPath(scope: "user" | "project"): string {
		if (scope === "project") {
			if (!this.#opts.projectInstalledRegistryPath) {
				throw new Error("project-scoped install requires running inside a project directory");
			}
			return this.#opts.projectInstalledRegistryPath;
		}
		return this.#opts.installedRegistryPath;
	}

	async #findInBothRegistries(pluginId: string): Promise<{
		userEntries: InstalledPluginEntry[] | undefined;
		projectEntries: InstalledPluginEntry[] | undefined;
		userReg: InstalledPluginsRegistry;
		projectReg: InstalledPluginsRegistry;
	}> {
		const [userReg, projectReg] = await Promise.all([
			readInstalledPluginsRegistry(this.#opts.installedRegistryPath),
			this.#opts.projectInstalledRegistryPath
				? readInstalledPluginsRegistry(this.#opts.projectInstalledRegistryPath)
				: Promise.resolve({ version: 2 as const, plugins: {} as Record<string, InstalledPluginEntry[]> }),
		]);
		return {
			userEntries: getInstalledPlugin(userReg, pluginId),
			projectEntries: getInstalledPlugin(projectReg, pluginId),
			userReg,
			projectReg,
		};
	}

	async #readCatalog(entry: MarketplaceRegistryEntry): Promise<MarketplaceCatalog> {
		try {
			const content = await Bun.file(entry.catalogPath).text();
			return parseMarketplaceCatalog(content, entry.catalogPath);
		} catch (err) {
			if (isEnoent(err)) {
				const embedded = defaultMarketplaceCatalog(entry.name);
				if (embedded && this.#opts.includeDefaultMarketplaces) return embedded;
				throw new Error(
					`Marketplace catalog not found at ${entry.catalogPath}. Try: /marketplace update ${entry.name}`,
				);
			}
			throw err;
		}
	}

	/**
	 * Compute the marketplace root directory for source resolution.
	 *
	 * For local sources: sourceUri IS the local path, so resolve it directly.
	 * This gives the directory containing `.claude-plugin/marketplace.json`,
	 * which is what resolvePluginSource expects as `marketplaceClonePath`.
	 *
	 * For remote sources (git/github/url): the catalog was cloned into
	 * `<marketplacesCacheDir>/<name>/`, so the root is the parent of catalogPath.
	 */
	#resolveMarketplaceRoot(entry: MarketplaceRegistryEntry): string {
		if (entry.sourceType === "local") {
			// expandHome already happened in fetcher; resolve to ensure absolute.
			const expanded = entry.sourceUri.startsWith("~/")
				? path.join(os.homedir(), entry.sourceUri.slice(2))
				: entry.sourceUri;
			return path.resolve(expanded);
		}
		// For git/github/url sources, the catalog lives at <cloneDir>/marketplace.json
		// under marketplacesCacheDir/<name>/; parent = <marketplacesCacheDir>/<name>/
		return path.dirname(entry.catalogPath);
	}
}
