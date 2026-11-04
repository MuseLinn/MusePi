/**
 * Import bookkeeping must never turn a repeated import into a duplicate, and a
 * corrupt ledger must never block the picker. The source file is validated
 * separately so a deleted copy can be restored.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { importedRecord, loadImportLedger, recordImportedSession } from "../src/session/import-ledger";

const dirs: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-import-ledger-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("import ledger", () => {
	test("records a copy and resolves it by source + source id", async () => {
		const agentDir = tempDir();
		const sessionFile = path.join(tempDir(), "copy.jsonl");
		fs.writeFileSync(sessionFile, "{}\n");
		await recordImportedSession(
			{ source: "claude", sourceId: "abc", sessionId: "new-1", sessionFile, importedAt: 1 },
			agentDir,
		);
		const ledger = await loadImportLedger(agentDir);
		expect(importedRecord(ledger, "claude", "abc")?.sessionId).toBe("new-1");
		// Different source namespace: same id is not the same record.
		expect(importedRecord(ledger, "codex", "abc")).toBeNull();
	});

	test("a deleted copy is not treated as imported", async () => {
		const agentDir = tempDir();
		const sessionFile = path.join(tempDir(), "gone.jsonl");
		fs.writeFileSync(sessionFile, "{}\n");
		await recordImportedSession(
			{ source: "pi", sourceId: "x", sessionId: "new-2", sessionFile, importedAt: 1 },
			agentDir,
		);
		fs.rmSync(sessionFile);
		expect(importedRecord(await loadImportLedger(agentDir), "pi", "x")).toBeNull();
	});

	test("corrupt or missing ledgers read as empty", async () => {
		const agentDir = tempDir();
		fs.writeFileSync(path.join(agentDir, "imported-sessions.json"), "{not json");
		expect(await loadImportLedger(agentDir)).toEqual({});
		expect(await loadImportLedger(path.join(agentDir, "nope"))).toEqual({});
	});

	test("concurrent records do not lose entries", async () => {
		const agentDir = tempDir();
		const files = [1, 2, 3].map(index => {
			const file = path.join(tempDir(), `${index}.jsonl`);
			fs.writeFileSync(file, "{}\n");
			return file;
		});
		await Promise.all(
			files.map((sessionFile, index) =>
				recordImportedSession(
					{ source: "omp", sourceId: `s${index}`, sessionId: `new-${index}`, sessionFile, importedAt: index },
					agentDir,
				),
			),
		);
		const ledger = await loadImportLedger(agentDir);
		expect(Object.keys(ledger)).toHaveLength(3);
	});
});
