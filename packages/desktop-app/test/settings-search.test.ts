import { describe, expect, it } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { matchSettingRows, type SettingSearchRow, settingSectionFor } from "../src/lib/settings-search";

const rows: SettingSearchRow[] = [
	{
		key: "compaction.thresholdPercent",
		section: "context",
		tab: "context",
		group: "Compaction",
		label: "Compaction Threshold",
		description: "Percent threshold for context maintenance",
	},
	{
		key: "temperature",
		section: "model",
		tab: "model",
		group: "Sampling",
		label: "Temperature",
		description: "Sampling temperature",
	},
	{
		key: "tools.approval",
		section: "tools",
		tab: "interaction",
		group: "Approvals",
		label: "Tool Approval Policies",
	},
];

describe("settingSectionFor", () => {
	it("routes each schema tab to the page that renders it", () => {
		expect(settingSectionFor("appearance")).toBe("appearance");
		expect(settingSectionFor("model")).toBe("model");
		expect(settingSectionFor("providers")).toBe("model");
		expect(settingSectionFor("tasks")).toBe("subagents");
		expect(settingSectionFor("voice")).toBe("voice");
		expect(settingSectionFor("interaction")).toBe("interaction");
	});

	it("honours the re-sliced interaction groups", () => {
		expect(settingSectionFor("interaction", "Approvals")).toBe("tools");
		expect(settingSectionFor("interaction", "Speech")).toBe("voice");
		expect(settingSectionFor("interaction", "Language")).toBe("appearance");
	});

	it("returns null for tabs no page owns", () => {
		expect(settingSectionFor("extension-tab")).toBeNull();
	});
});

describe("matchSettingRows", () => {
	it("finds a row by translated label, source label, key and description", () => {
		setLocale("zh-CN");
		expect(matchSettingRows(rows, "压缩阈值").map(row => row.key)).toEqual(["compaction.thresholdPercent"]);
		setLocale("en-US");
		expect(matchSettingRows(rows, "compaction").map(row => row.key)).toEqual(["compaction.thresholdPercent"]);
		expect(matchSettingRows(rows, "thresholdPercent").map(row => row.key)).toEqual(["compaction.thresholdPercent"]);
		expect(matchSettingRows(rows, "sampling temperature").map(row => row.key)).toEqual(["temperature"]);
	});

	it("is case-insensitive and matches within a word", () => {
		expect(matchSettingRows(rows, "APPROVAL").map(row => row.key)).toEqual(["tools.approval"]);
	});

	it("returns nothing for a blank query and caps the result list", () => {
		expect(matchSettingRows(rows, "   ")).toEqual([]);
		expect(matchSettingRows(rows, "a", 1).length).toBe(1);
	});
});
