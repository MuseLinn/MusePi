/**
 * Cordis primitives for plugins — `effect` and `state`.
 *
 * Both exist because of one fact: a plugin's module can be instantiated more
 * than once per process. The session loader, the `ext.call` compiler and the
 * cordis runtime each hold their own reference, so a module-level variable is
 * silently split into several values — a plugin that captured the session
 * context in one saw `null` through its own RPC. That bug is what this module
 * removes.
 *
 * ## `effect(cleanup, label?)`
 *
 * The `register*` verbs are already undone on unload, but a plugin that opens
 * something itself — a `setInterval`, a socket, a file watcher, an
 * `AbortController` — had no way to have it reclaimed. Those leaks survived
 * reload and accumulated: a plugin reloaded five times left four orphaned timers.
 *
 * The cleanup runs on unload, session shutdown and registration rollback, and a
 * throw inside it is isolated so one bad cleanup cannot stop the rest.
 *
 * ## `state`
 *
 * Fiber-scoped storage. Reads and writes are per-plugin-instance, so every face
 * of one plugin sees the same value (unlike a module variable, which is per
 * module copy), and the whole map is cleared when the plugin unloads (unlike a
 * module variable, which leaks into the next mount).
 *
 * Both are keyed by the `Extension` object, which the mount pipeline owns and
 * hands over — that is the join key between "the plugin's registrations" and
 * "the plugin's side effects".
 */

import type { Extension } from "../../extensions/types";

/** One registered cleanup, with the label used in diagnostics. */
interface EffectEntry {
	cleanup: () => void | Promise<void>;
	label: string;
}

/** Effects registered per plugin instance. */
const effectRegistry = new WeakMap<Extension, EffectEntry[]>();

/** Fiber-scoped state per plugin instance. */
const stateRegistry = new WeakMap<Extension, Map<string, unknown>>();

/**
 * Register a cleanup for ANY side effect.
 *
 * Safe to call at any time — during `apply` (the normal case) or later. Order is
 * preserved: cleanups run in reverse registration order, so a resource opened
 * after another is closed before it.
 */
export function registerEffect(extension: Extension, cleanup: () => void | Promise<void>, label = "anonymous"): void {
	let list = effectRegistry.get(extension);
	if (list === undefined) {
		list = [];
		effectRegistry.set(extension, list);
	}
	list.push({ cleanup, label });
}

/**
 * Run and clear every cleanup registered for a plugin.
 *
 * Called by the mount pipeline on unload / shutdown / rollback. Each cleanup is
 * isolated: a throw (or a rejection) is logged and the rest still run, because
 * one broken cleanup must not strand the others' resources.
 *
 * Returns how many ran, so a caller can tell "nothing to clean" from "cleaned".
 */
export async function runEffects(extension: Extension): Promise<number> {
	const list = effectRegistry.get(extension);
	if (list === undefined || list.length === 0) {
		stateRegistry.delete(extension);
		return 0;
	}
	// Reverse order: later registrations are typically the inner resources.
	const ordered = [...list].reverse();
	// Drop the effect list FIRST so a cleanup that itself registers an effect
	// does not get that effect run in the same pass (it would be a re-entrant
	// loop). State is cleared LAST, after every cleanup has run — a cleanup that
	// flushes what the plugin accumulated is the normal case, so the state must
	// still be readable while they execute.
	effectRegistry.delete(extension);
	let ran = 0;
	for (const entry of ordered) {
		try {
			await entry.cleanup();
			ran += 1;
		} catch (err) {
			// Isolated on purpose — see the doc above.
			console.warn(`[plugin] effect cleanup failed (${entry.label}):`, err);
		}
	}
	stateRegistry.delete(extension);
	return ran;
}

/** How many cleanups are pending for a plugin (diagnostics / tests). */
export function pendingEffectCount(extension: Extension): number {
	return effectRegistry.get(extension)?.length ?? 0;
}

/**
 * Read a value from the plugin's fiber-scoped state.
 *
 * Returns `undefined` for a key that was never set, which is also what an
 * explicitly-set `undefined` returns — use `has` when the difference matters.
 */
export function stateGet<T>(extension: Extension, key: string): T | undefined {
	return stateRegistry.get(extension)?.get(key) as T | undefined;
}

/** Write a value into the plugin's fiber-scoped state. */
export function stateSet<T>(extension: Extension, key: string, value: T): void {
	let map = stateRegistry.get(extension);
	if (map === undefined) {
		map = new Map();
		stateRegistry.set(extension, map);
	}
	map.set(key, value);
}

/** Whether a key is present in the plugin's state (distinguishes unset from `undefined`). */
export function stateHas(extension: Extension, key: string): boolean {
	return stateRegistry.get(extension)?.has(key) ?? false;
}

/** Remove one key. Returns whether it was present. */
export function stateDelete(extension: Extension, key: string): boolean {
	return stateRegistry.get(extension)?.delete(key) ?? false;
}

/**
 * Every key currently held (for diagnostics and for `state.keys()`).
 *
 * The returned array is a copy — mutating it does not affect the plugin's state.
 */
export function stateKeys(extension: Extension): string[] {
	return [...(stateRegistry.get(extension)?.keys() ?? [])];
}

/**
 * Run every cleanup and drop the state, for a plugin that is going away.
 *
 * This is the entry point the mount pipeline calls on unload. It is
 * `runEffects` plus the state clear, because both must go: a cleanup that
 * references state the plugin set is the normal case, so the state has to
 * outlive the cleanups — which `runEffects` already guarantees (it clears state
 * AFTER the cleanups run).
 */
export async function disposePluginPrimitives(extension: Extension): Promise<number> {
	return runEffects(extension);
}

/**
 * Drop a FAILED plugin's primitives.
 *
 * A plugin whose mount threw never registered cleanups (nothing ran past the
 * throw), but it may have written state before failing. That state is
 * meaningless now, so it goes without running anything.
 */
export function disposeFailedPluginPrimitives(extension: Extension): void {
	effectRegistry.delete(extension);
	stateRegistry.delete(extension);
}
