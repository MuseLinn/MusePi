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
	const stored = store[pluginConfigStoreKey(entryPath)] ?? {};
	// A Config-only package has no manifest field table to coerce against; the
	// schema is the authority, so raw stored values reach it unchanged.
	return { fields, values: fields.length > 0 ? coerceConfigValues(fields, stored) : stored };
}

/** A Standard Schema V1 validator (`Config["~standard"].validate`). */
interface StandardSchemaLike {
	"~standard"?: {
		validate?: (value: unknown) => unknown;
	};
}

interface StandardSchemaResult {
	value?: unknown;
	issues?: readonly { message?: unknown }[];
}

/**
 * Validate a plugin's effective config through its exported `Config` schema
 * and return the schema's output (defaults and transformations applied).
 *
 * `Config` is the dsh contract: a Standard Schema exported by the plugin. A
 * `Config` that is not a Standard Schema is rejected rather than ignored —
 * silently skipping validation is how a plugin runs on values its author
 * never agreed to.
 */
export async function validateDeclaredPluginConfig(
	entry: unknown,
	values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const schema = (entry as { Config?: unknown } | null)?.Config;
	if (schema === undefined || schema === null) return values;
	const validate = (schema as StandardSchemaLike)["~standard"]?.validate;
	if (typeof validate !== "function") {
		throw new Error("Config must implement Standard Schema (`~standard.validate`)");
	}
	const result = (await validate(values)) as StandardSchemaResult | undefined;
	if (result === undefined || result === null || typeof result !== "object") return values;
	if (Array.isArray(result.issues) && result.issues.length > 0) {
		const messages = result.issues.map(issue => (typeof issue?.message === "string" ? issue.message : String(issue)));
		throw new Error(messages.join("; ") || "config does not satisfy the plugin's Config schema");
	}
	return (result.value ?? values) as Record<string, unknown>;
}
