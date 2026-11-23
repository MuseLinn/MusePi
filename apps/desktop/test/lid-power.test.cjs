const { describe, expect, it } = require("bun:test");
const { createLidPower, lidActionBlock, parseLidActions } = require("../electron/lid-power.cjs");

const sample = `
      Current AC Power Setting Index: 0x00000001
      Current DC Power Setting Index: 0x00000003
`;

describe("powercfg lid actions", () => {
	it("reads both power sources in order", () => {
		expect(parseLidActions(sample)).toEqual({ ac: 1, dc: 3 });
	});

	it("rejects output without exactly two indices and out-of-range actions", () => {
		expect(parseLidActions("Current AC Power Setting Index: 0x00000001")).toBeUndefined();
		expect(parseLidActions("Current AC Power Setting Index: 0x00000009\nCurrent DC Power Setting Index: 0x00000000")).toBeUndefined();
	});

	it("finds the lid block in a full dump", () => {
		const dump = [
			"Power Scheme GUID: 381b4222  (Balanced)",
			"    Power Setting GUID: 5ca83367-6e45-459f-a27b-476b1d01c936  (LIDACTION)",
			"      Current AC Power Setting Index: 0x00000000",
			"      Current DC Power Setting Index: 0x00000002",
			"    Power Setting GUID: a7066653-8d6c-40a8-910e-a1f54b84c7e5",
			"      Current AC Power Setting Index: 0x00000001",
		].join("\n");
		expect(parseLidActions(lidActionBlock(dump))).toEqual({ ac: 0, dc: 2 });
	});
});

/** Fakes the platform mechanism so the state machine runs on any host. */
function fakePower(platform) {
	const calls = [];
	const previous = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	const lid = createLidPower({
		log: () => {},
		macAssertionTimeout: seconds => {
			const held = { seconds, stopped: false };
			calls.push(held);
			return {
				stop() {
					held.stopped = true;
				},
			};
		},
	});
	return {
		lid,
		calls,
		restore: () => previous && Object.defineProperty(process, "platform", previous),
	};
}

describe("lid power state machine", () => {
	it("acquires once, releases once, and reports the held state", async () => {
		const { lid, calls, restore } = fakePower("darwin");
		try {
			expect(lid.enabled).toBe(false);
			expect(await lid.acquire()).toEqual({ enabled: true });
			expect(lid.enabled).toBe(true);
			expect(calls).toHaveLength(1);
			expect(await lid.acquire()).toEqual({ enabled: true });
			expect(calls[0].stopped).toBe(true);
			expect(calls).toHaveLength(2);
			expect(await lid.release()).toEqual({ enabled: false });
			expect(calls[1].stopped).toBe(true);
			expect(lid.enabled).toBe(false);
		} finally {
			restore();
		}
	});

	it("lets a superseded enable hand its mechanism back instead of leaking it", async () => {
		const { lid, calls, restore } = fakePower("darwin");
		try {
			await Promise.all([lid.acquire(), lid.acquire()]);
			expect(lid.enabled).toBe(true);
			// Two handles were taken; exactly one of them is still held.
			expect(calls.filter(held => !held.stopped)).toHaveLength(1);
		} finally {
			restore();
		}
	});

	it("keeps the preference when the release mechanism fails", async () => {
		const calls = [];
		const previous = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		try {
			const lid = createLidPower({
				log: () => {},
				macAssertionTimeout: () => {
					calls.push("acquire");
					return {
						stop() {
							throw new Error("IOReturn busy");
						},
					};
				},
			});
			await lid.acquire();
			// The assertion is still in place, so the released state is false
			// until the machine actually lets go.
			await expect(lid.release()).rejects.toThrow(/IOReturn busy/);
			expect(lid.enabled).toBe(true);
		} finally {
			previous && Object.defineProperty(process, "platform", previous);
		}
	});

	it("forgets the preference when its helper exits on its own", async () => {
		const { lid, restore } = fakePower("darwin");
		try {
			await lid.acquire();
			lid.noteLost();
			expect(lid.enabled).toBe(false);
			expect(await lid.release()).toEqual({ enabled: false });
		} finally {
			restore();
		}
	});

	it("is unsupported off the desktop platforms", async () => {
		const { lid, restore } = fakePower("aix");
		try {
			expect(lid.supported()).toBe(false);
			await expect(lid.acquire()).rejects.toThrow(/unsupported/);
			expect(lid.enabled).toBe(false);
		} finally {
			restore();
		}
	});
});