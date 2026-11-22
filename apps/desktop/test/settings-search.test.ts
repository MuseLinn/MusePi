import "./dom-shim"; // MUST be first: @musepi/client-core defines HTMLElement subclasses at module evaluation.
import { afterEach, describe, expect, it } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { matchSettingRows, type SettingSearchRow, settingSectionFor } from "../src/lib/settings-search";

afterEach(() => setLocale("en-US"));

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
	{
		key: "appearance.accent",
		section: "appearance",
		tab: "appearance",
		group: "Theme",
		label: "Café accent",
		description: "ＷＥＢ résumé palette",
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

	it("matches a word-start subsequence of the label", () => {
		expect(matchSettingRows(rows, "tmprtr").map(row => row.key)).toEqual(["temperature"]);
	});

	it("matches both languages of a label regardless of the active locale", () => {
		setLocale("en-US");
		expect(matchSettingRows(rows, "压缩阈值").map(row => row.key)).toEqual(["compaction.thresholdPercent"]);
		setLocale("zh-CN");
		expect(matchSettingRows(rows, "compaction").map(row => row.key)).toEqual(["compaction.thresholdPercent"]);
	});

	it("ignores width and diacritics in labels and descriptions", () => {
		setLocale("en-US");
		expect(matchSettingRows(rows, "cafe").map(row => row.key)).toEqual(["appearance.accent"]);
		expect(matchSettingRows(rows, "web").map(row => row.key)).toEqual(["appearance.accent"]);
		expect(matchSettingRows(rows, "resume").map(row => row.key)).toEqual(["appearance.accent"]);
	});

	it("resolves namespaced schema keys for both languages", () => {
		const keyed: SettingSearchRow[] = [
			{
				key: "compaction.thresholdPercent",
				section: "context",
				tab: "context",
				group: "settings.compaction.group.core",
				label: "settings.compaction.threshold.title",
				description: "settings.compaction.threshold.desc",
			},
		];
		setLocale("en-US");
		expect(matchSettingRows(keyed, "Compaction Threshold").map(row => row.key)).toEqual([
			"compaction.thresholdPercent",
		]);
		expect(matchSettingRows(keyed, "压缩阈值").map(row => row.key)).toEqual(["compaction.thresholdPercent"]);
		expect(matchSettingRows(keyed, "reserved headroom").map(row => row.key)).toEqual(["compaction.thresholdPercent"]);
	});

	it("matches the description only as a contiguous substring", () => {
		expect(matchSettingRows(rows, "context maintenance").map(row => row.key)).toEqual([
			"compaction.thresholdPercent",
		]);
		// The letters run in order across the description, but never contiguously.
		expect(matchSettingRows(rows, "ctxmn")).toEqual([]);
	});

	it("ranks a label hit above a description-only hit", () => {
		const input: SettingSearchRow[] = [
			{ key: "desc", section: "model", tab: "model", label: "Sampling", description: "Temperature unit" },
			{ key: "label", section: "model", tab: "model", label: "Temperature", description: "Unit" },
		];
		expect(matchSettingRows(input, "temperature").map(row => row.key)).toEqual(["label", "desc"]);
	});

	it("returns nothing for a blank query and caps the result list", () => {
		expect(matchSettingRows(rows, "   ")).toEqual([]);
		expect(matchSettingRows(rows, "a", 1).length).toBe(1);
	});
});
