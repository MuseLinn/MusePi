/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 *
 * Note: command execution is async to avoid blocking the TUI.
 */

import { executeShell } from "@musepi/pi-natives";
import { $envExact, logger } from "@musepi/pi-utils";
import { getAgentDir } from "@musepi/pi-utils/dirs";
import { getAgentSecretStore, secretScopeIncludes } from "../secrets/agent-store";

/** The whole value must be the reference; partial substitution would be ambiguous. */
const VAULT_REFERENCE = /^\$\{vault:([A-Z][A-Z0-9_]{0,63})\}$/u;

/** Cache for successful shell command results (persists for process lifetime). */
const commandResultCache = new Map<string, string>();

/** De-duplicates concurrent executions for the same command. */
const commandInFlight = new Map<string, Promise<string | undefined>>();

export interface ResolveConfigValueOptions {
	/** The workspace the config belongs to, for a scoped vault entry. */
	cwd?: string;
	/**
	 * Names a `${vault:…}` reference may read. Absent allows any stored entry
	 * (provider keys and other non-MCP callers); present restricts to exactly
	 * these names, so an MCP server only receives what the user granted it.
	 */
	vaultAllow?: readonly string[];
}

/**
 * Resolve a config value (API key, header value, etc.) to an actual value.
 * - `${vault:NAME}` reads the agent secret store; the config file never holds the value
 * - If starts with "!", executes the rest as a shell command and uses stdout (cached)
 * - Otherwise checks environment variable first, then treats as literal (not cached)
 */
export async function resolveConfigValue(
	config: string,
	options: ResolveConfigValueOptions = {},
): Promise<string | undefined> {
	const vault = VAULT_REFERENCE.exec(config);
	if (vault) {
		if (options.vaultAllow !== undefined && !options.vaultAllow.includes(vault[1]!)) {
			// A dropped header is the visible half of a refused grant; the value
			// never leaves the store, so the server simply starts without it.
			logger.warn("Vault reference is not granted to this consumer", { name: vault[1] });
			return undefined;
		}
		return await readVaultValue(vault[1]!, options.cwd);
	}
	if (config.startsWith("!")) {
		return await executeCommand(config);
	}
	const envValue = $envExact(config);
	return envValue || config;
}

/** A scoped entry is readable only from its own workspace; no workspace means only `all`. */
async function readVaultValue(name: string, cwd: string | undefined): Promise<string | undefined> {
	const store = getAgentSecretStore(getAgentDir());
	const entry = await store.getEntry(name);
	if (entry === undefined) return undefined;
	if (entry.scope !== "all" && (cwd === undefined || !secretScopeIncludes(entry.scope, cwd))) return undefined;
	return await store.getValue(name);
}

async function executeCommand(commandConfig: string): Promise<string | undefined> {
	const cached = commandResultCache.get(commandConfig);
	if (cached !== undefined) {
		return cached;
	}

	const existing = commandInFlight.get(commandConfig);
	if (existing) {
		return await existing;
	}

	const command = commandConfig.slice(1);
	const promise = runShellCommand(command, 10_000)
		.then(result => {
			if (result !== undefined) {
				commandResultCache.set(commandConfig, result);
			}
			return result;
		})
		.finally(() => {
			commandInFlight.delete(commandConfig);
		});

	commandInFlight.set(commandConfig, promise);
	return await promise;
}

async function runShellCommand(command: string, timeoutMs: number): Promise<string | undefined> {
	try {
		let output = "";
		const result = await executeShell({ command, timeoutMs }, (err, chunk) => {
			if (!err) {
				output += chunk;
			}
		});
		if (result.timedOut || result.exitCode !== 0) {
			return undefined;
		}
		const trimmed = output.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export async function resolveHeaders(
	headers: Record<string, string> | undefined,
	options: ResolveConfigValueOptions = {},
): Promise<Record<string, string> | undefined> {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const resolvedValue = await resolveConfigValue(value, options);
		if (resolvedValue) {
			resolved[key] = resolvedValue;
		}
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** Clear the config value command cache. Exported for testing. */
export function clearConfigValueCache(): void {
	commandResultCache.clear();
	commandInFlight.clear();
}
