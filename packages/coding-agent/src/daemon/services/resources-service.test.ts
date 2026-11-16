import { describe, expect, it, vi } from "bun:test";
import { ResourcesService } from "./resources-service";

/** 真实消耗 CPU 时间，避免依赖定时器精度（Windows 的 os.cpus() 时钟粒度约 15ms）。 */
function busyLoop(ms: number): void {
	const until = Date.now() + ms;
	while (Date.now() < until) {}
}

describe("ResourcesService", () => {
	it("reports no CPU on the first sample and real deltas on the next", () => {
		const service = new ResourcesService();

		const first = service.sample();
		expect(first.process.cpuPercent).toBeNull();
		expect(first.system.cpuPercent).toBeNull();
		expect(first.process.pid).toBe(process.pid);
		expect(first.process.rss).toBeGreaterThan(0);
		expect(first.process.heapUsed).toBeGreaterThan(0);
		expect(first.system.cpuCount).toBeGreaterThan(0);
		expect(first.system.memUsed).toBeLessThanOrEqual(first.system.memTotal);

		busyLoop(120);

		const second = service.sample();
		expect(second.sampledAt).toBeGreaterThanOrEqual(first.sampledAt);
		expect(second.process.cpuPercent).not.toBeNull();
		expect(second.process.cpuPercent as number).toBeGreaterThanOrEqual(0);
		expect(second.system.cpuPercent).not.toBeNull();
		expect(second.system.cpuPercent as number).toBeGreaterThanOrEqual(0);
		expect(second.system.cpuPercent as number).toBeLessThanOrEqual(100);
		expect(second.process.uptimeMs).toBeGreaterThanOrEqual(first.process.uptimeMs);
	});

	it("returns null CPU instead of NaN when the wall clock stands still", () => {
		const service = new ResourcesService();
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);

		service.sample();
		now.mockReturnValue(999_000);

		const second = service.sample();
		expect(second.process.cpuPercent).toBeNull();
		expect(second.system.cpuPercent).toBeNull();
		now.mockRestore();
	});
});
