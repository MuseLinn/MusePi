/**
 * Prompt-cache guard for speculative compaction.
 *
 * A speculative summary reads the prefix the provider last processed, so it
 * stays cheap only while that prefix's cache entry is alive. Once the entry has
 * expired, writing the summary pays a full cache write for the whole prefix at
 * the same moment the user's next request would want that cache: the summary is
 * wasted work and a second full prefill. The guard skips speculation when the
 * newest response with real usage is older than the cache lifetime minus a
 * margin.
 *
 * The lifetime comes from the model's own cache declaration
 * (`getPromptCacheTtlMs`). Models that declare none take
 * {@link DEFAULT_PROMPT_CACHE_LIFETIME_MS}, matching the provider default the
 * cache warmer assumes.
 */

import type { Model, SimpleStreamOptions } from "@musepi/pi-ai";
import { getPromptCacheTtlMs } from "./cache-warmer";

/** Provider default when a model declares no prompt-cache lifetime (5 minutes). */
export const DEFAULT_PROMPT_CACHE_LIFETIME_MS = 5 * 60_000;

/**
 * Share of the lifetime left unused before speculation stops. Writing a summary
 * takes 30–60s, so starting it later than this leaves the entry cold by the time
 * the result could be spliced in.
 */
export const PROMPT_CACHE_GUARD_MARGIN_MS = 30_000;

/** Cache lifetime for `model` in milliseconds, or undefined when its retention is `none`. */
export function resolvePromptCacheLifetimeMs(
	model: Model,
	options: SimpleStreamOptions | undefined,
	isOAuthToken = false,
): number | undefined {
	const ttlMs = getPromptCacheTtlMs(model, options, isOAuthToken);
	if (ttlMs !== undefined) return ttlMs;
	return model.promptCache ? undefined : DEFAULT_PROMPT_CACHE_LIFETIME_MS;
}

/**
 * Whether a prompt-cache entry written by a response `ageMs` ago is still warm
 * enough to speculate against.
 */
export function isPromptCacheWarm(lifetimeMs: number, ageMs: number): boolean {
	return ageMs < lifetimeMs - Math.min(PROMPT_CACHE_GUARD_MARGIN_MS, Math.floor(lifetimeMs / 4));
}
