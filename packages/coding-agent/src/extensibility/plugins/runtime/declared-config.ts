/**
 * The manifest-declared config one plugin package reads at runtime.
 *
 * Track A has one config identity: the package name (`pluginEntryId`), the same
 * key enablement and the management form write. A kind-prefixed row id belongs
 * to display, not storage — deriving `extension-module:<name>` here made the
 * form's write invisible to every reader, so a configured plugin silently ran
 * on its defaults.
 */
import { type ConfigFieldDesc, coerceConfigValues } from "@musepi/pi-wire";
import { pluginEntryId } from "../../../capability/plugin-identity";
import { getExtensionNameFromPath } from "../../../discovery/helpers";
import { readExtensionPluginMeta } from "../../extensions/plugin-manifest";
import { readPluginConfigStore } from "../../extensions-center/plugin-config-store";

/** A plugin package's declared config fields and their coerced values. */
export interface DeclaredPluginConfig {
	fields: ConfigFieldDesc[];
	values: Record<string, unknown>;
}

/** The plugin config store key for one entry path: its package identity. */
export function pluginConfigStoreKey(entryPath: string): string {
	return pluginEntryId(getExtensionNameFromPath(entryPath));
}

/** Read the declared fields with stored values coerced over their defaults. */
export async function readDeclaredPluginConfig(entryPath: string): Promise<DeclaredPluginConfig> {
	const [meta, store] = await Promise.all([readExtensionPluginMeta(entryPath), readPluginConfigStore()]);
	const fields = meta?.fields ?? [];
	return { fields, values: coerceConfigValues(fields, store[pluginConfigStoreKey(entryPath)]) };
}
