/** MusePi plugin packages use their package name as their only enablement identity. */
export type PluginEntryId = string;

/** Return the canonical enablement key for a plugin package. */
export function pluginEntryId(name: string): PluginEntryId {
	return name;
}

/** Return a bare package name, or undefined for another capability's composite ID. */
export function pluginNameOfEntryId(id: string): string | undefined {
	return id.includes(":") ? undefined : id;
}

/** Test whether a package name occurs in the disabled-package list. */
export function isPluginDisabled(disabledEntries: Iterable<string>, name: string): boolean {
	for (const entry of disabledEntries) {
		if (entry === name) return true;
	}
	return false;
}

/** Return the disabled-package list with exactly the requested package state changed. */
export function setPluginEnabledIn(entries: readonly string[], name: string, enabled: boolean): string[] {
	const out = entries.filter(id => id !== name);
	if (!enabled) out.push(name);
	return out;
}
