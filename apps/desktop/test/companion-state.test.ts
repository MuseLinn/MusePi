import { describe, expect, test } from "bun:test";
import {
	aggregateCompanionMood,
	aggregateCompanionState,
	COMPANION_STATE_TO_SPRITE_MOOD,
	COMPANION_STATES,
	type CompanionSessionCard,
	type CompanionState,
	companionMoodOfState,
	companionStateFromSignals,
	DROWSY_AFTER_MS,
	spriteMoodOfState,
} from "../src/lib/companion";
import {
	COMPANION_EFFECTS,
	COMPANION_STATE_EFFECTS,
	EFFECT_LAYER,
	effectsForState,
} from "../src/lib/companion-effects";
import { COMPANION_STATE_DIRECTION, companionStateDirection } from "../src/lib/companion-face";
import { COMPANION_MOOD_MOTION, COMPANION_STATE_MOTION } from "../src/lib/companion-motion";

/**
 * The 31-state axis is four tables that must stay in lockstep — a state added
 * to COMPANION_STATES but missing from the motion or face table silently falls back
 * to `idle` and looks like a bug in the renderer rather than a hole in the
 * data. These tests are the lockstep check.
 */

describe("CompanionState — table coverage", () => {
	test("the vocabulary is 31 states with no duplicates", () => {
		expect(COMPANION_STATES.length).toBe(31);
		expect(new Set(COMPANION_STATES).size).toBe(31);
	});

	test("every state has a body motion", () => {
		const missing = COMPANION_STATES.filter(s => !COMPANION_STATE_MOTION[s]);
		expect(missing).toEqual([]);
	});

	test("every state has a face direction", () => {
		const missing = COMPANION_STATES.filter(s => !COMPANION_STATE_DIRECTION[s]);
		expect(missing).toEqual([]);
	});

	test("every state collapses onto a legal legacy mood", () => {
		const legal = new Set(Object.keys(COMPANION_MOOD_MOTION));
		for (const s of COMPANION_STATES) expect(legal.has(COMPANION_STATE_TO_SPRITE_MOOD[s])).toBe(true);
	});

	test("no stray keys in the motion / face / effect tables", () => {
		const known = new Set<string>(COMPANION_STATES);
		expect(Object.keys(COMPANION_STATE_MOTION).filter(k => !known.has(k))).toEqual([]);
		expect(Object.keys(COMPANION_STATE_DIRECTION).filter(k => !known.has(k))).toEqual([]);
		expect(Object.keys(COMPANION_STATE_EFFECTS).filter(k => !known.has(k))).toEqual([]);
	});

	test("a state that needs concentration does not blink", () => {
		for (const s of ["thinking", "working", "searching", "radar", "alerting"] as CompanionState[]) {
			expect(COMPANION_STATE_DIRECTION[s].blinkMs).toBe(0);
		}
	});
});

describe("companionStateFromSignals — priority chain", () => {
	test("a failure outranks live work — an agent blocked on an error is not working", () => {
		expect(companionStateFromSignals({ working: true, streaming: true, toolFailed: true })).toBe("alerting");
	});

	test("ambiguity is a different state from failure", () => {
		expect(companionStateFromSignals({ ambiguous: true })).toBe("confused");
		expect(companionStateFromSignals({ toolFailed: true, ambiguous: true })).toBe("alerting");
	});

	test("streaming is writing, silent work is working", () => {
		expect(companionStateFromSignals({ working: true, streaming: true })).toBe("writing");
		expect(companionStateFromSignals({ working: true })).toBe("working");
	});

	test("a pending approval is the loudest thing waiting on the user", () => {
		expect(companionStateFromSignals({ approvals: 1 })).toBe("notifying");
		expect(companionStateFromSignals({ unread: 3 })).toBe("notifying");
	});

	test("pointer and lifecycle states beat the session reading", () => {
		expect(companionStateFromSignals({ dragging: true, toolFailed: true })).toBe("dragging");
		expect(companionStateFromSignals({ spawning: true, working: true })).toBe("spawning");
	});

	test("idleness decays to drowsy only after the threshold", () => {
		expect(companionStateFromSignals({ idleMs: DROWSY_AFTER_MS - 1 })).toBe("idle");
		expect(companionStateFromSignals({ idleMs: DROWSY_AFTER_MS })).toBe("drowsy");
	});

	test("emotions are gated on a result, never on nothing happening", () => {
		expect(companionStateFromSignals({ justFinished: true })).toBe("celebrate");
		expect(companionStateFromSignals({})).toBe("idle");
		expect(companionStateFromSignals()).toBe("idle");
	});

	test("spriteMoodOfState falls back to rest for anything unknown", () => {
		expect(spriteMoodOfState("working")).toBe("working");
		expect(spriteMoodOfState("nope")).toBe("rest");
		expect(spriteMoodOfState(null)).toBe("rest");
	});
});

