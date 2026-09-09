/**
 * Plugin Credential Storage
 *
 * Encrypted-at-rest credential storage for plugin/MCP/Skill layer secrets.
 * Complements — does NOT replace — `pi-ai`'s `AuthStorage` (SQLite, used for
 * provider API keys & OAuth at the model gateway layer).
 *
 * Scope: anything a plugin may need that pi-ai's AuthStorage does not own:
 *   - MCP server OAuth/bearer tokens
 *   - Plugin-managed external service credentials (Notion, Slack, GitHub, etc.)
 *   - Per-workspace or per-account credential variants the plugin loader wires
 *
 * Format: AES-256-GCM (authenticated encryption) with key derived from a
 * stable OS-native machine identifier via PBKDF2-SHA256 (100k iterations).
 * File location: `$XDG_CONFIG_HOME/musepi/plugin-credentials.enc` (or
 * `~/.musepi/plugin-credentials.enc` outside XDG). File mode 0o600, dir 0o700.
 *
 * Backends (priority order, first available first):
 *   - secure-storage (100): encrypted file (default; always available on a
 *     writable filesystem, gracefully deletes a corrupt file rather than
 *     trapping users behind it).
 *   - env (50): read-only `MUSPI_PLUGIN_CRED_<PLUGIN_ID>_<NAME>=<value>`
 *     lookup for CI / containers where secrets must not touch the filesystem.
 *   - in-memory (10): transient fallback for tests / read-only mounts where
 *     the secure backend refuses to write. Honors writes within the process;
 *     lost on restart.
 */

export { EnvBackend } from "./backends/env-backend";
export { InMemoryBackend } from "./backends/in-memory";
export { getPluginCredentialManager, PluginCredentialManager, resetPluginCredentialManager } from "./backends/manager";
export { SecureStorageBackend } from "./backends/secure-storage";
export type { PluginCredentialBackend, PluginCredentialHealthStatus } from "./backends/types";
export type { PluginCredentialId, StoredPluginCredential } from "./types";
export { accountToPluginCredentialId, pluginCredentialIdToAccount } from "./types";
