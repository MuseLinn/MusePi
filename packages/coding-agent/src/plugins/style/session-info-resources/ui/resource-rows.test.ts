/**
 * 「资源」分区的读数投影：三行的顺序、格式，以及首次采样没有 CPU 基线时的
 * 显示规则（`—` 而不是 0%）。
 */
import { describe, expect, it } from "bun:test";
import { formatBytes, formatUptime, type ResourceSampleView, resourceRows } from "./resource-rows";

function sample(overrides: {
	processCpu?: number | null;
	systemCpu?: number | null;
	rss?: number;
	memUsed?: number;
	memTotal?: number;
}): ResourceSampleView {
	return {
		process: {
			rss: overrides.rss ?? 512 * 1024 ** 2,
			cpuPercent: overrides.processCpu === undefined ? 3.2 : overrides.processCpu,
			heapUsed: 210 * 1024 ** 2,
			uptimeMs: 2 * 60 * 60 * 1000 + 14 * 60 * 1000,
			pid: 4321,
		},
		system: {
			cpuPercent: overrides.systemCpu === undefined ? 18.4 : overrides.systemCpu,
			memUsed: overrides.memUsed ?? 12.5 * 1024 ** 3,
			memTotal: overrides.memTotal ?? 23.5 * 1024 ** 3,
			cpuCount: 16,
		},
	};
}

describe("resources section rows", () => {
	it("renders the three readings in card order", () => {
		const rows = resourceRows(sample({}));
		expect(rows.map(row => [row.label, row.value])).toEqual([
			["MusePi", "512 MB · 3.2%"],
			["CPU", "18.4%"],
			["Memory", "12.5 GB / 23.5 GB"],
		]);
		expect(rows[0]?.percent).toBeCloseTo((512 / (23.5 * 1024)) * 100, 6);
		expect(rows[1]?.percent).toBe(18.4);
		expect(rows[2]?.percent).toBeCloseTo((12.5 / 23.5) * 100, 6);
	});

	// The row title carries what one line cannot: which process this is, its
	// heap and uptime, and the core count that makes >100% process CPU read
	// correctly.
	it("explains the readouts on hover instead of adding rows", () => {
		const rows = resourceRows(sample({}));
		expect(rows[0]?.title).toBe("MusePi daemon · pid 4321 · heap 210 MB · up 2h14m");
		expect(rows[1]?.title).toBe("16 cores");
		expect(rows[2]?.title).toBe("12.5 GB of 23.5 GB");
	});

	// The first sample has no CPU baseline: showing 0% would read as an idle
	// machine instead of "not measured yet".
	it("shows an em dash and an empty bar while the CPU baseline is missing", () => {
		const rows = resourceRows(sample({ processCpu: null, systemCpu: null }));
		expect(rows[0]?.value).toBe("512 MB · —");
		expect(rows[1]).toEqual({ label: "CPU", percent: null, value: "—", title: "16 cores" });
		// Memory is a gauge, not a delta: it reads on the very first sample.
		expect(rows[2]?.percent).toBeCloseTo((12.5 / 23.5) * 100, 6);
	});

	it("clamps the CPU bar to 0–100 and leaves it empty without a total", () => {
		expect(resourceRows(sample({ systemCpu: 143.2 }))[1]?.percent).toBe(100);
		expect(resourceRows(sample({ systemCpu: -4 }))[1]?.percent).toBe(0);
		expect(resourceRows(sample({ memTotal: 0 }))[2]?.percent).toBeNull();
	});

	it("keeps the byte unit readable at each magnitude", () => {
		expect(formatBytes(23.5 * 1024 ** 3)).toBe("23.5 GB");
		expect(formatBytes(512 * 1024 ** 2)).toBe("512 MB");
		expect(formatBytes(2048)).toBe("2 KB");
	});

	it("reads uptime in the coarsest useful unit", () => {
		expect(formatUptime(9_000)).toBe("9s");
		expect(formatUptime(47 * 60_000)).toBe("47m");
		expect(formatUptime(2 * 3_600_000 + 14 * 60_000)).toBe("2h14m");
		// Negative is a bad reading, not a time before the epoch.
		expect(formatUptime(-5_000)).toBe("0s");
	});
});
