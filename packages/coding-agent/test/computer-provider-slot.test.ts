import { describe, expect, it } from "bun:test";
import { Settings } from "@musepi/pi-coding-agent/config/settings";
import type { ToolSession } from "@musepi/pi-coding-agent/tools";
import {
	BUILTIN_COMPUTER_PROVIDER,
	type ComputerSessionSnapshot,
	type ComputerWorkerInbound,
	type ComputerWorkerOutbound,
} from "@musepi/pi-coding-agent/tools/computer/protocol";
import { type ComputerProvider, ComputerProviderSlot } from "@musepi/pi-coding-agent/tools/computer/provider-slot";
import {
	type ComputerController,
	ComputerSupervisor,
	type ComputerWorkerHandle,
	registerComputerController,
	releaseComputerSessionsForOwner,
} from "@musepi/pi-coding-agent/tools/computer/supervisor";

function provider(name: string, release?: () => void | Promise<void>): ComputerProvider {
	return release ? { name, release } : { name };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, resolve };
}

const snapshot = (extra: Partial<ComputerSessionSnapshot> = {}): ComputerSessionSnapshot => ({
	cwd: import.meta.dir,
	sessionId: "computer-provider-slot",
	captureMaxWidth: 1280,
	captureMaxHeight: 896,
	display: "all",
	backgroundFallback: "takeover",
	readOnly: false,
	...extra,
});

