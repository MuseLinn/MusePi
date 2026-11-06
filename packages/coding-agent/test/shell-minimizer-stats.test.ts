import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	readShellMinimizerStats,
	recordShellMinimization,
} from "@musepi/pi-coding-agent/session/shell-minimizer-stats";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("shell minimizer savings journal", () => {
	it("aggregates real byte savings without retaining command content", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shell-minimizer-stats-"));
		tempDirs.push(dir);
		const journalPath = path.join(dir, "savings.jsonl");
		await recordShellMinimization({ filter: "git", inputBytes: 1000, outputBytes: 250 }, journalPath);
		await recordShellMinimization({ filter: "cargo", inputBytes: 2000, outputBytes: 1000 }, journalPath);
		await recordShellMinimization({ filter: "ignored", inputBytes: 10, outputBytes: 10 }, journalPath);
		await fs.appendFile(journalPath, "not json\n");

		const stats = await readShellMinimizerStats(journalPath);

		expect(stats).toEqual({
			totalCommands: 2,
			totalInputBytes: 3000,
			totalOutputBytes: 1250,
			totalSavedBytes: 1750,
			savingsPct: (1750 / 3000) * 100,
			byFilter: [
				{ filter: "cargo", commands: 1, inputBytes: 2000, outputBytes: 1000, savedBytes: 1000 },
				{ filter: "git", commands: 1, inputBytes: 1000, outputBytes: 250, savedBytes: 750 },
			],
		});
		const records = (await fs.readFile(journalPath, "utf8"))
			.split("\n")
			.filter(line => line.startsWith("{"))
			.map(line => JSON.parse(line) as Record<string, unknown>);
		expect(records).toHaveLength(2);
		for (const record of records) {
			expect(Object.keys(record).sort()).toEqual(["filter", "inputBytes", "outputBytes", "ts"]);
		}
	});

	it("returns empty statistics when the journal does not exist", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "shell-minimizer-stats-"));
		tempDirs.push(dir);
		expect(await readShellMinimizerStats(path.join(dir, "missing.jsonl"))).toEqual({
			totalCommands: 0,
			totalInputBytes: 0,
			totalOutputBytes: 0,
			totalSavedBytes: 0,
			savingsPct: 0,
			byFilter: [],
		});
	});
});
