/**
 * Web Search Provider Registry — minimal port for setup wizard integration.
 *
 * Manages the preferred web search provider preference. Persistence will be
 * wired through @musepi/core settings once the setting key is defined.
 */

import { SEARCH_PROVIDER_LABELS, type SearchProviderId } from "./types.ts";

let preferredProvId: SearchProviderId | "auto" = "auto";

/** Set the preferred web search provider. */
export function setPreferredSearchProvider(provider: SearchProviderId | "auto"): void {
	preferredProvId = provider;
}

/** Get the currently preferred provider id (default "auto"). */
export function getPreferredSearchProvider(): SearchProviderId | "auto" {
	return preferredProvId;
}

/** Display label for a provider id. */
export function getSearchProviderLabel(id: SearchProviderId): string {
	return SEARCH_PROVIDER_LABELS[id] ?? id;
}