function toolSession(): ToolSession {
	return {
		cwd: import.meta.dir,
		hasUI: false,
		settings: Settings.isolated({ "computer.enabled": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	} as ToolSession;
}

function controller(onClose: () => void): ComputerController {
	return {
		async run() {
			return { displays: [], returnValue: undefined, screenshots: [] };
		},
		async capabilities() {
			return undefined;
		},
		async close() {
			onClose();
		},
	};
}

class RunCaptureWorker implements ComputerWorkerHandle {
	readonly runs: Array<Extract<ComputerWorkerInbound, { type: "run" }>> = [];
	#handlers = new Set<(message: ComputerWorkerOutbound) => void>();

	send(message: ComputerWorkerInbound): void {
		if (message.type === "run") {
			this.runs.push(message);
			queueMicrotask(() =>
				this.#emit({
					type: "result",
					id: message.id,
					ok: true,
					payload: { displays: [], returnValue: undefined, screenshots: [] },
				}),
			);
			return;
		}
		if (message.type === "close") queueMicrotask(() => this.#emit({ type: "closed" }));
	}
	onMessage(handler: (message: ComputerWorkerOutbound) => void): () => void {
		this.#handlers.add(handler);
		queueMicrotask(() => this.#emit({ type: "ready" }));
		return () => this.#handlers.delete(handler);
	}
	onError(_handler: (error: Error) => void): () => void {
		return () => {};
	}
	async terminate(): Promise<void> {}
	#emit(message: ComputerWorkerOutbound): void {
		for (const handler of this.#handlers) handler(message);
	}
}

async function runSnapshot(
	slot: ComputerProviderSlot,
	extra: Partial<ComputerSessionSnapshot> = {},
): Promise<ComputerSessionSnapshot | undefined> {
	const worker = new RunCaptureWorker();
	const supervisor = new ComputerSupervisor(
		toolSession(),
		() => worker,
		{ startMs: 200, closeMs: 200 },
		async () => {
			throw new Error("tool bridge unused");
		},
		undefined,
		slot,
	);
	try {
		await supervisor.run("return 1", 1_000, snapshot(extra));
	} finally {
		await supervisor.close();
	}
	return worker.runs[0]?.session;
}

describe("computer provider slot", () => {
	it("reports the claimed provider and clears it on release", async () => {
		const slot = new ComputerProviderSlot();
		expect(slot.providerName).toBeNull();
		expect(slot.provider).toBeNull();

		const release = slot.register(provider("native"));
		expect(slot.providerName).toBe("native");
		expect(slot.provider?.name).toBe("native");

		await release();
		expect(slot.providerName).toBeNull();
		expect(slot.provider).toBeNull();
	});

	it("refuses a second registration and names the incumbent", () => {
		const slot = new ComputerProviderSlot();
		slot.register(provider("cua-driver"));

		expect(() => slot.register(provider("other"))).toThrow(/"cua-driver" is already registered/);
		// The slot tracks the registration, not the name: repeating it is a
		// second claimant and must fail too.
		expect(() => slot.register(provider("cua-driver"))).toThrow(/"cua-driver" is already registered/);
		expect(slot.providerName).toBe("cua-driver");
	});

	it("refuses a registration while the incumbent is still releasing", async () => {
		const slot = new ComputerProviderSlot();
		const settling = deferred();
		const release = slot.register(provider("cua-driver", () => settling.promise));

		const releasing = release();
		expect(slot.provider).toBeNull();
		expect(slot.providerName).toBe("cua-driver");
		expect(() => slot.register(provider("next"))).toThrow(/"cua-driver" is already registered/);

		settling.resolve();
		await releasing;
		expect(slot.providerName).toBeNull();
	});

	it("stops admitting work before it awaits the provider's own teardown", async () => {
		const slot = new ComputerProviderSlot();
		const settling = deferred();
		const calls: string[] = [];
		const release = slot.register({
			name: "cua-driver",
			release() {
				calls.push("release");
				return settling.promise;
			},
		});

		const releasing = release();
		expect(calls).toEqual(["release"]);
		expect(slot.provider).toBeNull();
		expect(slot.providerName).toBe("cua-driver");

		settling.resolve();
		await releasing;
		expect(slot.providerName).toBeNull();
	});

	it("returns the same promise and runs the provider release once", async () => {
		const slot = new ComputerProviderSlot();
		let releases = 0;
		const release = slot.register(
			provider("cua-driver", () => {
				releases += 1;
			}),
		);

		const first = release();
		const second = release();
		expect(second).toBe(first);
		await first;
		await release();
		expect(releases).toBe(1);
	});

	it("clears the slot when the provider's release throws", async () => {
		const slot = new ComputerProviderSlot();
		const release = slot.register({
			name: "broken",
			release() {
				throw new Error("teardown failed");
			},
		});

		await expect(release()).rejects.toThrow("teardown failed");
		expect(slot.providerName).toBeNull();
		expect(() => slot.register(provider("next"))).not.toThrow();
		expect(slot.providerName).toBe("next");
	});
});

describe("owner-scoped release", () => {
	it("releases the provider and the controllers its owner holds", async () => {
		const slot = new ComputerProviderSlot();
		const ownerId = `owner-${crypto.randomUUID()}`;
		let released = 0;
		const release = slot.register(
			provider("cua-driver", () => {
				released += 1;
			}),
			{ ownerId },
		);
		const closed: string[] = [];
		registerComputerController(
			ownerId,
			controller(() => closed.push("first")),
		);
		registerComputerController(
			ownerId,
			controller(() => closed.push("second")),
		);

		await releaseComputerSessionsForOwner(ownerId);

		expect(released).toBe(1);
		expect(slot.providerName).toBeNull();
		expect(closed.sort()).toEqual(["first", "second"]);

		await release();
		expect(released).toBe(1);
	});

	it("leaves another owner's controller and provider untouched", async () => {
		const slot = new ComputerProviderSlot();
		const ending = `owner-${crypto.randomUUID()}`;
		const living = `owner-${crypto.randomUUID()}`;
		const closed: string[] = [];
		registerComputerController(
			ending,
			controller(() => closed.push("ending")),
		);
		registerComputerController(
			living,
			controller(() => closed.push("living")),
		);
		const release = slot.register(provider("cua-driver"), { ownerId: living });

		await releaseComputerSessionsForOwner(ending);

		expect(closed).toEqual(["ending"]);
		expect(slot.providerName).toBe("cua-driver");

		await releaseComputerSessionsForOwner(living);
		expect(closed).toEqual(["ending", "living"]);
		expect(slot.providerName).toBeNull();
		await release();
	});

	it("unregisters a controller without closing it", async () => {
		const ownerId = `owner-${crypto.randomUUID()}`;
		let closed = 0;
		const unregister = registerComputerController(
			ownerId,
			controller(() => {
				closed += 1;
			}),
		);

		unregister();
		await releaseComputerSessionsForOwner(ownerId);

		expect(closed).toBe(0);
	});
});

describe("run snapshot provider", () => {
	it("names the registered provider in the run snapshot", async () => {
		const slot = new ComputerProviderSlot();
		slot.register(provider("cua-driver"));

		const session = await runSnapshot(slot);

		expect(session?.computerProvider).toBe("cua-driver");
	});

	it("names the built-in provider when nobody claimed the slot", async () => {
		const session = await runSnapshot(new ComputerProviderSlot());

		expect(session?.computerProvider).toBe(BUILTIN_COMPUTER_PROVIDER);
	});

	it("reports the built-in provider while the incumbent is still releasing", async () => {
		const slot = new ComputerProviderSlot();
		const settling = deferred();
		const release = slot.register(provider("cua-driver", () => settling.promise));
		const releasing = release();
		expect(slot.providerName).toBe("cua-driver");

		const session = await runSnapshot(slot);

		expect(session?.computerProvider).toBe(BUILTIN_COMPUTER_PROVIDER);
		settling.resolve();
		await releasing;
	});

	it("reads the slot when the run starts instead of the caller's snapshot", async () => {
		const slot = new ComputerProviderSlot();
		slot.register(provider("cua-driver"));

		const session = await runSnapshot(slot, { computerProvider: "stale" });

		expect(session?.computerProvider).toBe("cua-driver");
	});
});
