/**
 * Tests for the capability readiness module.
 *
 * The state machine has five transitions per provider (idle → loading →
 * ready | failed | disabled) plus an aggregate per capability. Each test
 * targets one transition in isolation so failures point at the exact commit
 * path that regressed.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { LoadContext, LoadResult, Provider } from "@musepi/pi-coding-agent/capability";
import {
	getReadiness,
	onReadinessChange,
	recordLoadFailure,
	recordLoadSuccess,
	resetReadiness,
	syncProviderSet,
	whenReady,
} from "@musepi/pi-coding-agent/capability/readiness";

const ctx: LoadContext = { cwd: "/tmp", home: "/tmp", repoRoot: null };

function makeProvider(id: string, overrides: Partial<Provider<unknown>> = {}): Provider<unknown> {
	return {
		id,
		displayName: id,
		description: id,
		priority: 100,
		load: async () => ({ items: [] }) as LoadResult<unknown>,
		...overrides,
	};
}

beforeEach(() => {
	resetReadiness();
});

afterEach(() => {
	resetReadiness();
});

describe("getReadiness", () => {
	it("reports idle for an unknown capability", () => {
		const snap = getReadiness("never-registered");
		expect(snap.state).toBe("idle");
		expect(snap.providers).toEqual([]);
	});

	it("reflects every provider the caller has registered", () => {
		syncProviderSet("mcps", [makeProvider("a"), makeProvider("b")]);
		const snap = getReadiness("mcps");
		expect(snap.providers.length).toBe(2);
		expect(snap.state).toBe("idle");
	});

	it("drops providers that disappear from the registry", () => {
		syncProviderSet("mcps", [makeProvider("a"), makeProvider("b")]);
		syncProviderSet("mcps", [makeProvider("a")]);
		const snap = getReadiness("mcps");
		expect(snap.providers.length).toBe(1);
		expect(snap.providers[0]?.providerId).toBe("a");
	});
});

describe("provider state transitions", () => {
	it("idle → loading → ready via beginLoadAttempt + recordLoadSuccess", async () => {
		const provider = makeProvider("p1");
		syncProviderSet("caps", [provider]);
		// beginLoadAttempt marks loading internally; we exercise it via a real
		// load path. Here, simulate the success path directly.
		recordLoadSuccess("caps", provider);
		const snap = getReadiness("caps");
		const p1 = snap.providers.find(p => p.providerId === "p1");
		expect(p1?.state).toBe("ready");
		expect(p1?.lastLoadedAt).toBeGreaterThan(0);
		expect(p1?.failureCount).toBe(0);
	});

	it("records failed state with the error message and increments failureCount", () => {
		const provider = makeProvider("p1");
		syncProviderSet("caps", [provider]);
		recordLoadFailure("caps", provider, new Error("boom"));
		const snap = getReadiness("caps");
		const p1 = snap.providers.find(p => p.providerId === "p1");
		expect(p1?.state).toBe("failed");
		expect(p1?.error).toBe("boom");
		expect(p1?.failureCount).toBe(1);
	});

	it("subsequent success clears the error and keeps lastLoadedAt", () => {
		const provider = makeProvider("p1");
		syncProviderSet("caps", [provider]);
		recordLoadFailure("caps", provider, new Error("boom"));
		recordLoadSuccess("caps", provider);
		const snap = getReadiness("caps");
		const p1 = snap.providers.find(p => p.providerId === "p1");
		expect(p1?.state).toBe("ready");
		expect(p1?.error).toBeUndefined();
	});

	it("records disabled via the public API", async () => {
		const { recordDisabled } = await import("@musepi/pi-coding-agent/capability/readiness");
		const provider = makeProvider("p1");
		syncProviderSet("caps", [provider]);
		recordDisabled("caps", provider);
		const snap = getReadiness("caps");
		const p1 = snap.providers.find(p => p.providerId === "p1");
		expect(p1?.state).toBe("disabled");
	});
});

describe("capability aggregate state", () => {
	it("aggregates ready when any provider is ready", () => {
		const a = makeProvider("a");
		const b = makeProvider("b");
		syncProviderSet("caps", [a, b]);
		recordLoadSuccess("caps", a);
		recordLoadFailure("caps", b, new Error("x"));
		const snap = getReadiness("caps");
		// b failed but a succeeded; aggregate stays ready (loading never wins
		// over a settled ready snapshot).
		expect(snap.state).toBe("ready");
		expect(snap.error).toBeDefined();
	});

	it("returns failed when every provider failed", () => {
		const a = makeProvider("a");
		const b = makeProvider("b");
		syncProviderSet("caps", [a, b]);
		recordLoadFailure("caps", a, new Error("x"));
		recordLoadFailure("caps", b, new Error("y"));
		const snap = getReadiness("caps");
		expect(snap.state).toBe("failed");
		expect(snap.error).toContain("2 providers failed");
	});

	it("returns idle for a capability with no providers", () => {
		expect(getReadiness("nothing").state).toBe("idle");
	});
});

describe("whenReady", () => {
	it("resolves immediately when state is already non-idle", async () => {
		const provider = makeProvider("p1");
		syncProviderSet("caps", [provider]);
		recordLoadSuccess("caps", provider);
		const snap = await whenReady("caps");
		expect(snap.state).toBe("ready");
	});

	it("resolves on the next transition from idle", async () => {
		syncProviderSet("caps", [makeProvider("p1")]);
		const promise = whenReady("caps", { timeoutMs: 1000 });
		// Yield once so the listener can register, then trigger a transition.
		await Promise.resolve();
		recordLoadSuccess("caps", makeProvider("p1"));
		const snap = await promise;
		expect(snap.state).toBe("ready");
	});

	it("respects timeoutMs and resolves with current state on expiry", async () => {
		syncProviderSet("caps", [makeProvider("p1")]);
		const snap = await whenReady("caps", { timeoutMs: 5 });
		expect(snap.state === "idle" || snap.state === "loading" || snap.state === "ready").toBe(true);
	});
});

describe("onReadinessChange", () => {
	it("fires on each committed transition", () => {
		const events: Array<{ id: string; state: string }> = [];
		const unsub = onReadinessChange(snap => events.push({ id: snap.capabilityId, state: snap.state }));

		const provider = makeProvider("p1");
		syncProviderSet("caps", [provider]);
		recordLoadSuccess("caps", provider);
		recordLoadFailure("caps", provider, new Error("boom"));

		unsub();
		expect(events.length).toBeGreaterThan(0);
		const last = events[events.length - 1];
		expect(last?.id).toBe("caps");
		expect(last?.state).toBe("failed");
	});

	it("unsubscribe stops further events", () => {
		const events: string[] = [];
		const unsub = onReadinessChange(snap => events.push(`${snap.capabilityId}:${snap.state}`));
		const provider = makeProvider("p1");
		syncProviderSet("caps", [provider]);
		const beforeCount = events.length;
		unsub();
		recordLoadSuccess("caps", provider);
		expect(events.length).toBe(beforeCount);
	});

	it("covers capabilities registered after subscription", () => {
		const events: string[] = [];
		const unsub = onReadinessChange(snap => events.push(`${snap.capabilityId}:${snap.state}`));
		// Brand-new id, never seen before; the global listener hook should still
		// pick it up via the first transition commit.
		const provider = makeProvider("late");
		syncProviderSet("late-cap", [provider]);
		recordLoadSuccess("late-cap", provider);
		unsub();
		expect(events.some(e => e.startsWith("late-cap:"))).toBe(true);
	});
});

describe("resetReadiness", () => {
	it("clears the entire store", () => {
		syncProviderSet("a", [makeProvider("x")]);
		syncProviderSet("b", [makeProvider("y")]);
		expect(getReadiness("a").providers.length).toBe(1);
		resetReadiness();
		expect(getReadiness("a").state).toBe("idle");
		expect(getReadiness("b").state).toBe("idle");
	});
});

describe("integration: loadCapability wires readiness", () => {
	it("marks providers ready after a successful loadCapability call", async () => {
		const { defineCapability, loadCapability, registerProvider } = await import("@musepi/pi-coding-agent/capability");
		resetReadiness();
		// Snapshot the test cwd so the load loop's findRepoRoot doesn't wander
		// to the developer's working tree and pull in unrelated state.
		const provider = makeProvider("test-provider", {
			load: async () =>
				({
					items: [
						{
							id: "item-1",
							_source: { provider: "test-provider", providerName: "TP", path: "/tmp/x", level: "user" },
						},
					],
				}) as LoadResult<unknown>,
		});
		const cap = defineCapability<{ id: string; _source: unknown }>({
			id: "readiness-test-cap",
			displayName: "Readiness Test",
			description: "x",
			key: item => item.id,
		});
		registerProvider("readiness-test-cap", provider as Provider<{ id: string; _source: unknown }>);
		await loadCapability("readiness-test-cap", { cwd: "/tmp" });
		const snap = getReadiness("readiness-test-cap");
		expect(snap.state).toBe("ready");
		expect(snap.providers[0]?.state).toBe("ready");
	});
});
