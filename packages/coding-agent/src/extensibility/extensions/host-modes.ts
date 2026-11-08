/**
 * Host-level registry of agent presets contributed by extensions.
 *
 * dsh's agent presets are host plugins: once registered, they are listable
 * without an agent. MusePi's `registerMode` is an extension API, so the modes
 * only exist after a factory ran; this registry records them whenever any mount
 * happens (daemon preload, session load, dynamic load) and forgets them when
 * the instance is disposed. That is what lets `agentPresets.list/read` answer
 * before the first session exists.
 */
import type { Extension, ExtensionModeDefinition } from "./types";

export interface HostExtensionMode {
	/** Entry path of the extension that declared the mode. */
	extensionId: string;
	mode: ExtensionModeDefinition;
}

const modes = new Map<string, HostExtensionMode>();

function keyOf(extensionId: string, modeId: string): string {
	return `${extensionId}\u0000${modeId}`;
}

/** Record every mode the given extensions declared. Idempotent per (entry, mode). */
export function recordHostExtensionModes(extensions: readonly Extension[]): void {
	for (const extension of extensions) {
		for (const mode of extension.modes) {
			modes.set(keyOf(extension.resolvedPath, mode.id), { extensionId: extension.resolvedPath, mode });
		}
	}
}

/** Every registered extension mode; a disposed instance's entries are gone. */
export function listHostExtensionModes(): HostExtensionMode[] {
	return [...modes.values()];
}

/** Forget one extension instance's modes (unload, reload, failed mount rollback). */
export function removeHostExtensionModes(extensionId: string): void {
	const prefix = `${extensionId}\u0000`;
	for (const key of [...modes.keys()]) {
		if (key.startsWith(prefix)) modes.delete(key);
	}
}
