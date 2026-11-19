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
	deleteSecret,
	type EncryptedStore,
	encryptedStore,
	hasSecret,
	mergeSecret,
	readSecret,
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
