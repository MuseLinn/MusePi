import * as clientCore from "@musepi/client-core";
import * as clientCoreI18n from "@musepi/client-core/src/i18n";
import { EXTENSION_HOST_MODULES, type ExtensionHostModuleKey } from "@musepi/collab-proto/extension-host-modules";
import * as actionToast from "./action-toast";
import * as capabilityNav from "./capability-nav";
import * as fileWorkspace from "./file-workspace";
import * as managedBrowserHost from "./managed-browser-host";
import * as monacoLsp from "./monaco-lsp";
import * as monacoRuntime from "./monaco-runtime";
import * as panelMaximize from "./panel-maximize";
import * as promptDialog from "./prompt-dialog";
import * as scheduledTaskNav from "./scheduled-task-nav";
import * as suggestions from "./suggestions";
import * as tooltips from "./tooltips";
import * as updateUx from "./update-ux";
import * as useFloatingMenu from "./use-floating-menu";
import * as voice from "./voice";

/**
 * Instances a compiled plugin binds to through `window.MusePiHostModules`.
 *
 * Keys are the contract's `EXTENSION_HOST_MODULES` keys; the artifact compiler
 * rewrites each matching plugin import to this table, so plugin and shell share
 * one React context and one module-level store instead of a bundled copy.
 *
 * `i18n` is the same module instance `client-core` re-exports, so a plugin's
 * `setLocale` reaches the host's `t` — the shared locale state, not a copy.
 *
 * `slot-host` is absent here on purpose: it publishes this table, so importing
 * it would close a module cycle back through itself. It binds itself through
 * {@link registerHostModule} while its module evaluates.
 */
const hostModules = {
	"prompt-dialog": promptDialog,
	"managed-browser-host": managedBrowserHost,
	"action-toast": actionToast,
	"file-workspace": fileWorkspace,
	"floating-menu": useFloatingMenu,
	"update-ux": updateUx,
	tooltips: tooltips,
	"monaco-runtime": monacoRuntime,
	"monaco-lsp": monacoLsp,
	voice: voice,
	"panel-maximize": panelMaximize,
	suggestions: suggestions,
	"task-nav": scheduledTaskNav,
	"capability-nav": capabilityNav,
	"client-core": clientCore,
	i18n: clientCoreI18n,
} satisfies Omit<Record<ExtensionHostModuleKey, unknown>, "slot-host">;

/**
 * Bind one instance into the published table.
 *
 * The compiler throws for a key with no instance, so a module whose import
 * would be circular registers itself instead of appearing in the literal.
 */
export function registerHostModule(key: ExtensionHostModuleKey, value: unknown): void {
	(hostModules as Record<ExtensionHostModuleKey, unknown>)[key] = value;
}

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
	// Every key is bound by the time this runs: the shell imports `slot-host`,
	// which registers itself before calling this. Missing entries are a broken
	// supplier contract and must fail at publish, not at a later plugin import.
	const missing = EXTENSION_HOST_MODULES.filter(({ key }) => !(key in hostModules)).map(({ key }) => key);
	if (missing.length > 0) {
		throw new Error(`MusePiHostModules is missing ${missing.map(key => `"${key}"`).join(", ")}`);
	}
	target.MusePiHostModules = hostModules as Record<ExtensionHostModuleKey, unknown>;
	target.MusePiPromptDialog = hostModules["prompt-dialog"];
	target.MusePiManagedBrowserHost = hostModules["managed-browser-host"];
}