describe("effects — state mapping and size tiers", () => {
	test("every mapped effect is a real kind with a rig layer", () => {
		const kinds = new Set<string>(COMPANION_EFFECTS);
		for (const list of Object.values(COMPANION_STATE_EFFECTS)) {
			for (const e of list) {
				expect(kinds.has(e)).toBe(true);
				expect(["behind", "front", "both"]).toContain(EFFECT_LAYER[e]);
			}
		}
	});

	// The body IS the flying dot (blobstudio-measured): a full-size ball
	// would swallow its own wake. The motion table and the effects DashSpec
	// must quote the same flight line, or the tails detach from the body.
	test("sending/receiving ride the dash flight their tails are drawn on", () => {
		expect(COMPANION_STATE_MOTION.sending.dash).toEqual([66, 1500]);
		expect(COMPANION_STATE_MOTION.receiving.dash).toEqual([66, -1500]);
		expect(COMPANION_STATE_MOTION.sending.scale).toBe(0.21);
		expect(COMPANION_STATE_MOTION.receiving.scale).toBe(0.21);
	});

	// thinking-dots' motion table is EMPTY on purpose: the dots effect
	// dissolves the shared body group itself; a motion scale would compound.
	test("thinking-dots delegates its body yield to the dots effect", () => {
		expect(COMPANION_STATE_MOTION["thinking-dots"]).toEqual({});
		expect(COMPANION_STATE_EFFECTS["thinking-dots"]).toContain("dots");
	});

	test("alerting and confused share the glyph slot with opposite marks", () => {
		expect(COMPANION_STATE_EFFECTS.alerting).toEqual(["glyph"]);
		expect(COMPANION_STATE_EFFECTS.confused).toEqual(["glyph"]);
	});

	test("compact drops the fine detail and keeps shape-and-colour effects", () => {
		expect(effectsForState("celebrate", "full")).toContain("confetti");
		expect(effectsForState("celebrate", "compact")).not.toContain("confetti");
		expect(effectsForState("thinking", "compact")).toContain("dots");
	});

	test("micro keeps only the badge — everything else is sub-pixel", () => {
		expect(effectsForState("notifying", "micro")).toEqual(["badge"]);
		expect(effectsForState("celebrate", "micro")).toEqual([]);
		expect(effectsForState("thinking", "micro")).toEqual([]);
	});

	test("an unknown or absent state plays nothing", () => {
		expect(effectsForState("nope", "full")).toEqual([]);
		expect(effectsForState(null, "full")).toEqual([]);
	});

	test("companionStateDirection falls back to rest rather than throwing", () => {
		expect(companionStateDirection("working").eyes).toBe("tense");
		expect(companionStateDirection("nope").eyes).toBe("open");
	});
});

describe("multi-session companion aggregation", () => {
	const card = (mood: CompanionSessionCard["mood"], state: CompanionState): CompanionSessionCard => ({
		sessionId: state,
		title: state,
		phase: state === "alerting" ? "error" : state === "celebrate" ? "done" : "working",
		statusText: "",
		mood,
		companionState: state,
	});

	test("waiting outranks analyzing, which outranks ordinary work", () => {
		expect(
			aggregateCompanionMood([
				card("working", "working"),
				card("analyzing", "thinking"),
				card("waiting", "notifying"),
			]),
		).toBe("waiting");
		expect(aggregateCompanionMood([card("working", "working"), card("analyzing", "thinking")])).toBe("analyzing");
		expect(aggregateCompanionMood([card("working", "working"), card("rest", "celebrate")])).toBe("working");
		expect(aggregateCompanionMood([card("error", "alerting")])).toBe("error");
		expect(aggregateCompanionMood([], "rest")).toBe("rest");
	});

	test("waiting outranks live work, which outranks errors and results", () => {
		expect(aggregateCompanionState([card("working", "working"), card("waiting", "notifying")])).toBe("notifying");
		expect(aggregateCompanionState([card("working", "working"), card("error", "alerting")])).toBe("working");
		expect(aggregateCompanionState([card("working", "working"), card("rest", "celebrate")])).toBe("working");
		expect(aggregateCompanionState([card("rest", "celebrate")], "idle")).toBe("celebrate");
		expect(aggregateCompanionState([], "idle")).toBe("idle");
	});

	test("rich states collapse onto the legacy mood axis", () => {
		expect(companionMoodOfState("searching")).toBe("analyzing");
		expect(companionMoodOfState("writing")).toBe("working");
		expect(companionMoodOfState("celebrate")).toBe("rest");
		expect(companionMoodOfState("dragging")).toBe("working");
	});
});
