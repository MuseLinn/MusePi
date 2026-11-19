/**
 * Contract: the share exposure seam. A transport declares capabilities,
 * reports health as a small state machine, and can be replaced by a plugin
 * through the registry without the share path knowing its id.
 */

import { describe, expect, it } from "bun:test";
import {
	BaseExposure,
	type ExposureCapabilities,
	ExposureRegistry,
	type ExposureStartOptions,
	type ExposureStartResult,
	type ExposureStatus,
	exposureRegistry,
	lanExposureStatus,
} from "@musepi/pi-coding-agent/collab/exposure";

const CAPABILITIES: ExposureCapabilities = {
	guestInstall: false,
	publicExposure: false,
	stableUrl: false,
	thirdParty: false,
};

class FakeExposure extends BaseExposure {
	readonly id: string;
	readonly label: string;
	readonly capabilities = CAPABILITIES;
	#url: string | undefined;
	probeImpl: () => Promise<ExposureStatus>;

	constructor(id = "fake", probeImpl?: () => Promise<ExposureStatus>) {
		super(id);
		this.id = id;
		this.label = `Fake ${id}`;
		this.probeImpl = probeImpl ?? (async () => ({ id, health: "ready", detail: "ready" }));
	}

	async probe(): Promise<ExposureStatus> {
		const status = await this.probeImpl();
		this.setStatus(status);
		return status;
	}

	async start(_options: ExposureStartOptions): Promise<ExposureStartResult> {
		this.setStatus({ id: this.id, health: "starting" });
		this.#url = "https://fake.example";
		this.setStatus({ id: this.id, health: "ready", url: this.#url });
		return { joinUrl: this.#url, webUrl: "", webJoinUrl: this.#url };
	}

	/** Test hook: move the machine into a failure state. */
	degrade(reason: string): void {
		this.setStatus({ id: this.id, health: "degraded", detail: reason });
	}

	override async close(): Promise<void> {
		await super.close();
	}
}

describe("share exposure state machine", () => {
	it("walks starting → ready → degraded and clears the advertised URL", async () => {
		const exposure = new FakeExposure();
		const seen: string[] = [];
		exposure.onChange(status => seen.push(`${status.health}:${status.url ?? "-"}`));

		await exposure.start({ port: 1234 });
		expect(exposure.status().health).toBe("ready");
		expect(exposure.status().url).toBe("https://fake.example");

		exposure.degrade("edge node stopped answering");
		expect(exposure.status().health).toBe("degraded");
		expect(exposure.status().url).toBeUndefined();
		expect(exposure.status().detail).toContain("edge node");
		expect(seen).toEqual(["starting:-", "ready:https://fake.example", "degraded:-"]);
	});

	it("does not notify listeners for an unchanged snapshot", async () => {
		const exposure = new FakeExposure();
		let calls = 0;
		exposure.onChange(() => calls++);
		exposure.degrade("same");
		exposure.degrade("same");
		expect(calls).toBe(1);
	});

	it("stops idempotently and reports stopped", async () => {
		const exposure = new FakeExposure();
		await exposure.start({ port: 1234 });
		await exposure.close();
		await exposure.close();
		expect(exposure.status().health).toBe("stopped");
	});

	it("a throwing listener cannot break the lifecycle", async () => {
		const exposure = new FakeExposure();
		exposure.onChange(() => {
			throw new Error("listener exploded");
		});
		await expect(exposure.start({ port: 1234 })).resolves.toBeTruthy();
		expect(exposure.status().health).toBe("ready");
	});
});

describe("exposure registry", () => {
	it("registers, creates and unregisters a plugin exposure", () => {
		const registry = new ExposureRegistry();
		const unregister = registry.register("custom", () => new FakeExposure("custom"));
		expect(registry.ids()).toEqual(["custom"]);
		expect(registry.create("custom")?.label).toBe("Fake custom");
		expect(registry.create("missing")).toBeNull();
		unregister();
		expect(registry.create("custom")).toBeNull();
	});

	it("a stale unregister cannot remove a factory registered later", () => {
		const registry = new ExposureRegistry();
		const releaseFirst = registry.register("custom", () => new FakeExposure("custom"));
		registry.register("custom", () => new FakeExposure("custom"));
		releaseFirst(); // replaced factory: this must not delete the newer one
		expect(registry.create("custom")).not.toBeNull();
	});

	it("probeAll isolates a probe that throws", async () => {
		const registry = new ExposureRegistry();
		registry.register("ok", () => new FakeExposure("ok"));
		registry.register(
			"broken",
			() =>
				new FakeExposure("broken", async () => {
					throw new Error("kernel panicked");
				}),
		);
		const statuses = await registry.probeAll();
		expect(statuses.map(s => [s.id, s.health])).toEqual([
			["broken", "unavailable"],
			["ok", "ready"],
		]);
		expect(statuses[0]!.detail).toContain("kernel panicked");
	});

	it("probing an unknown id is unavailable rather than an exception", async () => {
		const registry = new ExposureRegistry();
		await expect(registry.probe("ghost")).resolves.toMatchObject({ id: "ghost", health: "unavailable" });
	});

	it("exposes the process-wide registry for plugins", () => {
		expect(exposureRegistry).toBeInstanceOf(ExposureRegistry);
	});
});

describe("LAN exposure descriptor", () => {
	it("reports ready when the machine has a routable address and actionable otherwise", () => {
		expect(lanExposureStatus(true)).toMatchObject({ id: "lan", health: "ready" });
		const unavailable = lanExposureStatus(false);
		expect(unavailable.health).toBe("unavailable");
		expect(unavailable.hint).toContain("external exposure");
	});
});
