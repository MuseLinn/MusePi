// The sessionMode projection derives from the JOURNAL, not from the live
// session: a switch is a mode_change entry, and the unit folds those. Sampling
// the live fields would make the journal one of two authorities.
import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "@musepi/pi-wire";
import { SessionProjectionRegistry, sessionModeProjectionDefinition } from "../../src/session/session-projections";

function modeEntry(mode: string, data?: Record<string, unknown>): SessionEntry {
	return {
		type: "mode_change",
		id: `mode-${mode}-${Math.random()}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		mode,
		...(data ? { data } : {}),
	} as unknown as SessionEntry;
}

function registry(): SessionProjectionRegistry {
	const r = new SessionProjectionRegistry();
	r.register(sessionModeProjectionDefinition);
	return r;
}

const GOAL = {
	id: "goal-1",
	objective: "ship it",
	status: "active",
	tokensUsed: 1,
	timeUsedSeconds: 1,
	createdAt: 1,
	updatedAt: 2,
};

describe("sessionMode projection (journal-derived)", () => {
	test("seeding folds the transcript the snapshot already carries", () => {
		// This is the part that makes a reopened session honest: the baseline
		// comes from persisted history, so it cannot disagree with the journal.
		const r = registry();
		r.seed("s1", { entries: [modeEntry("plan", { planFilePath: "local://PLAN.md" })] });

		expect(r.snapshot("s1")?.values.sessionMode).toEqual({ goal: null, plan: true });
	});

	test("a mode entry folded live publishes the switch", () => {
		const r = registry();
		r.seed("s1", { entries: [] });
		expect(r.snapshot("s1")?.values.sessionMode).toEqual({ goal: null, plan: false });

		const changes = r.applyEvent("s1", { type: "entry", entry: modeEntry("plan", { planFilePath: "local://P.md" }) });
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ key: "sessionMode", value: { goal: null, plan: true } });
	});

	test("leaving a mode clears it", () => {
		const r = registry();
		r.seed("s1", { entries: [modeEntry("goal", { goal: GOAL })] });
		expect(r.snapshot("s1")?.values.sessionMode).toMatchObject({ goal: { objective: "ship it" } });

		r.applyEvent("s1", { type: "entry", entry: modeEntry("none") });
		expect(r.snapshot("s1")?.values.sessionMode).toEqual({ goal: null, plan: false });
	});

	test("plan without a path counts as off", () => {
		// The proposal/approve flow cannot complete without a path.
		const r = registry();
		r.seed("s1", { entries: [modeEntry("plan", {})] });
		expect(r.snapshot("s1")?.values.sessionMode).toEqual({ goal: null, plan: false });
	});

	test("a paused goal is not an active goal", () => {
		const r = registry();
		r.seed("s1", { entries: [modeEntry("goal_paused", { goal: GOAL })] });
		expect(r.snapshot("s1")?.values.sessionMode).toEqual({ goal: null, plan: false });
	});

	test("an unrelated entry publishes nothing", () => {
		const r = registry();
		r.seed("s1", { entries: [] });
		const changes = r.applyEvent("s1", {
			type: "entry",
			entry: { type: "message", id: "m", parentId: null, timestamp: "" } as unknown as SessionEntry,
		});
		expect(changes).toEqual([]);
	});

	test("an unrelated event type publishes nothing", () => {
		const r = registry();
		r.seed("s1", { entries: [modeEntry("plan", { planFilePath: "local://P.md" })] });
		expect(r.applyEvent("s1", { type: "turn_end" } as never)).toEqual([]);
	});

	test("a malformed goal record restores nothing", () => {
		const r = registry();
		r.seed("s1", { entries: [modeEntry("goal", { goal: { id: "x" } })] });
		expect(r.snapshot("s1")?.values.sessionMode).toEqual({ goal: null, plan: false });
	});
});
