/**
 * Capability Registry
 *
 * Central registry for capabilities and providers. Provides the main API for:
 * - Defining capabilities (what we're looking for)
 * - Registering providers (where to find it)
 * - Loading items for a capability across all providers
 */
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir, logger } from "@musepi/pi-utils";

import type { Settings } from "../config/settings";
import { clearCache as clearFsCache, findRepoRoot, cacheStats as fsCacheStats, invalidate as invalidateFs } from "./fs";
import type {
	Capability,
	CapabilityInfo,
	CapabilityResult,
	LoadContext,
	LoadOptions,
	Provider,
	ProviderInfo,
	SourceMeta,
} from "./types";

// =============================================================================
// Registry State
// =============================================================================

/** Registry of all capabilities */
const capabilities = new Map<string, Capability<unknown>>();

/** Reverse index: provider ID -> capability IDs it's registered for */
const providerCapabilities = new Map<string, Set<string>>();

/** Provider display metadata (shared across capabilities) */
const providerMeta = new Map<string, { displayName: string; description: string }>();

/** Disabled providers (by ID) */
const disabledProviders = new Set<string>();

/** Settings manager for persistence (if set) */
let settings: Settings | null = null;

// =============================================================================
// Registration API
// =============================================================================

/**
 * Define a new capability.
 */
export function defineCapability<T>(def: Omit<Capability<T>, "providers">): Capability<T> {
	if (capabilities.has(def.id)) {
		throw new Error(`Capability "${def.id}" is already defined`);
	}
	const capability: Capability<T> = { ...def, providers: [] };
	capabilities.set(def.id, capability as Capability<unknown>);
	return capability;
}

/**
 * Register a provider for a capability.
 */
export function registerProvider<T>(capabilityId: string, provider: Provider<T>): void {
	const capability = capabilities.get(capabilityId);
	if (!capability) {
		throw new Error(`Unknown capability: "${capabilityId}". Define it first with defineCapability().`);
	}

	// Store provider metadata (for cross-capability display)
	if (!providerMeta.has(provider.id)) {
		providerMeta.set(provider.id, {
			displayName: provider.displayName,
			description: provider.description,
		});
	}

	// Track which capabilities this provider is registered for
	if (!providerCapabilities.has(provider.id)) {
		providerCapabilities.set(provider.id, new Set());
	}
	providerCapabilities.get(provider.id)!.add(capabilityId);

	// Insert in priority order (highest first)
	const providers = capability.providers as Provider<T>[];
	const idx = providers.findIndex(p => p.priority < provider.priority);
	if (idx === -1) {
		providers.push(provider);
	} else {
		providers.splice(idx, 0, provider);
	}
}

// =============================================================================
// Loading API
// =============================================================================

/**
 * Process-level cache for capability loads. The daemon re-activates sessions
 * against the SAME cwd repeatedly (the GUI's open-session flow), and every
 * activation re-runs the full provider scan (rules: agents/cursor/windsurf/
 * cline/builtin/github — measured ~2s on a large repo). Results are
 * immutable-by-convention within the TTL; callers get a shallow-copied items
 * array so consumer-side mutations never poison the cache.
 */
const CAPABILITY_CACHE_TTL_MS = 5_000;
interface CapabilityCacheEntry {
	at: number;
	result: unknown;
}
const capabilityCache = new Map<string, CapabilityCacheEntry>();

function capabilityCacheKey(capabilityId: string, ctx: LoadContext, options: LoadOptions<unknown>): string {
	const disabled = disabledProviders.size > 0 ? Array.from(disabledProviders).sort().join(",") : "";
	const ext = Array.isArray(options.disabledExtensions) ? options.disabledExtensions.sort().join(",") : "";
	// omp 兼容 force 集参与缓存键 —— 否则 setForceEnabled 后命中旧结果。
	const force = Array.isArray(options.forceEnabledIds) ? options.forceEnabledIds.sort().join(",") : "";
	const extra = options.cacheKeyExtra ?? "";
	return `${capabilityId}|${ctx.cwd}|${ctx.repoRoot ?? ""}|${disabled}|${ext}|${force}|${extra}`;
}

