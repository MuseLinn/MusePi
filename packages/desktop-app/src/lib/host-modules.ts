import * as clientCore from "@musepi/client-core";
import * as clientCoreI18n from "@musepi/client-core/src/i18n";
import type { ExtensionHostModuleKey } from "@musepi/collab-proto/extension-host-modules";
import * as actionToast from "./action-toast";
import * as fileWorkspace from "./file-workspace";
import * as managedBrowserHost from "./managed-browser-host";
import * as promptDialog from "./prompt-dialog";
import * as tooltips from "./tooltips";
import * as updateUx from "./update-ux";
import * as useFloatingMenu from "./use-floating-menu";

/**
 * Instances a compiled plugin binds to through `window.MusePiHostModules`.
 *
 * Keys are the contract's `EXTENSION_HOST_MODULES` keys; the artifact compiler
 * rewrites each matching plugin import to this table, so plugin and shell share
 * one React context and one module-level store instead of a bundled copy.
 *
 * `i18n` is the same module instance `client-core` re-exports, so a plugin's
 * `setLocale` reaches the host's `t` — the shared locale state, not a copy.
 */
const hostModules = {
	"prompt-dialog": promptDialog,
	"managed-browser-host": managedBrowserHost,
	"action-toast": actionToast,
	"file-workspace": fileWorkspace,
	"floating-menu": useFloatingMenu,
	"update-ux": updateUx,
	tooltips: tooltips,
	"client-core": clientCore,
	i18n: clientCoreI18n,
} satisfies Record<ExtensionHostModuleKey, unknown>;

/**
 * Publish the table for compiled plugins. The two pre-table globals stay
 * aliases of the same namespace objects so already-compiled bundles keep
 * reading the host's context rather than a copy.
 */
export function exposeHostModules(): void {
	if (typeof window === "undefined") return;
	const target = window as unknown as {
		MusePiHostModules: Record<ExtensionHostModuleKey, unknown>;
		MusePiPromptDialog: unknown;
		MusePiManagedBrowserHost: unknown;
	};
	target.MusePiHostModules = hostModules;
	target.MusePiPromptDialog = hostModules["prompt-dialog"];
	target.MusePiManagedBrowserHost = hostModules["managed-browser-host"];
}
