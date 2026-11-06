import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getStatsDbPath, isEnoent, logger } from "@musepi/pi-utils";

export interface ShellMinimizationInput {
	filter: string;
	inputBytes: number;
	outputBytes: number;
}

interface ShellMinimizationRecord extends ShellMinimizationInput {
	ts: number;
}

export interface ShellMinimizerFilterStats {
	filter: string;
	commands: number;
	inputBytes: number;
	outputBytes: number;
	savedBytes: number;
}

export interface ShellMinimizerStats {
	totalCommands: number;
	totalInputBytes: number;
	totalOutputBytes: number;
	totalSavedBytes: number;
	savingsPct: number;
	byFilter: ShellMinimizerFilterStats[];
}

export function shellMinimizerJournalPath(): string {
	return path.join(path.dirname(getStatsDbPath()), "shell-minimizer-savings.jsonl");
}

export async function recordShellMinimization(
	info: ShellMinimizationInput,
	journalPath: string = shellMinimizerJournalPath(),
): Promise<void> {
	if (!isPositiveMeasurement(info)) return;
	try {
		await fs.mkdir(path.dirname(journalPath), { recursive: true });
		const record: ShellMinimizationRecord = { ts: Date.now(), ...info };
		await fs.appendFile(journalPath, `${JSON.stringify(record)}\n`);
	} catch (err) {
		logger.debug("shell minimizer savings journal append failed", { err: String(err) });
	}
}

export async function readShellMinimizerStats(
	journalPath: string = shellMinimizerJournalPath(),
): Promise<ShellMinimizerStats> {
	let text: string;
	try {
		text = await Bun.file(journalPath).text();
	} catch (err) {
		if (isEnoent(err)) return summarize([]);
		throw err;
	}
	const records: ShellMinimizationInput[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value = JSON.parse(line) as Partial<ShellMinimizationRecord>;
			if (isPositiveMeasurement(value)) {
				records.push({ filter: value.filter, inputBytes: value.inputBytes, outputBytes: value.outputBytes });
			}
		} catch {
			// A partial or malformed line does not invalidate the remaining journal.
		}
	}
	return summarize(records);
}

function isPositiveMeasurement(value: Partial<ShellMinimizationInput>): value is ShellMinimizationInput {
	return (
		typeof value.filter === "string" &&
		value.filter.length > 0 &&
		Number.isFinite(value.inputBytes) &&
		Number.isFinite(value.outputBytes) &&
		(value.inputBytes ?? 0) >= 0 &&
		(value.outputBytes ?? 0) >= 0 &&
		(value.inputBytes ?? 0) > (value.outputBytes ?? 0)
	);
}

function summarize(records: readonly ShellMinimizationInput[]): ShellMinimizerStats {
	const byFilter = new Map<string, ShellMinimizerFilterStats>();
	for (const record of records) {
		const current = byFilter.get(record.filter) ?? {
			filter: record.filter,
			commands: 0,
			inputBytes: 0,
			outputBytes: 0,
			savedBytes: 0,
		};
		current.commands += 1;
		current.inputBytes += record.inputBytes;
		current.outputBytes += record.outputBytes;
		current.savedBytes += record.inputBytes - record.outputBytes;
		byFilter.set(record.filter, current);
	}
	const rows = [...byFilter.values()].sort((a, b) => b.savedBytes - a.savedBytes || a.filter.localeCompare(b.filter));
	const totalInputBytes = rows.reduce((sum, row) => sum + row.inputBytes, 0);
	const totalOutputBytes = rows.reduce((sum, row) => sum + row.outputBytes, 0);
	const totalSavedBytes = rows.reduce((sum, row) => sum + row.savedBytes, 0);
	return {
		totalCommands: rows.reduce((sum, row) => sum + row.commands, 0),
		totalInputBytes,
		totalOutputBytes,
		totalSavedBytes,
		savingsPct: totalInputBytes > 0 ? (totalSavedBytes / totalInputBytes) * 100 : 0,
		byFilter: rows,
	};
}