/**
 * Async loading logic shared by loadCapability().
 */
async function loadImpl<T>(
	capability: Capability<T>,
	providers: Provider<T>[],
	ctx: LoadContext,
	options: LoadOptions<T>,
): Promise<CapabilityResult<T>> {
	const allItems: Array<T & { _source: SourceMeta; _shadowed?: boolean; _shadowedBy?: string }> = [];
	const suppressedItems = new Set<T & { _source: SourceMeta; _shadowed?: boolean; _shadowedBy?: string }>();
	const allWarnings: string[] = [];
	const contributingProviders: string[] = [];
	const disabledExtensionIds = options.includeDisabled
		? new Set<string>()
		: new Set<string>(options.disabledExtensions ?? settings?.get("disabledExtensions") ?? []);
	// omp 生态智能兼容:显式启用集优先于优先级去重(见 LoadOptions)。
	const forceEnabledIds = new Set<string>(options.forceEnabledIds ?? []);

	const results = await Promise.all(
		providers.map(async provider => {
			try {
				const result = await logger.time(
					`capability:${capability.id}:${provider.id}`,
					provider.load.bind(provider),
					ctx,
				);
				return { provider, result };
			} catch (error) {
				logger.debug(`capability:${capability.id}:${provider.id}:error`);
				return { provider, error };
			}
		}),
	);

	for (const entry of results) {
		const { provider } = entry;
		if ("error" in entry) {
			allWarnings.push(`[${provider.displayName}] Failed to load: ${entry.error}`);
			continue;
		}

		const result = entry.result;
		if (!result) continue;

		if (result.warnings) {
			allWarnings.push(...result.warnings.map(w => `[${provider.displayName}] ${w}`));
		}

		let contributedItemCount = 0;
		for (const item of result.items) {
			const itemWithSource = item as T & { _source: SourceMeta };
			if (!itemWithSource._source) {
				allWarnings.push(`[${provider.displayName}] Item missing _source metadata, skipping`);
				continue;
			}

			const extensionId = capability.toExtensionId?.(itemWithSource);
			if (extensionId && disabledExtensionIds.has(extensionId)) {
				continue;
			}

			if (options.filter && !options.filter(itemWithSource)) {
				continue;
			}

			if (options.suppress?.(itemWithSource)) {
				// Suppressed items still claim their dedupe key below, so a
				// suppressed higher-priority item shadows same-key lower-priority
				// ones, but they never survive or equivalence-shadow survivors.
				itemWithSource._source.providerName = provider.displayName;
				const suppressed = itemWithSource as T & { _source: SourceMeta; _shadowed?: boolean };
				suppressedItems.add(suppressed);
				allItems.push(suppressed);
				continue;
			}

			itemWithSource._source.providerName = provider.displayName;
			allItems.push(itemWithSource as T & { _source: SourceMeta; _shadowed?: boolean });
			contributedItemCount += 1;
		}

		if (contributedItemCount > 0) {
			contributingProviders.push(provider.id);
		}
	}

	// Deduplicate by key or semantic equivalence (first wins = highest priority,
	// unless the later item is force-enabled — omp 兼容项显式启用时反转)。
	const seen = new Set<string>();
	const deduped: Array<T & { _source: SourceMeta; _shadowed?: boolean; _shadowedBy?: string }> = [];
	const equivalent = capability.equivalent;

	const extensionIdOf = (item: T & { _source: SourceMeta }): string | undefined => capability.toExtensionId?.(item);

	for (const item of allItems) {
		const key = capability.key(item);

		if (suppressedItems.has(item)) {
			// Claim key ownership (same-name precedence, including disabled
			// state) without surviving or equivalence-shadowing survivors.
			if (key !== undefined) seen.add(key);
			continue;
		}

		if (key === undefined) {
			deduped.push(item);
			continue;
		}

		const keySeen = seen.has(key);
		seen.add(key);
		const itemExtId = extensionIdOf(item);
		const forced = itemExtId !== undefined && forceEnabledIds.has(itemExtId);
		const aliasSeen = !keySeen && equivalent !== undefined && deduped.some(existing => equivalent(existing, item));
		if (forced && keySeen) {
			// 显式启用:低优先级项存活,原胜者反向 shadow(感知层决策覆盖默认)。
			const index = deduped.findIndex(existing => capability.key(existing) === key || equivalent?.(existing, item));
			if (index >= 0) {
				const winner = deduped[index];
				winner._shadowed = true;
				winner._shadowedBy = `${item._source.providerName} (${item._source.provider})`;
				deduped[index] = winner;
			}
			deduped.push(item);
			seen.add(key);
		} else if (keySeen || aliasSeen) {
			item._shadowed = true;
			const winner = deduped.find(
				existing => capability.key(existing) === key || (equivalent?.(existing, item) ?? false),
			);
			item._shadowedBy = winner
				? `${winner._source.providerName} (${winner._source.provider})`
				: "同 key 高优先级项";
		} else {
			deduped.push(item);
		}
	}

	// Validate items (only non-shadowed items)
	if (capability.validate && !options.includeInvalid) {
		for (let i = deduped.length - 1; i >= 0; i--) {
			const error = capability.validate(deduped[i]);
			if (error) {
				const source = deduped[i]._source;
				allWarnings.push(
					`[${source?.providerName ?? "unknown"}] Invalid item at ${source?.path ?? "unknown"}: ${error}`,
				);
				deduped.splice(i, 1);
			}
		}
	}

	return {
		items: deduped,
		all: suppressedItems.size > 0 ? allItems.filter(item => !suppressedItems.has(item)) : allItems,
		warnings: allWarnings,
		providers: contributingProviders,
	};
}

