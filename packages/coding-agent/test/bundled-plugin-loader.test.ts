import { describe, expect, it } from "bun:test";
import { createBundledPluginLoader } from "../src/bundled-plugins/loader";

describe("bundled plugin loader attempts", () => {
	it("retries a failed discovery without sharing state with another loader", async () => {
		let calls = 0;
		let shouldFail = true;
		const loader = createBundledPluginLoader(async () => {
			calls += 1;
			if (shouldFail) throw new Error("discovery exploded");
			return [];
		});

		await expect(loader.ensure(process.cwd())).rejects.toThrow("discovery exploded");
		shouldFail = false;
		expect(await loader.ensure(process.cwd())).toBe(true);
		expect(await loader.ensure(process.cwd())).toBe(false);
		expect(calls).toBe(2);
	});

	it("shares one in-flight attempt and reports completion to concurrent callers", async () => {
		let calls = 0;
		const loader = createBundledPluginLoader(async () => {
			calls += 1;
			await Bun.sleep(5);
			return [];
		});

		const [first, second] = await Promise.all([loader.ensure(process.cwd()), loader.ensure(process.cwd())]);
		expect([first, second]).toEqual([true, false]);
		expect(calls).toBe(1);
	});
});
