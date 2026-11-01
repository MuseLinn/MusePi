import type { PluginPackageEntry } from "../components/UnifiedPluginsView";
import type { RpcClient } from "./rpc";

export interface PluginManagementToggleResult {
	ok: boolean;
	enabled?: boolean;
	error?: string;
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
