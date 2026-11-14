import { describe, expect, test } from "bun:test";
import type { SlashEntry } from "../components/SlashRow";
import { rankSlashEntries } from "./slash-rank";

const cmd = (name: string, description?: string): SlashEntry => ({
	name,
	description: description ?? "",
	kind: "command",
	category: "daemon",
});

describe("rankSlashEntries", () => {
	test("exact name beats prefix beats substring beats description match", () => {
		const entries = [cmd("clear"), cmd("usage", "show subscription usage"), cmd("context"), cmd("update")];
		expect(rankSlashEntries(entries, "us", new Set()).map(e => e.name)).toEqual([
			"usage",
			"clear",
			"context",
			"update",
		]);
		expect(rankSlashEntries(entries, "u", new Set()).map(e => e.name)).toEqual([
			"usage",
			"update",
			"clear",
			"context",
		]);
	});

	test("GUI-native commands win ties inside a tier", () => {
		const entries = [cmd("clear"), cmd("context"), cmd("compaction")];
		const ranked = rankSlashEntries(entries, "c", new Set(["context"])).map(e => e.name);
		expect(ranked[0]).toBe("context");
		expect(ranked).toContain("clear");
		expect(ranked).toContain("compaction");
	});

	test("description-only matches sort after every name match", () => {
		const entries = [cmd("help"), cmd("usage", "show subscription usage")];
		expect(rankSlashEntries(entries, "sub", new Set()).map(e => e.name)).toEqual(["usage", "help"]);
		expect(rankSlashEntries([cmd("usage", "show subscription usage")], "sub", new Set()).map(e => e.name)).toEqual([
			"usage",
		]);
	});

	test("empty query preserves input order", () => {
		const entries = [cmd("zebra"), cmd("alpha"), cmd("usage")];
		expect(rankSlashEntries(entries, "", new Set())).toBe(entries);
	});

	test("non-matching entries sink to the bottom unchanged", () => {
		const entries = [cmd("alpha"), cmd("skill:foo"), cmd("usage")];
		const ranked = rankSlashEntries(entries, "us", new Set()).map(e => e.name);
		expect(ranked).toEqual(["usage", "alpha", "skill:foo"]);
	});

	test("stable within a tier", () => {
		const entries = [cmd("context"), cmd("clear")];
		expect(rankSlashEntries(entries, "c", new Set()).map(e => e.name)).toEqual(["context", "clear"]);
	});
});
