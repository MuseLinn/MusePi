// Web search provider resolution.
//
// Built-in and runtime-registered providers live in `registry.ts`; this module
// owns the resolution policy (configured order, exclusions, connectivity
// backoff, forced selection) and the user-facing failure formatting.

import type { AuthStorage } from "@musepi/pi-ai";
import type { SearchProvider } from "./providers/base";
import {
	getRegisteredSearchProvider,
	listRegisteredSearchProviders,
	resolveSearchProviderInstance,
	toSearchProviderId,
} from "./registry";
import { type AnySearchProviderId, SEARCH_PROVIDER_ORDER, SearchProviderError } from "./types";

export type { SearchParams } from "./providers/base";
export { SearchProvider } from "./providers/base";
export { SEARCH_PROVIDER_ORDER } from "./types";

/** Cheap, sync metadata accessor — never triggers a provider load. */
export function getSearchProviderLabel(id: AnySearchProviderId): string {
	return getRegisteredSearchProvider(id)?.label ?? id;
}

/** Format one provider failure for the user-facing fallback summary. */
export function formatSearchProviderFailure(error: unknown, provider: Pick<SearchProvider, "id" | "label">): string {
	if (error instanceof SearchProviderError) {
		if (error.provider === "anthropic" && error.status === 404) {
			return "Anthropic web search returned 404 (model or endpoint not found).";
		}
		if (error.status === 401 || error.status === 403) {
			if (error.provider === "zai") {
				return error.message;
			}
			return `${getSearchProviderLabel(error.provider)} authorization failed (${error.status}). Check API key or base URL.`;
		}
		return error.message;
	}
	if (error instanceof Error) return error.message;
	return `Unknown error from ${provider.label}`;
}

/** Format the ordered provider fallback failures for terminal/tool output. */
export function formatSearchProviderFailures(
	failures: readonly { provider: Pick<SearchProvider, "id" | "label">; error: unknown }[],
): string {
	return failures.map(f => `${f.provider.id}: ${formatSearchProviderFailure(f.error, f.provider)}`).join("; ");
}

/**
 * Resolve and cache a provider instance. First call for a given id loads the
 * underlying module; subsequent calls return the cached singleton.
 */
export async function getSearchProvider(id: AnySearchProviderId): Promise<SearchProvider> {
	return resolveSearchProviderInstance(id);
}

/**
 * Provider ids the user listed in `providers.webSearchOrder`, in preference
 * order. Unknown ids are retained here and filtered at resolution time, so a
 * provider registered later still wins its configured slot.
 */
let orderedProvIds: readonly string[] = [];
/** Providers the user explicitly listed in `providers.webSearchOrder`. */
let explicitProvIds = new Set<string>();

/**
 * Prioritize configured providers while retaining every unlisted provider in
 * its built-in relative order. Unknown IDs are ignored defensively at
 * resolution time. Listed providers are treated as explicit selections: they
 * resolve through `isExplicitlyAvailable`, so e.g. a hand-listed Perplexity may
 * fall back to anonymous search exactly like the retired single-preference
 * setting did.
 */
export function setSearchProviderOrder(providers: readonly AnySearchProviderId[]): void {
	const prioritized = [...new Set(providers.map(id => id.trim()).filter(id => id.length > 0))];
	explicitProvIds = new Set(prioritized);
	orderedProvIds = prioritized;
}

/** Providers excluded from web search resolution via settings. */
let excludedProvIds = new Set<string>();

/** Set providers that web search should never use, including fallbacks. */
export function setExcludedSearchProviders(providers: readonly AnySearchProviderId[]): void {
	excludedProvIds = new Set(providers.map(id => id.trim()).filter(id => id.length > 0));
}

/** `true` when settings exclude `id` from web search (auto chain and the Public Web fan-out). */
export function isSearchProviderExcluded(id: AnySearchProviderId): boolean {
	return excludedProvIds.has(id);
}

/**
 * Transport-level failure signatures (DNS, TCP, TLS, socket) — the endpoint
 * could not be reached at all. HTTP-status failures (401/403/429, CAPTCHA)
 * are deliberately excluded: those prove reachability, and the same provider
 * may succeed on the next query.
 */
const CONNECTION_LEVEL_ERROR_PATTERN =
	/unable to connect|fetch failed|ECONN(?:REFUSED|RESET|ABORTED)|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|UND_ERR_CONNECT_TIMEOUT/i;

