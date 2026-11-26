/**
 * Versioned client-local storage with one-way migration from the pre-rename
 * `omp-*` keys.
 *
 * Keys follow `<namespace>.<area>.v1` (the same shape as `musepi.hosts.v1` and
 * `musepi.shortcut-bindings.v1`). A reader takes the current key first; when it
 * is absent it consults the legacy spellings, writes the value forward and
 * removes the old key, so a rename never loses a preference and never keeps
 * reading two places.
 */

/** Current key plus the spellings it superseded, newest first. */
export interface VersionedKey {
	readonly key: string;
	readonly legacy: readonly string[];
}

/**
 * Read a versioned key, migrating a legacy value forward on first sight.
 * @param spec - current key and its superseded spellings.
 * @returns the stored string, or null when neither key holds a value.
 */
export function readVersioned(spec: VersionedKey): string | null {
	try {
		const current = globalThis.localStorage.getItem(spec.key);
		if (current !== null) return current;
		for (const legacy of spec.legacy) {
			const value = globalThis.localStorage.getItem(legacy);
			if (value === null) continue;
			globalThis.localStorage.setItem(spec.key, value);
			for (const name of spec.legacy) globalThis.localStorage.removeItem(name);
			return value;
		}
		return null;
	} catch {
		// Private mode or blocked storage: behave as an empty store.
		return null;
	}
}

/**
 * Write a versioned key and drop any legacy spellings still lying around.
 * @param spec - current key and its superseded spellings.
 * @param value - value to store.
 */
export function writeVersioned(spec: VersionedKey, value: string): void {
	try {
		globalThis.localStorage.setItem(spec.key, value);
		for (const legacy of spec.legacy) globalThis.localStorage.removeItem(legacy);
	} catch {
		// Persistence is best-effort.
	}
}

/** Plan/normalize a scalar pref: reads through {@link readVersioned}. */
export function readVersionedOneOf<T extends string>(spec: VersionedKey, allowed: readonly T[]): T | null {
	const value = readVersioned(spec);
	return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}
