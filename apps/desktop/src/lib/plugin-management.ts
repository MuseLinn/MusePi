import type { PluginPackageEntry } from "../components/UnifiedPluginsView";
import type { RpcClient } from "./rpc";

export interface PluginManagementToggleResult {
	ok: boolean;
	enabled?: boolean;
	error?: string;
}

/**
 * Read the installed plugin package list.
 *
 * `plugins.packages` answers `{ plugins }`, and its caller in this view read
 * `{ packages }` — so a refresh after an install or uninstall received
 * `undefined`, fell back to `[]`, and replaced a populated list with nothing.
 * The shape lives here so every reader shares one answer instead of each
 * spelling the envelope from memory.
 */
export async function readPluginPackages(rpc: RpcClient): Promise<PluginPackageEntry[]> {
	const res = await rpc.request<{ plugins?: PluginPackageEntry[] }>("plugins.packages", {});
	return res?.plugins ?? [];
}

/** Package and bundle cards use one gesture while each owner persists its own enablement. */
export async function setPluginManagementEnabled(
	rpc: RpcClient,
	row: Pick<PluginPackageEntry, "name" | "management">,
	enabled: boolean,
): Promise<PluginManagementToggleResult> {
	const method = row.management === "bundle" ? "bundles.setEnabled" : "plugins.setEnabled";
	return (await rpc.request(method, { name: row.name, enabled })) as PluginManagementToggleResult;
}
