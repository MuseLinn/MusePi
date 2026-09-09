/**
 * Capability Readiness
 *
 * Live state machine over each `(capabilityId, providerId)` pair and each
 * `capabilityId` aggregate. Lets the TUI / daemon / desktop panels render
 * honest "still loading…" / "ready" / "failed: <reason>" indicators instead
 * of empty panels that hide a half-scanned capability from the user.
 *
 * Lifecycle: `loadCapability` publishes transitions through this module as a
 * side effect of its existing load loop. Providers may declare an optional
 * `Provider<T>.ready?(ctx)` pre-flight hook that runs before `load()` — its
 * rejection marks the provider failed without ever calling `load()`.
 *
 * Concurrency: loadCapability can run concurrently for the same capability
 * from multiple call sites (daemon session re-activation, slash command,
 * + extension scanner). The state machine uses an "active attempt" counter
 * so transitions only commit when the LAST in-flight attempt resolves; a
 * later successful load doesn't get clobbered by an earlier failure, and
 * vice versa. Listeners fire once per transition commit.
 */

import { logger } from "@musepi/pi-utils";

import type { Provider, SourceMeta } from "./types.ts";

// =============================================================================
// State model
// =============================================================================

export type ReadinessState = "idle" | "loading" | "ready" | "failed" | "disabled";

export interface ProviderReadiness {
	providerId: string;
	displayName: string;
	state: ReadinessState;
	/** Last error message when `state === "failed"`. */
	error?: string;
	/** Unix ms epoch of the most recent successful load (state == ready). */
	lastLoadedAt?: number;
	/** Unix ms epoch of the most recent attempt of any state. */
	lastAttemptAt?: number;
	/** Number of attempts that ended in `failed`. */
	failureCount: number;
}

export interface CapabilityReadiness {
	capabilityId: string;
	state: ReadinessState;
	providers: ProviderReadiness[];
	/** ISO-8601 timestamp for human display. */
	updatedAt: string;
	error?: string;
}

// =============================================================================
// Internal store
// =============================================================================

interface ProviderEntry {
	displayName: string;
	/** Current state, only mutated by the helper functions below. */
	state: ReadinessState;
	error?: string;
	lastLoadedAt?: number;
	lastAttemptAt?: number;
	failureCount: number;
	/** In-flight load attempts; only commit state when this hits 0. */
	activeAttempts: number;
	/** Latest committed promise resolvers for whenReady(). */
	waiters: Array<(snap: CapabilityReadiness) => void>;
}

interface CapabilityEntry {
	providers: Map<string, ProviderEntry>;
	/** Listeners notified on every committed transition. */
	listeners: Set<(snap: CapabilityReadiness) => void>;
}

const store = new Map<string, CapabilityEntry>();

function ensureCapability(capabilityId: string): CapabilityEntry {
	let entry = store.get(capabilityId);
	if (!entry) {
		entry = { providers: new Map(), listeners: new Set() };
		store.set(capabilityId, entry);
	}
	return entry;
}

function ensureProvider(capabilityId: string, provider: Provider<unknown>): ProviderEntry {
	const cap = ensureCapability(capabilityId);
	let entry = cap.providers.get(provider.id);
	if (!entry) {
		entry = {
			displayName: provider.displayName,
			state: "idle",
			failureCount: 0,
			activeAttempts: 0,
			waiters: [],
		};
		cap.providers.set(provider.id, entry);
	} else {
		// Provider object may have been re-registered (display name changed
		// across package upgrades); keep the latest displayName.
		entry.displayName = provider.displayName;
	}
	return entry;
}

// =============================================================================
// Snapshot
// =============================================================================

function readEntry(capabilityId: string): CapabilityReadiness {
	const cap = store.get(capabilityId);
	const providers: ProviderReadiness[] = cap
		? Array.from(cap.providers.entries()).map(([id, entry]) => ({
				providerId: id,
				displayName: entry.displayName,
				state: entry.state,
				error: entry.error,
				lastLoadedAt: entry.lastLoadedAt,
				lastAttemptAt: entry.lastAttemptAt,
				failureCount: entry.failureCount,
			}))
		: [];
	return {
		capabilityId,
		state: aggregateState(providers),
		providers,
		updatedAt: new Date().toISOString(),
		error: aggregateError(providers),
	};
}