/**
 * Filter providers based on options and disabled state.
 */
function filterProviders<T>(capability: Capability<T>, options: LoadOptions<T>): Provider<T>[] {
	let providers = (capability.providers as Provider<T>[]).filter(p => !disabledProviders.has(p.id));

	if (options.providers) {
		const allowed = new Set(options.providers);
		providers = providers.filter(p => allowed.has(p.id));
	}
	if (options.excludeProviders) {
		const excluded = new Set(options.excludeProviders);
		providers = providers.filter(p => !excluded.has(p.id));
	}

	return providers;
}

/**
 * Load a capability by ID.
 */
export async function loadCapability<T>(
	capabilityId: string,
	options: LoadOptions<T> = {},
): Promise<CapabilityResult<T>> {
	const capability = capabilities.get(capabilityId) as Capability<T> | undefined;
	if (!capability) {
		throw new Error(`Unknown capability: "${capabilityId}"`);
	}

	const cwd = options.cwd ?? getProjectDir();
	const home = os.homedir();
	const repoRoot = await findRepoRoot(cwd);
	const ctx: LoadContext = { cwd, home, repoRoot };
	const providers = filterProviders(capability, options);

	// TTL cache: skip the full provider scan on repeated loads from the same
	// workspace (daemon session re-activation). See capabilityCacheKey.
	const cacheKey = capabilityCacheKey(capabilityId, ctx, options);
	const cached = capabilityCache.get(cacheKey);
	if (cached && Date.now() - cached.at < CAPABILITY_CACHE_TTL_MS) {
		return (cached.result as CapabilityResult<T>) ?? { items: [], all: [], warnings: [], providers: [] };
	}

	const result = await loadImpl(capability, providers, ctx, options);
	capabilityCache.set(cacheKey, {
		at: Date.now(),
		result: { ...result, items: [...result.items], all: [...result.all], warnings: [...result.warnings] },
	});
	return result;
}

// =============================================================================
// Provider Enable/Disable API
// =============================================================================

/**
 * Initialize capability system with settings manager for persistence.
 * Call this once on startup to enable persistent provider state.
 */
export function initializeWithSettings(activeSettings: Settings): void {
	settings = activeSettings;
	// Load disabled providers from settings
	const disabled = settings.get("disabledProviders");
	disabledProviders.clear();
	for (const id of disabled) {
		disabledProviders.add(id);
	}
}

/**
 * Persist current disabled providers to settings.
 */
function persistDisabledProviders(): void {
	if (settings) {
		settings.set("disabledProviders", Array.from(disabledProviders));
	}
}

/**
 * Disable a provider globally (across all capabilities).
 */
