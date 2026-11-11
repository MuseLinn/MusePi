/**
 * Host Plugin Capability
 *
 * Distribution-shipped packages whose manifest declares
 * `musepi.scope: "host"`. They mount once per host process on the cordis host
 * runtime (`extensibility/plugins/runtime/host-runtime.ts`), never per session.
 *
 * This is a separate capability rather than a flag on `extension-modules`
 * because that capability is the session loader's candidate list: anything
 * listed there is executed by `discoverExtensionPaths` and mounted into every
 * session. A host package would then register its process-wide facts once per
 * session, which the registry refuses. Listing surfaces read this capability
 * too, so "what ships" and "what mounts per session" stop sharing one list.
 */
import { defineCapability } from ".";
import type { ExtensionModule } from "./extension-module";
import { moduleEntryId, PLUGIN_MODULE_KIND } from "./module-entry";

export const hostPluginCapability = defineCapability<ExtensionModule>({
	id: "host-plugins",
	displayName: "Host Plugins",
	description: "Distribution-shipped plugins mounted once per host process",
	hidden: true,
	key: plugin => plugin.name,
	toExtensionId: plugin => moduleEntryId(plugin.name),
	validate: plugin => {
		if (!plugin.name) return "Missing name";
		if (!plugin.path) return "Missing path";
		if (plugin.track !== PLUGIN_MODULE_KIND) return `Unknown track: ${String(plugin.track)}`;
		return undefined;
	},
});
