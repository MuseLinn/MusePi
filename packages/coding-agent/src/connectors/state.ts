/**
 * Connector enablement state.
 *
 * One versioned JSON file per active state home. It records only what the user
 * decided (`enabled`) and when the catalog last connected it; live connection
 * health stays in the MCP manager, which is the only authority that can observe
 * it. Keeping the two apart prevents a stale `connected` flag from outliving a
 * dead socket.
 *
 * The file is written atomically with owner-only permissions because later
 * connector modes persist credentials beside this state.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, isEnoent, logger } from "@musepi/pi-utils";
import { writeFileAtomically } from "../utils/atomic-file";
import { CONNECTOR_DIR_NAME, CONNECTOR_STATE_FILE, type ConnectorStateEntry, type ConnectorStateFile } from "./types";

/** Serialize read-modify-write cycles per state file. */
const stateLocks = new Map<string, Promise<unknown>>();

/** Absolute path of the connector state file. */
export function connectorStatePath(agentDir: string = getAgentDir()): string {
	return path.join(agentDir, CONNECTOR_DIR_NAME, CONNECTOR_STATE_FILE);
}

function emptyState(): ConnectorStateFile {
	return { version: 1, connectors: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseState(raw: unknown, filePath: string): ConnectorStateFile {
	if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.connectors)) {
		logger.warn("Connector state has an unsupported shape; starting empty", { path: filePath });
		return emptyState();
	}
	const connectors: Record<string, ConnectorStateEntry> = {};
	for (const [id, value] of Object.entries(raw.connectors)) {
		if (!isRecord(value) || typeof value.enabled !== "boolean") {
			logger.warn("Connector state entry is invalid; skipping", { path: filePath, id });
			continue;
		}
		const entry: ConnectorStateEntry = { enabled: value.enabled };
		if (typeof value.connectedAt === "number" && Number.isFinite(value.connectedAt)) {
			entry.connectedAt = value.connectedAt;
		}
		if (typeof value.approvedCommand === "string" && value.approvedCommand.length > 0) {
			entry.approvedCommand = value.approvedCommand;
		}
		if (typeof value.approvedCli === "string" && value.approvedCli.length > 0) {
			entry.approvedCli = value.approvedCli;
		}
		connectors[id] = entry;
	}
	return { version: 1, connectors };
}

/** Read state. A missing file means "nothing enabled", not an error. */
export async function readConnectorState(agentDir: string = getAgentDir()): Promise<ConnectorStateFile> {
	const filePath = connectorStatePath(agentDir);
	let text: string;
	try {
		text = await fs.promises.readFile(filePath, "utf8");
	} catch (error) {
		if (isEnoent(error)) return emptyState();
		logger.warn("Connector state could not be read; starting empty", {
			path: filePath,
			error: error instanceof Error ? error.message : String(error),
		});
		return emptyState();
	}
	try {
		return parseState(JSON.parse(text), filePath);
	} catch (error) {
		logger.warn("Connector state is not valid JSON; starting empty", {
			path: filePath,
			error: error instanceof Error ? error.message : String(error),
		});
		return emptyState();
	}
}

/** Replace the whole state file atomically. */
export async function writeConnectorState(state: ConnectorStateFile, agentDir: string = getAgentDir()): Promise<void> {
	const filePath = connectorStatePath(agentDir);
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	await writeFileAtomically(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function withStateLock<T>(filePath: string, action: () => Promise<T>): Promise<T> {
	const previous = stateLocks.get(filePath) ?? Promise.resolve();
	const run = previous.then(action, action);
	stateLocks.set(
		filePath,
		run.then(
			() => undefined,
			() => undefined,
		),
	);
	try {
		return await run;
	} finally {
		if (stateLocks.get(filePath) === run) stateLocks.delete(filePath);
	}
}

/**
 * Enable or disable one connector.
 *
 * Read-modify-write is serialized per file so two daemon calls cannot drop each
 * other's entry. Returns the state after the write.
 */
export async function setConnectorEnabled(
	id: string,
	enabled: boolean,
	agentDir: string = getAgentDir(),
	options: { approvedCommand?: string; approvedCli?: string } = {},
): Promise<ConnectorStateFile> {
	const filePath = connectorStatePath(agentDir);
	return withStateLock(filePath, async () => {
		const state = await readConnectorState(agentDir);
		const previous = state.connectors[id];
		state.connectors[id] = {
			enabled,
			...(enabled
				? { connectedAt: Date.now() }
				: previous?.connectedAt !== undefined
					? { connectedAt: previous.connectedAt }
					: {}),
			// Disabling forgets the process approval; re-enabling a stdio
			// connector must ask again, and a changed command invalidates it.
			...(enabled && options.approvedCommand ? { approvedCommand: options.approvedCommand } : {}),
			...(enabled && options.approvedCli ? { approvedCli: options.approvedCli } : {}),
		};
		await writeConnectorState(state, agentDir);
		return state;
	});
}

/** Forget one connector entirely (disconnect + remove its remembered state). */
export async function removeConnectorState(id: string, agentDir: string = getAgentDir()): Promise<ConnectorStateFile> {
	const filePath = connectorStatePath(agentDir);
	return withStateLock(filePath, async () => {
		const state = await readConnectorState(agentDir);
		delete state.connectors[id];
		await writeConnectorState(state, agentDir);
		return state;
	});
}
