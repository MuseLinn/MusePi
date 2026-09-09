/**
 * Plugin Credential Backend Interface
 *
 * Mirrors craft-agents' `CredentialBackend` contract but trimmed to the
 * plugin-credential surface (no refresh tracking, no disable-cause — those
 * belong upstream in `pi-ai`'s AuthStorage).
 */

import type { PluginCredentialId, StoredPluginCredential } from "../types.ts";

export interface PluginCredentialBackend {
	/** Stable backend identifier (e.g. "secure-storage"). */
	readonly name: string;
	/** Selection weight: higher wins on tie. */
	readonly priority: number;

	/** Whether the backend can serve reads in the current environment. */
	isAvailable(): Promise<boolean>;

	/** Fetch one credential or null when absent. */
	get(id: PluginCredentialId): Promise<StoredPluginCredential | null>;

	/** Persist one credential, replacing any existing entry for `id`. */
	set(id: PluginCredentialId, credential: StoredPluginCredential): Promise<void>;

	/** Remove one credential. Returns true iff an entry was deleted. */
	delete(id: PluginCredentialId): Promise<boolean>;

	/** List stored credential IDs, optionally narrowed by partial match. */
	list(filter?: Partial<PluginCredentialId>): Promise<PluginCredentialId[]>;
}

/** Health status reported by {@link PluginCredentialManager.health}. */
export interface PluginCredentialHealthStatus {
	healthy: boolean;
	issues: PluginCredentialHealthIssue[];
}

export interface PluginCredentialHealthIssue {
	type: "file_corrupted" | "decryption_failed" | "backend_unavailable" | "no_backends";
	message: string;
	error?: string;
}
