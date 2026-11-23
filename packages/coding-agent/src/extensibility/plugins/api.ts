/**
 * The context a Track A (Cordis plugin) entry receives — `apply(ctx: PluginAPI)`.
 *
 * This is the plugin-facing surface: the `ctx.*` namespaces (`tools`,
 * `commands`, `settings`, `prompts`, `slots`, `rpc`, `subagents`,
 * `magicKeywords`, `memory`, `hmr`), the fiber-scoped `effect`, `on`, `state`
 * and `service`, plus the host fields a package reads (`cwd`, `logger`,
 * `sessionManager`, …).
 *
 * Config is NOT a runtime read here. A Track A entry receives its declared
 * config as the second `apply` argument, exactly as dsh hands a plugin its
 * `Config`: `apply(ctx: PluginAPI, config?: Record<string, unknown>)`. The
 * legacy `pi.config` reader stays on `ExtensionAPI` (Track B), which has no
 * second argument to receive it.
 *
 * Track B compatibility extensions receive {@link ExtensionAPI}, which adds the
 * flat `pi.register*` aliases and the session-action methods they were written
 * against. A first-party package declares `PluginAPI`; only code that must keep
 * an old `export default (pi)` extension working names `ExtensionAPI`.
 *
 * Why not `Context`: that name already belongs to `@deepseek-ai/cordis` (the
 * real Cordis plugin context this host mounts fibers with) and to
 * `@musepi/pi-ai` (an LLM request's message list), plus a few local types. A
 * plugin-facing alias cannot take it without shadowing those.
 */
import type { ExtensionAPI } from "../extensions/types";

export type PluginAPI = Omit<
	ExtensionAPI,
	| "sendMessage"
	| "sendUserMessage"
	| "appendEntry"
	| "exec"
	| "getActiveTools"
	| "getAllTools"
	| "setActiveTools"
	| "getCommands"
	| "setModel"
	| "config"
>;