export function disableProvider(providerId: string): void {
	disabledProviders.add(providerId);
	persistDisabledProviders();
}

/**
 * Enable a previously disabled provider.
 */
export function enableProvider(providerId: string): void {
	disabledProviders.delete(providerId);
	persistDisabledProviders();
}

/**
 * Check if a provider is enabled.
 */
export function isProviderEnabled(providerId: string): boolean {
	return !disabledProviders.has(providerId);
}

/**
 * Get list of all disabled provider IDs.
 */
export function getDisabledProviders(): string[] {
	return Array.from(disabledProviders);
}

/**
 * Set disabled providers from a list (replaces current set).
 */
export function setDisabledProviders(providerIds: string[]): void {
	disabledProviders.clear();
	for (const id of providerIds) {
		disabledProviders.add(id);
	}
	persistDisabledProviders();
}

// =============================================================================
// Introspection API
// =============================================================================

/**
 * Get a capability definition (for introspection).
 */
export function getCapability<T>(id: string): Capability<T> | undefined {
	return capabilities.get(id) as Capability<T> | undefined;
}

/**
 * List all registered capability IDs.
 */
export function listCapabilities(): string[] {
	return Array.from(capabilities.keys());
}

/**
 * Get capability info for UI display.
 */
export function getCapabilityInfo(capabilityId: string): CapabilityInfo | undefined {
	const capability = capabilities.get(capabilityId);
	if (!capability) return undefined;

	return {
		id: capability.id,
		displayName: capability.displayName,
		description: capability.description,
		providers: capability.providers.map(p => ({
			id: p.id,
			displayName: p.displayName,
			description: p.description,
			priority: p.priority,
			enabled: !disabledProviders.has(p.id),
		})),
	};
}

/**
 * Get all capabilities info for UI display.
 */
export function getAllCapabilitiesInfo(): CapabilityInfo[] {
	return listCapabilities().map(id => getCapabilityInfo(id)!);
}

/**
 * Get provider info for UI display.
 */
export function getProviderInfo(providerId: string): ProviderInfo | undefined {
	const meta = providerMeta.get(providerId);
	const caps = providerCapabilities.get(providerId);
	if (!meta || !caps) return undefined;

	// Find priority from first capability's provider list
	let priority = 0;
	for (const capId of caps) {
		const cap = capabilities.get(capId);
		const provider = cap?.providers.find(p => p.id === providerId);
		if (provider) {
			priority = provider.priority;
			break;
		}
	}

	return {
		id: providerId,
		displayName: meta.displayName,
		description: meta.description,
		priority,
		capabilities: Array.from(caps),
		enabled: !disabledProviders.has(providerId),
	};
}

/**
 * Get all providers info for UI display (deduplicated across capabilities).
 */
export function getAllProvidersInfo(): ProviderInfo[] {
	const providers: ProviderInfo[] = [];

	for (const providerId of providerMeta.keys()) {
		const info = getProviderInfo(providerId);
		if (info) {
			providers.push(info);
		}
	}

	// Sort by priority (highest first)
	providers.sort((a, b) => b.priority - a.priority);

	return providers;
}

// =============================================================================
// Cache Management
// =============================================================================

/**
 * Reset all caches. Call after chdir or filesystem changes.
 */
export function reset(): void {
	clearFsCache();
	// Drop the loadCapability TTL cache too — it memoizes provider scans
	// (context files, rules, skills) for CAPABILITY_CACHE_TTL_MS and would
	// otherwise serve stale AGENTS.md/CLAUDE.md bytes after a context reset
	// or chdir, even though the fs content cache underneath was cleared.
	capabilityCache.clear();
}

/**
 * Invalidate cache for a specific path.
 * @param filePath - Absolute or relative path to invalidate
 */
export function invalidate(filePath: string, cwd?: string): void {
	const resolved = cwd ? path.resolve(cwd, filePath) : filePath;
	invalidateFs(resolved);
}

/**
 * Get cache stats for diagnostics.
 */
export function cacheStats(): { content: number; dir: number } {
	return fsCacheStats();
}

// =============================================================================
// Re-exports
// =============================================================================

export type * from "./types";
