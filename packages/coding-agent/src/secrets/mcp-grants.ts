/**
 * Per-server permission for `mcp.json` to read vault entries.
 *
 * A config file asks for a value with `${vault:NAME}`; that is a request, not
 * a permission. The permission is user state, recorded as
 * (server, endpoint fingerprint) → allowed names. Binding it to the endpoint
 * is what keeps a workspace `.mcp.json` from reusing a grant by declaring a
 * same-named server that points somewhere else: a changed URL, command or
 * argument makes the stored grant inapplicable until the user grants again.
 *
 * The file is a 0600 sidecar next to the vault; it holds names and endpoints,
 * never a value.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isEnoent, logger } from "@musepi/pi-utils";
import type { McpGrantView } from "@musepi/pi-wire";
import { writeFileAtomically } from "../utils/atomic-file";
import { AGENT_SECRET_DIR, AGENT_SECRET_NAME_RE } from "./agent-store";

const GRANTS_FILE = "mcp-grants.json";
const GRANTS_VERSION = 1;
const MAX_TARGET_LENGTH = 4096;
const MAX_KEYS_PER_SERVER = 512;
const SERVER_NAME_RE = /^[^\u0000-\u001f\u007f]{1,200}$/u;

interface GrantsFile {
	version: 1;
	servers: Record<string, { target: string; keys: string[] }>;
}

const writes = new Map<string, Promise<unknown>>();

async function withWriteLock<T>(file: string, action: () => Promise<T>): Promise<T> {
	const previous = writes.get(file) ?? Promise.resolve();
	const run = previous.then(action, action);
	writes.set(
		file,
		run.then(
			() => undefined,
			() => undefined,
		),
	);
	try {
		return await run;
	} finally {
		if (writes.get(file) === run) writes.delete(file);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function grantsPath(agentDir: string): string {
	return path.join(agentDir, AGENT_SECRET_DIR, GRANTS_FILE);
}

export function validateMcpServerName(name: unknown): string {
	if (typeof name !== "string" || !SERVER_NAME_RE.test(name)) {
		throw new Error("Invalid MCP server name");
	}
	return name;
}

/**
 * A stable fingerprint of where a server connects. Arguments are compared as
 * an array, so `a b` and `a`,`b` cannot produce the same target by accident.
 */
export function mcpServerTarget(config: {
	type?: string;
	url?: string;
	command?: string;
	args?: readonly string[];
}): string {
	if (typeof config.url === "string" && config.url.trim() !== "") {
		return `url:${config.url.trim()}`;
	}
	const argv = [config.command ?? "", ...(config.args ?? [])];
	return `stdio:${JSON.stringify(argv)}`;
}

function parseGrants(text: string): GrantsFile {
	const raw: unknown = JSON.parse(text);
	if (!isRecord(raw) || raw.version !== GRANTS_VERSION || !isRecord(raw.servers)) {
		logger.warn("MCP grant file has an unsupported shape; ignoring it");
		return { version: GRANTS_VERSION, servers: {} };
	}
	const servers: GrantsFile["servers"] = {};
	for (const [server, grant] of Object.entries(raw.servers)) {
		if (!SERVER_NAME_RE.test(server) || !isRecord(grant)) continue;
		if (typeof grant.target !== "string" || !Array.isArray(grant.keys)) continue;
		const keys = grant.keys.filter((key): key is string => typeof key === "string" && AGENT_SECRET_NAME_RE.test(key));
		servers[server] = {
			target: grant.target.slice(0, MAX_TARGET_LENGTH),
			keys: [...new Set(keys)].slice(0, MAX_KEYS_PER_SERVER),
		};
	}
	return { version: GRANTS_VERSION, servers };
}

async function readGrants(agentDir: string): Promise<GrantsFile> {
	let text: string;
	try {
		text = await fs.promises.readFile(grantsPath(agentDir), "utf8");
	} catch (error) {
		if (isEnoent(error)) return { version: GRANTS_VERSION, servers: {} };
		throw error;
	}
	try {
		return parseGrants(text);
	} catch (error) {
		logger.warn("MCP grant file is not valid JSON", {
			error: error instanceof Error ? error.message : String(error),
		});
		return { version: GRANTS_VERSION, servers: {} };
	}
}

async function writeGrants(agentDir: string, file: GrantsFile): Promise<void> {
	const target = grantsPath(agentDir);
	await fs.promises.mkdir(path.dirname(target), { recursive: true });
	await writeFileAtomically(target, `${JSON.stringify(file, null, 2)}\n`, 0o600);
}

/** Names this exact endpoint may read. A changed target yields an empty list. */
export async function mcpGrantedKeys(agentDir: string, server: string, target: string): Promise<string[]> {
	const grant = (await readGrants(agentDir)).servers[server];
	if (!grant || grant.target !== target) return [];
	return grant.keys;
}

/** Every recorded grant, for the vault page. */
export async function listMcpGrants(agentDir: string): Promise<McpGrantView[]> {
	const file = await readGrants(agentDir);
	return Object.entries(file.servers)
		.map(([server, grant]) => ({ server, target: grant.target, keys: grant.keys }))
		.sort((a, b) => a.server.localeCompare(b.server));
}

/** Replace one server's key list; an empty list removes the grant entirely. */
export async function setMcpGrant(
	agentDir: string,
	server: string,
	target: string,
	keys: readonly unknown[],
): Promise<void> {
	const name = validateMcpServerName(server);
	if (typeof target !== "string" || target.trim() === "" || target.length > MAX_TARGET_LENGTH) {
		throw new Error("Invalid MCP server endpoint");
	}
	const cleaned: string[] = [];
	for (const key of keys) {
		if (typeof key !== "string" || !AGENT_SECRET_NAME_RE.test(key)) {
			throw new Error(`Invalid secret name in an MCP grant: ${String(key)}`);
		}
		if (!cleaned.includes(key)) cleaned.push(key);
		if (cleaned.length > MAX_KEYS_PER_SERVER) throw new Error("Too many keys in one MCP grant");
	}
	await withWriteLock(grantsPath(agentDir), async () => {
		const file = await readGrants(agentDir);
		if (cleaned.length === 0) delete file.servers[name];
		else file.servers[name] = { target, keys: cleaned };
		await writeGrants(agentDir, file);
	});
}

/**
 * Drop a server's grant after it was removed from the configuration. A grant
 * for a server that no longer exists can never be used, and keeping it would
 * only let a future same-named entry inherit it silently.
 */
export async function forgetMcpGrants(agentDir: string, server: string): Promise<void> {
	const name = validateMcpServerName(server);
	const filePath = grantsPath(agentDir);
	await withWriteLock(filePath, async () => {
		const file = await readGrants(agentDir);
		if (!(name in file.servers)) return;
		delete file.servers[name];
		await writeGrants(agentDir, file);
	});
}
