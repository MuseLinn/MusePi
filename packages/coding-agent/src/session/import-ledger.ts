import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, isEnoent, logger } from "@musepi/pi-utils";

const LEDGER_FILENAME = "imported-sessions.json";

/** One successful foreign-session copy. */
export interface ImportedSessionRecord {
	source: string;
	/** Id in the foreign store (stable for that source). */
	sourceId: string;
	/** New MusePi session id created by the copy. */
	sessionId: string;
	/** New MusePi session file; its absence means the copy was deleted. */
	sessionFile: string;
	importedAt: number;
}

/** Ledger keyed by `source\0sourceId`; the source namespace keeps ids apart. */
export type ImportLedger = Record<string, ImportedSessionRecord>;

export function importLedgerKey(source: string, sourceId: string): string {
	return `${source}\u0000${sourceId}`;
}

/**
 * Read the import ledger.
 *
 * Missing or corrupt files degrade to an empty ledger: a broken bookkeeping
 * file must never block an import or make the picker fail. Callers still
 * validate the recorded session file before treating an entry as imported.
 */
export async function loadImportLedger(agentDir: string = getAgentDir()): Promise<ImportLedger> {
	try {
		const raw: unknown = await Bun.file(path.join(agentDir, LEDGER_FILENAME)).json();
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		const ledger: ImportLedger = {};
		for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
			if (!value || typeof value !== "object") continue;
			const record = value as Partial<ImportedSessionRecord>;
			if (
				typeof record.source !== "string" ||
				typeof record.sourceId !== "string" ||
				typeof record.sessionId !== "string" ||
				typeof record.sessionFile !== "string"
			) {
				continue;
			}
			ledger[key] = {
				source: record.source,
				sourceId: record.sourceId,
				sessionId: record.sessionId,
				sessionFile: record.sessionFile,
				importedAt: typeof record.importedAt === "number" ? record.importedAt : 0,
			};
		}
		return ledger;
	} catch (error) {
		if (!isEnoent(error)) logger.warn("Failed to read imported-session ledger", { error });
		return {};
	}
}

/** `null` when the copy was deleted or the entry is absent. */
export function importedRecord(ledger: ImportLedger, source: string, sourceId: string): ImportedSessionRecord | null {
	const record = ledger[importLedgerKey(source, sourceId)];
	if (!record) return null;
	try {
		if (!fs.existsSync(record.sessionFile)) return null;
	} catch {
		return null;
	}
	return record;
}

let writeChain: Promise<void> = Promise.resolve();

/** Record one successful copy; serialized so concurrent imports cannot lose entries. */
export function recordImportedSession(record: ImportedSessionRecord, agentDir: string = getAgentDir()): Promise<void> {
	const next = writeChain.then(async () => {
		const ledger = await loadImportLedger(agentDir);
		ledger[importLedgerKey(record.source, record.sourceId)] = record;
		const file = path.join(agentDir, LEDGER_FILENAME);
		const tmp = `${file}.tmp`;
		await fs.promises.mkdir(agentDir, { recursive: true });
		await fs.promises.writeFile(tmp, JSON.stringify(ledger, null, "\t"));
		await fs.promises.rename(tmp, file);
	});
	// Keep the chain alive after a failed write; the caller still sees the error.
	writeChain = next.catch(() => {});
	return next;
}
