/**
 * Encrypted connector secrets.
 *
 * Token connectors keep their values here, never in the catalog, state file, or
 * MCP config. The envelope, master key, derivation and atomic write live in
 * `../secrets/encrypted-store`; this module only fixes the connector directory
 * and keeps the public API connector callers already use.
 */

import * as path from "node:path";
import { getAgentDir } from "@musepi/pi-utils";
import {
	decryptMasterKey,
	deleteSecret,
	type EncryptedStore,
	encryptedStore,
	encryptMasterKey,
	hasSecret,
	type MasterKeyState,
	masterKeyState,
	mergeSecret,
	readSecret,
	rephraseMasterKey,
	unlockMasterKey,
} from "../secrets/encrypted-store";
import { CONNECTOR_DIR_NAME } from "./types";

const MASTER_KEY_FILE = ".master.key";
const SECRETS_FILE = "secrets.json";
const MASTER_KEY_ENV = "MUSEPI_CONNECTOR_MASTER_KEY";

export function connectorSecretsPath(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, CONNECTOR_DIR_NAME, SECRETS_FILE);
}

export function connectorMasterKeyPath(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, CONNECTOR_DIR_NAME, MASTER_KEY_FILE);
}

/**
 * The connector vault: `<agentDir>/connectors/secrets.json` plus the per-profile
 * master key beside it. Collab tunnel tokens share this master key under their
 * own `collab.*` id namespace.
 */
export function connectorSecretStore(agentDir: string = getAgentDir()): EncryptedStore {
	return encryptedStore(path.join(agentDir, CONNECTOR_DIR_NAME), {
		file: SECRETS_FILE,
		masterKeyFile: MASTER_KEY_FILE,
		masterKeyEnv: MASTER_KEY_ENV,
		// One passphrase covers connector tokens along with the vault and OAuth.
		sharedKeyAgentDir: agentDir,
	});
}

/** Decrypt one connector's values. Undefined means "no usable secret". */
export async function readConnectorSecrets(
	id: string,
	agentDir: string = getAgentDir(),
): Promise<Record<string, string> | undefined> {
	return readSecret(connectorSecretStore(agentDir), id);
}

/**
 * Merge new values into one connector's secret. Empty strings keep the stored
 * value, which is what the Token form sends for an already-configured password.
 */
export async function mergeConnectorSecrets(
	id: string,
	values: Record<string, string>,
	agentDir: string = getAgentDir(),
): Promise<void> {
	await mergeSecret(connectorSecretStore(agentDir), id, values);
}

/** Remove one connector's secret. */
export async function deleteConnectorSecrets(id: string, agentDir: string = getAgentDir()): Promise<void> {
	await deleteSecret(connectorSecretStore(agentDir), id);
}

/** Whether every required field already has a stored value. */
export async function hasConnectorSecrets(
	id: string,
	requiredKeys: readonly string[],
	agentDir: string = getAgentDir(),
): Promise<boolean> {
	return hasSecret(connectorSecretStore(agentDir), id, requiredKeys);
}

/**
 * How the connector master key is protected.
 *
 * The vault's passphrase settings drive this store too: one passphrase wraps
 * both keys, so a locked vault makes connector tokens unreadable rather than
 * leaving them on a plain key file the user believes is protected.
 */
export async function connectorKeyState(agentDir: string = getAgentDir()): Promise<MasterKeyState> {
	return masterKeyState(connectorSecretStore(agentDir));
}

/** True when a passphrase is required and this process has not unlocked it. */
export async function connectorKeyLocked(agentDir: string = getAgentDir()): Promise<boolean> {
	const state = await connectorKeyState(agentDir);
	return state.mode === "passphrase" && state.locked;
}

/**
 * Connector key passphrase operations.
 *
 * Connector tokens derive from the profile's shared master key, so these are
 * no-ops in the sense that matters: the vault already performed the operation
 * on the same key. They stay callable because a host may drive them directly,
 * and skipping keeps a second call from proving a passphrase the first just
 * replaced.
 */
async function connectorKeyIsShared(agentDir: string): Promise<boolean> {
	return connectorSecretStore(agentDir).sharedKeyAgentDir !== undefined;
}

/** Wrap the connector key under `passphrase`; already-wrapped is a no-op. */
export async function encryptConnectorKey(passphrase: string, agentDir: string = getAgentDir()): Promise<void> {
	if (await connectorKeyIsShared(agentDir)) return;
	const store = connectorSecretStore(agentDir);
	const state = await masterKeyState(store);
	if (state.mode === "passphrase") return;
	await encryptMasterKey(store, passphrase);
}

/** Restore the connector's plain key file after proving `passphrase`. */
export async function decryptConnectorKey(passphrase: string, agentDir: string = getAgentDir()): Promise<void> {
	if (await connectorKeyIsShared(agentDir)) return;
	const store = connectorSecretStore(agentDir);
	const state = await masterKeyState(store);
	if (state.mode !== "passphrase") return;
	await decryptMasterKey(store, passphrase);
}

/** Unlock the connector store for this process; nothing is written. */
export async function unlockConnectorKey(passphrase: string, agentDir: string = getAgentDir()): Promise<void> {
	if (await connectorKeyIsShared(agentDir)) return;
	const store = connectorSecretStore(agentDir);
	const state = await masterKeyState(store);
	if (state.mode !== "passphrase") return;
	await unlockMasterKey(store, passphrase);
}

/** Replace the passphrase that wraps the connector key. */
export async function rephraseConnectorKey(
	current: string,
	next: string,
	agentDir: string = getAgentDir(),
): Promise<void> {
	if (await connectorKeyIsShared(agentDir)) return;
	const store = connectorSecretStore(agentDir);
	const state = await masterKeyState(store);
	if (state.mode !== "passphrase") return;
	await rephraseMasterKey(store, current, next);
}