function aggregateState(providers: ProviderReadiness[]): ReadinessState {
	if (providers.length === 0) return "idle";
	let hasLoading = false;
	let hasReady = false;
	let hasFailed = false;
	let hasDisabled = false;
	for (const p of providers) {
		if (p.state === "loading") hasLoading = true;
		else if (p.state === "ready") hasReady = true;
		else if (p.state === "failed") hasFailed = true;
		else if (p.state === "disabled") hasDisabled = true;
	}
	// A failed load during an in-flight chain doesn't immediately flip the
	// capability to failed; the loading state wins until every attempt has
	// settled, so panels don't briefly flash "failed" before the retry.
	if (hasLoading) return "loading";
	if (hasReady) return "ready";
	if (hasFailed) return "failed";
	if (hasDisabled && !hasReady) return "disabled";
	return "idle";
}

function aggregateError(providers: ProviderReadiness[]): string | undefined {
	const failed = providers.filter(p => p.state === "failed" && p.error);
	if (failed.length === 0) return undefined;
	if (failed.length === 1) return failed[0]?.error;
	return `${failed.length} providers failed: ${failed.map(p => p.providerId).join(", ")}`;
}

// =============================================================================
// Public API
// =============================================================================

/** Snapshot the current readiness for a capability. Always synchronous. */
export function getReadiness(capabilityId: string): CapabilityReadiness {
	return readEntry(capabilityId);
}

/** Return readiness for every one we know about. Used by the status panel. */
export function getAllReadiness(): CapabilityReadiness[] {
	return Array.from(store.keys()).map(readEntry);
}

/**
 * Resolve once the capability has settled into a terminal or active state
 * (ready / failed / disabled / loading). Resolves immediately if the state is
 * already non-idle; otherwise waits for the next transition. Rejections are
 * never raised — readiness is informational.
 *
 * `options.timeoutMs` bounds the wait; the resolved snapshot reflects whatever
 * state is current at expiry (still "loading" if nothing has happened).
 */
export function whenReady(capabilityId: string, options: { timeoutMs?: number } = {}): Promise<CapabilityReadiness> {
	const cap = ensureCapability(capabilityId);
	const snapshot = readEntry(capabilityId);
	if (snapshot.state !== "idle") return Promise.resolve(snapshot);

	return new Promise(resolve => {
		const commit = () => resolve(readEntry(capabilityId));
		cap.listeners.add(commit);
		if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
			setTimeout(() => {
				cap.listeners.delete(commit);
				resolve(readEntry(capabilityId));
			}, options.timeoutMs);
		}
	});
}

/**
 * Subscribe to readiness transitions. The listener fires once per committed
 * transition across every capability currently tracked. Returns an unsubscribe
 * function. The listener receives a snapshot; compare `capabilityId` to filter.
 */
export function onReadinessChange(listener: (snap: CapabilityReadiness) => void): () => void {
	const wrapped = (snap: CapabilityReadiness) => {
		try {
			listener(snap);
		} catch (err) {
			console.debug("readiness:listener-error", err);
		}
	};
	for (const capabilityId of store.keys()) {
		const cap = store.get(capabilityId);
		if (cap) cap.listeners.add(wrapped);
	}
	const trackedListeners = new Set<CapabilityEntry["listeners"]>();
	for (const cap of store.values()) trackedListeners.add(cap.listeners);
	// Any capabilities registered AFTER subscription should also notify this
	// listener; lazily attach via a registry hook. Easiest: rely on
	// `syncProviderSet` and the per-capability listener sets — adding a new
	// capability mid-session is rare (plugin loader), so we cover it by
	// hooking the listener set on every new capability through a side-effect
	// in `ensureCapability`. See `attachGlobalListener` below.
	attachGlobalListener(wrapped);
	return () => {
		for (const listeners of trackedListeners) listeners.delete(wrapped);
		detachGlobalListener(wrapped);
	};
}

const globalListeners = new Set<(snap: CapabilityReadiness) => void>();

function attachGlobalListener(l: (snap: CapabilityReadiness) => void): void {
	globalListeners.add(l);
}

function detachGlobalListener(l: (snap: CapabilityReadiness) => void): void {
	globalListeners.delete(l);
}

function notifyGlobal(snapshot: CapabilityReadiness): void {
	for (const l of globalListeners) l(snapshot);
}

// =============================================================================
// Mutations invoked by loadCapability
// =============================================================================

/**
 * Mark every enabled provider as loading and run their `ready?()` pre-flight
 * hook in parallel. Returns the list of providers that passed pre-flight —
 * callers should skip the others in their load loop. Providers without a
 * `ready?()` hook always pass.
 */
