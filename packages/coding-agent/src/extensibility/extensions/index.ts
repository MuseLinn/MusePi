/**
 * Extension system for lifecycle events and custom tools.
 */

export {
	loadPluginFromFactory,
	loadPluginFromFactory as loadExtensionFromFactory,
	PluginRuntimeNotInitializedError,
	PluginRuntimeNotInitializedError as ExtensionRuntimeNotInitializedError,
	pluginHostOwner,
	pluginHostOwner as extensionHostOwner,
} from "../plugin-runtime/plugin-api";
export type { SlashCommandInfo, SlashCommandLocation, SlashCommandSource } from "../slash-commands";
export { discoverAndLoadExtensions, discoverExtensionPaths, loadExtensions } from "./loader";
export * from "./runner";
// Type guards
export * from "./types";
export * from "./wrapper";
