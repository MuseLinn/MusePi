// The projection registry is a service: it drives and stores, and every domain
// registers its own unit. Nothing central names a domain.
import { describe, expect, test } from "bun:test";
import { SessionProjectionService } from "../../src/daemon/services/session-projection-service";
import { SessionProjectionRegistry } from "../../src/session/session-projections";

function stats() {
	return {
		sessionFile: undefined,
		sessionId: "s1",
		userMessages: 0,
		assistantMessages: 0,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 0,
		tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		premiumRequests: 0,
		cost: 0,
	};
}

function seed(service: SessionProjectionService): void {
	service.seed("s1", {
		entries: [],
		source: {
			model: () => null,
			sessionStats: stats as never,
			sessionMode: () => ({ goal: null, plan: true }),
		},
	});
}

describe("SessionProjectionService", () => {
	test("a domain registers its own unit; the service names none", () => {
		const service = new SessionProjectionService(new SessionProjectionRegistry());
		expect(service.keys()).toEqual([]);

		service.register({
			key: "demo",
			init: () => ({ n: 0 }),
			apply: state => state,
			view: state => state,
		});
		expect(service.keys()).toEqual(["demo"]);
	});

	test("it wraps the host registry rather than copying its state", () => {
		// The host's commit path reads this same instance; a second copy would
		// let the two drift apart.
		const registry = new SessionProjectionRegistry();
		const service = new SessionProjectionService(registry);
		service.register({
			key: "demo",
			init: () => ({ n: 1 }),
			apply: state => state,
			view: state => state,
		});
		seed(service);

		expect(registry.snapshot("s1")?.values.demo).toEqual({ n: 1 });
	});

	test("stop drops fold state and leaves registrations alone", () => {
		const registry = new SessionProjectionRegistry();
		const service = new SessionProjectionService(registry);
		service.register({
			key: "demo",
			init: () => ({ n: 1 }),
			apply: state => state,
			view: state => state,
		});
		seed(service);
		expect(registry.snapshot("s1")).toBeDefined();

		service.stop();
		// A remount starts clean: the state is gone, so nothing stale is served.
		expect(registry.snapshot("s1")).toBeUndefined();
		expect(service.keys()).toEqual(["demo"]);
	});

	test("a handle withdraws its unit from the baseline", () => {
		const service = new SessionProjectionService(new SessionProjectionRegistry());
		const handle = service.register({
			key: "demo",
			init: () => ({ n: 1 }),
			apply: state => state,
			view: state => state,
		});
		seed(service);
		expect(service.snapshot("s1")?.values.demo).toBeDefined();

		handle.dispose();
		expect(service.keys()).toEqual([]);
		expect(service.snapshot("s1")?.values.demo).toBeUndefined();
	});

	test("the handle reads the state it declared, like dsh's stateOf", () => {
		// This is what keeps a domain from keeping a second copy: it asks the
		// unit it contributed instead of caching the same facts beside it.
		const service = new SessionProjectionService(new SessionProjectionRegistry());
		const handle = service.register<{ n: number }>({
			key: "demo",
			init: () => ({ n: 7 }),
			apply: state => state,
			view: state => state,
		});
		seed(service);

		expect(handle.stateOf("s1")).toEqual({ n: 7 });
		expect(handle.viewOf("s1")).toEqual({ n: 7 });
		expect(handle.stateOf("unknown-session")).toBeUndefined();
	});

	test("a withdrawn handle stops serving state", () => {
		const service = new SessionProjectionService(new SessionProjectionRegistry());
		const handle = service.register<{ n: number }>({
			key: "demo",
			init: () => ({ n: 7 }),
			apply: state => state,
			view: state => state,
		});
		seed(service);
		handle.dispose();
		// A disabled domain must look absent, not stale.
		expect(handle.stateOf("s1")).toBeUndefined();
	});
});
