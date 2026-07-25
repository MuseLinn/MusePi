/**
 * Auth-broker configuration discovery.
 *
 * Resolution chain (first wins):
 * 1. Environment variables: `MUSEPI_AUTH_BROKER_URL` and `MUSEPI_AUTH_BROKER_TOKEN`
 * 2. Config file `<agentDir>/config.yml` → `auth.broker.url` / `auth.broker.token`
 * 3. Token file `<configRoot>/auth-broker.token`
 *
 * Returns `null` when no URL is configured — caller falls through to local store.
 * Throws when a URL is found but no token is available.
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

export interface AuthBrokerConfig {
	url: string;
	token: string;
}

export type ConfigValueResolver = (key: string) => string | undefined;

/**
 * Resolve the broker URL and bearer token from the environment, config file,
 * or token file. Returns null when no broker URL is configured.
 */
export function resolveAuthBrokerConfig(
	resolveConfigValue?: ConfigValueResolver,
	configDir?: string,
	configRootDir?: string,
): AuthBrokerConfig | null {
	// 1. Environment variables
	const envUrl = process.env.MUSEPI_AUTH_BROKER_URL || process.env.OMP_AUTH_BROKER_URL;
	const envToken = process.env.MUSEPI_AUTH_BROKER_TOKEN || process.env.OMP_AUTH_BROKER_TOKEN;

	if (envUrl && envToken) {
		return { url: envUrl, token: envToken };
	}

	// 2. Config file
	const agentDir = configDir ?? process.env.MUSEPI_AGENT_DIR ?? "";
	const configUrls = tryReadConfigFile(agentDir, envUrl, resolveConfigValue);

	if (configUrls) {
		const token = configUrls.token ?? envToken ?? tryReadTokenFile(configRootDir);
		if (!token && configUrls.url) {
			throw new Error(
				`Auth-broker URL (${configUrls.url}) configured but no bearer token found. ` +
					"Set MUSEPI_AUTH_BROKER_TOKEN or create auth-broker.token file.",
			);
		}
		if (configUrls.url && token) {
			return { url: configUrls.url, token };
		}
		if (configUrls.url && !token) {
			return null; // URL configured but no token — caller handles
		}
	}

	// 3. URL from env without token
	if (envUrl) {
		const token = envToken ?? tryReadTokenFile(configRootDir);
		if (!token) {
			throw new Error(
				`Auth-broker URL (${envUrl}) set but no bearer token found. ` +
					"Set MUSEPI_AUTH_BROKER_TOKEN or create auth-broker.token file.",
			);
		}
		return { url: envUrl, token };
	}

	return null;
}

function tryReadConfigFile(
	agentDir: string,
	_existingUrl: string | undefined,
	_resolveConfigValue?: ConfigValueResolver,
): { url?: string; token?: string } | null {
	const candidates = ["config.yml", "config.yaml"];
	for (const name of candidates) {
		const configPath = path.join(agentDir, name);
		if (!existsSync(configPath)) continue;

		try {
			const raw = readFileSync(configPath, "utf-8");
			const config = parseYamlSimple(raw);
			const url = _existingUrl ?? readDotted(config, "auth.broker.url");
			const token = readDotted(config, "auth.broker.token");

			return {
				url: url ? String(url) : undefined,
				token: token ? String(token) : undefined,
			};
		} catch {}
	}
	return null;
}

function tryReadTokenFile(configRootDir?: string): string | null {
	const root = configRootDir ?? process.env.MUSEPI_CONFIG_ROOT ?? "";
	if (!root) return null;
	const tokenPath = path.join(root, "auth-broker.token");
	try {
		return readFileSync(tokenPath, "utf-8").trim();
	} catch {
		return null;
	}
}

function readDotted(obj: Record<string, unknown>, key: string): unknown {
	const parts = key.split(".");
	let current: unknown = obj;
	for (const part of parts) {
		if (current === null || current === undefined || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

/**
 * Minimal YAML parser for simple key-value config files.
 * Only supports flat and one-level nested keys.
 */
function parseYamlSimple(raw: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	let currentKey = "";

	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;

		// Nested key (2-space indent: `auth:` / `  broker:`)
		const indent = line.search(/\S/);
		if (indent > 0 && currentKey) {
			const [k, ...vParts] = trimmed.includes(": ")
				? [trimmed.slice(0, trimmed.indexOf(": ")), trimmed.slice(trimmed.indexOf(": ") + 2)]
				: [trimmed.endsWith(":") ? trimmed.slice(0, -1) : trimmed, ""];
			if (k) {
				const fullKey = `${currentKey}.${k}`;
				result[fullKey] = vParts.join(": ").replace(/^["']|["']$/g, "");
			}
			continue;
		}

		// Top-level key
		if (trimmed.includes(": ")) {
			const colon = trimmed.indexOf(": ");
			const k = trimmed.slice(0, colon);
			const v = trimmed.slice(colon + 2).replace(/^["']|["']$/g, "");
			result[k] = v;
		} else if (trimmed.endsWith(":")) {
			currentKey = trimmed.slice(0, -1);
		}
	}

	return result;
}