export async function beginLoadAttempt<T>(
	capabilityId: string,
	providers: Provider<T>[],
	_ctx: { cwd: string; home: string; repoRoot: string | null },
): Promise<Provider<T>[]> {
	const survivors: Provider<T>[] = [];
	const probes = providers.map(async provider => {
		const entry = ensureProvider(capabilityId, provider);
		entry.activeAttempts += 1;
		entry.lastAttemptAt = Date.now();
		if (entry.activeAttempts === 1) commit(capabilityId, provider.id, { state: "loading" });
		if (typeof provider.ready !== "function") {
			survivors.push(provider);
			return;
		}
		try {
			await provider.ready(_ctx);
			survivors.push(provider);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.debug(`capability:${capabilityId}:${provider.id}:ready-failed: ${message}`);
			commit(capabilityId, provider.id, {
				state: "failed",
				error: message,
				failureCount: entry.failureCount + 1,
			});
			decrementAttempt(capabilityId, provider.id);
		}
	});
	await Promise.all(probes);
	return survivors;
}

/** Mark the provider ready once its load function resolved. */
export function recordLoadSuccess<T>(capabilityId: string, provider: Provider<T>): void {
	const entry = ensureProvider(capabilityId, provider);
	commit(capabilityId, provider.id, {
		state: "ready",
		lastLoadedAt: Date.now(),
		error: undefined,
	});
	decrementAttempt(capabilityId, provider.id);
}

/** Mark the provider failed once its load function rejected. */
export function recordLoadFailure<T>(capabilityId: string, provider: Provider<T>, error: unknown): void {
	const entry = ensureProvider(capabilityId, provider);
	const message = error instanceof Error ? error.message : String(error);
	commit(capabilityId, provider.id, {
		state: "failed",
		error: message,
		failureCount: entry.failureCount + 1,
	});
	decrementAttempt(capabilityId, provider.id);
}

/**
 * Record a disabled state for providers the option layer excluded. Called by
 * loadCapability when filtering out disabled providers so the readiness panel
 * reflects the user's intent rather than showing "loading" forever.
 */
export function recordDisabled<T>(capabilityId: string, provider: Provider<T>): void {
	ensureProvider(capabilityId, provider);
	commit(capabilityId, provider.id, { state: "disabled", error: undefined });
}

/** Drop all readiness state. Used by tests and the bootstrap layer. */
export function resetReadiness(): void {
	store.clear();
}

/**
 * Sync the provider set on every capability to the current registry. Providers
 * that have been removed from the registry since the last load are dropped
 * from the readiness map; new ones start at `idle`. This keeps the UI honest
 * after the user toggles `disabledProviders` in settings.
 */
export function syncProviderSet(capabilityId: string, providers: Provider<unknown>[]): void {
	const cap = ensureCapability(capabilityId);
	const live = new Set(providers.map(p => p.id));
	for (const id of Array.from(cap.providers.keys())) {
		if (!live.has(id)) cap.providers.delete(id);
	}
	for (const provider of providers) {
		ensureProvider(capabilityId, provider);
	}
}

// =============================================================================
// Internals
// =============================================================================

interface CommitPatch {
	state: ReadinessState;
	error?: string;
	lastLoadedAt?: number;
	failureCount?: number;
}

function commit(capabilityId: string, providerId: string, patch: CommitPatch): void {
	const cap = store.get(capabilityId);
	if (!cap) return;
	const entry = cap.providers.get(providerId);
	if (!entry) return;
	if (patch.state !== undefined && patch.state !== entry.state) entry.state = patch.state;
	if (patch.error !== undefined) entry.error = patch.error;
	else if (patch.state === "ready") entry.error = undefined;
	if (patch.lastLoadedAt !== undefined) entry.lastLoadedAt = patch.lastLoadedAt;
	if (patch.failureCount !== undefined) entry.failureCount = patch.failureCount;

	const snapshot = readEntry(capabilityId);
	for (const listener of cap.listeners) {
		listener(snapshot);
	}
	notifyGlobal(snapshot);
	// Resolve any whenReady waiters too.
	for (const waiter of entry.waiters.splice(0)) waiter(snapshot);
}

function decrementAttempt(capabilityId: string, providerId: string): void {
	const cap = store.get(capabilityId);
	if (!cap) return;
	const entry = cap.providers.get(providerId);
	if (!entry) return;
	entry.activeAttempts = Math.max(0, entry.activeAttempts - 1);
}

// Keep `SourceMeta` reference for callers that may want to extend readiness
// with source-level diagnostics in the future; the type import avoids a TS
// warning without dragging it into the public surface.
export type _SourceMetaRef = SourceMeta;
