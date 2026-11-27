// The sessionMode projection: goal/plan switches are sampled after the RPC
// that writes them and pushed as whole values, so clients never poll for them.
import { describe, expect, test } from "bun:test";
import {
	type ProjectionSampleSource,
	SessionProjectionRegistry,
	sessionModeProjectionDefinition,
} from "../../src/session/session-projections";

function source(mode: { goal: { enabled: boolean; objective?: string; status?: string } | null; plan: boolean }) {
	return {
		model: () => null,
		sessionStats: () => ({}) as never,
		sessionMode: () => mode,
	} satisfies ProjectionSampleSource;
}

function registry(seed: ReturnType<typeof source>): SessionProjectionRegistry {
	const r = new SessionProjectionRegistry();
	r.register(sessionModeProjectionDefinition);
	r.seed("s1", { entries: [], source: seed });
	return r;
}

describe("sessionMode projection", () => {
	test("starts from the seeded live values", () => {
		const r = registry(source({ goal: { enabled: true, objective: "ship", status: "active" }, plan: true }));
		expect(r.snapshot("s1")?.values.sessionMode).toEqual({
			goal: { enabled: true, objective: "ship", status: "active" },
			plan: true,
		});
	});

	test("a mode write publishes the new value", () => {
		const mode = { goal: null as { enabled: boolean; objective?: string; status?: string } | null, plan: false };
		const r = registry(source(mode));
		expect(r.snapshot("s1")?.values.sessionMode).toEqual({ goal: null, plan: false });

		// The RPC wrote plan mode; the host samples at this boundary.
		mode.plan = true;
		const changes = r.applyEvent("s1", { type: "session_mode_changed" });

		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ key: "sessionMode", value: { goal: null, plan: true } });
	});

	test("an unrelated event publishes nothing", () => {
		const r = registry(source({ goal: null, plan: false }));
		// This is what keeps the projection feed quiet: an agent turn must not
		// re-push a switch it did not touch.
		const changes = r.applyEvent("s1", { type: "turn_end" } as never);
		expect(changes).toEqual([]);
	});

	test("a boundary that samples the same value publishes nothing", () => {
		const r = registry(source({ goal: null, plan: true }));
		const changes = r.applyEvent("s1", { type: "session_mode_changed" });
		expect(changes).toEqual([]);
	});

	test("goal off projects null rather than a disabled record", () => {
		// The GUI badge keys off `goal === null`; a disabled record would read
		// as "a goal exists and is off", which is a different state.
		const r = registry(source({ goal: { enabled: false, objective: "old" }, plan: false }));
		expect(r.snapshot("s1")?.values.sessionMode).toEqual({ goal: null, plan: false });
	});
});