/** `true` when the failure happened before any HTTP exchange (connection refused, DNS, reset, …). */
export function isConnectionLevelSearchError(error: unknown): boolean {
	let current: unknown = error;
	while (current instanceof Error) {
		if (CONNECTION_LEVEL_ERROR_PATTERN.test(current.message)) return true;
		current = current.cause;
	}
	return false;
}

/**
 * How long a provider that failed at the connection level stays skipped in
 * the auto chain. Short enough to recover from a transient blip, long enough
 * that a dead endpoint (e.g. every overseas engine on a proxyless mainland
 * connection) stops costing each search a full hard-timeout wait.
 */
const CONNECTIVITY_RETRY_AFTER_MS = 5 * 60 * 1000;

/** Provider id → timestamp of its latest connection-level failure. */
const connectivityFailures = new Map<string, number>();

/** Record that `id` failed before any HTTP exchange; the auto chain skips it for a while. */
export function recordSearchProviderConnectivityFailure(id: AnySearchProviderId): void {
	connectivityFailures.set(id, Date.now());
}

/** Clear the recorded connection-level failure for `id` (e.g. after a successful search). */
export function clearSearchProviderConnectivityFailure(id: AnySearchProviderId): void {
	connectivityFailures.delete(id);
}

/** Forget every recorded connection-level failure. Test-only; production state expires via the TTL. */
export function resetSearchProviderConnectivity(): void {
	connectivityFailures.clear();
}

function isConnectivityDown(id: string): boolean {
	const failedAt = connectivityFailures.get(id);
	if (failedAt === undefined) return false;
	if (Date.now() - failedAt <= CONNECTIVITY_RETRY_AFTER_MS) return true;
	connectivityFailures.delete(id);
	return false;
}

export interface SearchProviderCandidate {
	id: AnySearchProviderId;
	explicit: boolean;
}

/**
 * Return provider candidates in fallback order without loading their modules.
 *
 * Order: configured ids first, then the built-in order, then runtime-registered
 * providers in registration order. `forcedProvider` (a per-request `provider`
 * argument) is terminal-first; an excluded id is dropped in every position.
 * Configured-order entries carry `explicit: true`.
 */
export function resolveProviderCandidates(forcedProvider?: AnySearchProviderId): SearchProviderCandidate[] {
	const candidates: SearchProviderCandidate[] = [];
	const registered = listRegisteredSearchProviders();
	const known = new Set(registered.map(provider => provider.id));
	const chain = [
		...orderedProvIds.filter(id => known.has(id)),
		...SEARCH_PROVIDER_ORDER.filter(id => !explicitProvIds.has(id)),
		...registered
			.filter(provider => !provider.builtin && !explicitProvIds.has(provider.id))
			.map(provider => provider.id),
	];

	if (forcedProvider !== undefined && !isSearchProviderExcluded(forcedProvider)) {
		candidates.push({ id: forcedProvider, explicit: true });
	}

	const seen = new Set<string>([forcedProvider ?? ""]);
	for (const id of chain) {
		if (seen.has(id)) continue;
		seen.add(id);
		const providerId = toSearchProviderId(id);
		if (isSearchProviderExcluded(providerId)) continue;
		const explicit = explicitProvIds.has(id);
		// Providers that recently failed at the connection level, or whose
		// descriptor availability gate is closed, are skipped in the auto chain;
		// explicit selections (listed in `webSearchOrder` or forced) always run.
		if (!explicit) {
			if (getRegisteredSearchProvider(id)?.availability?.() === false) continue;
			if (isConnectivityDown(id)) continue;
		}
		candidates.push({ id: providerId, explicit });
	}

	return candidates;
}

/**
 * Resolve the complete available provider chain.
 *
 * This compatibility helper loads every candidate. Search execution should use
 * {@link resolveProviderCandidates} so fallback modules load only when reached.
 */
export async function resolveProviderChain(
	authStorage: AuthStorage,
	forcedProvider?: AnySearchProviderId,
): Promise<SearchProvider[]> {
	const providers: SearchProvider[] = [];

	for (const candidate of resolveProviderCandidates(forcedProvider)) {
		const provider = await getSearchProvider(candidate.id);
		const available = candidate.explicit
			? await provider.isExplicitlyAvailable(authStorage)
			: await provider.isAvailable(authStorage);
		if (available) providers.push(provider);
	}

	return providers;
}
