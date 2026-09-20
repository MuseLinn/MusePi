import { describe, expect, test } from "bun:test";
import { DROWSY_AFTER_MS, moodOfState, PET_STATES, type PetState, STATE_MOOD, stateFromSignals } from "../src/lib/pet";
import { EFFECT_LAYER, effectsForState, PET_EFFECTS, STATE_EFFECTS } from "../src/lib/pet-effects";
import { STATE_DIRECTION, stateDirection } from "../src/lib/pet-face";
import { MOOD_MOTION, STATE_MOTION } from "../src/lib/pet-motion";

/**
 * The 31-state axis is four tables that must stay in lockstep — a state added
 * to PET_STATES but missing from the motion or face table silently falls back
 * to `idle` and looks like a bug in the renderer rather than a hole in the
 * data. These tests are the lockstep check.
 */

describe("PetState — table coverage", () => {
	test("the vocabulary is 31 states with no duplicates", () => {
		expect(PET_STATES.length).toBe(31);
		expect(new Set(PET_STATES).size).toBe(31);
	});

	test("every state has a body motion", () => {
		const missing = PET_STATES.filter(s => !STATE_MOTION[s]);
		expect(missing).toEqual([]);
	});

	test("every state has a face direction", () => {
		const missing = PET_STATES.filter(s => !STATE_DIRECTION[s]);
		expect(missing).toEqual([]);
	});

	test("every state collapses onto a legal legacy mood", () => {
		const legal = new Set(Object.keys(MOOD_MOTION));
		for (const s of PET_STATES) expect(legal.has(STATE_MOOD[s])).toBe(true);
	});

	test("no stray keys in the motion / face / effect tables", () => {
		const known = new Set<string>(PET_STATES);
		expect(Object.keys(STATE_MOTION).filter(k => !known.has(k))).toEqual([]);
		expect(Object.keys(STATE_DIRECTION).filter(k => !known.has(k))).toEqual([]);
		expect(Object.keys(STATE_EFFECTS).filter(k => !known.has(k))).toEqual([]);
	});

	test("a state that needs concentration does not blink", () => {
		for (const s of ["thinking", "working", "searching", "radar", "alerting"] as PetState[]) {
			expect(STATE_DIRECTION[s].blinkMs).toBe(0);
		}
	});
});

describe("stateFromSignals — priority chain", () => {
	test("a failure outranks live work — an agent blocked on an error is not working", () => {
		expect(stateFromSignals({ working: true, streaming: true, toolFailed: true })).toBe("alerting");
	});

	test("ambiguity is a different state from failure", () => {
		expect(stateFromSignals({ ambiguous: true })).toBe("confused");
		expect(stateFromSignals({ toolFailed: true, ambiguous: true })).toBe("alerting");
	});

	test("streaming is writing, silent work is working", () => {
		expect(stateFromSignals({ working: true, streaming: true })).toBe("writing");
		expect(stateFromSignals({ working: true })).toBe("working");
	});

	test("a pending approval is the loudest thing waiting on the user", () => {
		expect(stateFromSignals({ approvals: 1 })).toBe("notifying");
		expect(stateFromSignals({ unread: 3 })).toBe("notifying");
	});

	test("pointer and lifecycle states beat the session reading", () => {
		expect(stateFromSignals({ dragging: true, toolFailed: true })).toBe("dragging");
		expect(stateFromSignals({ spawning: true, working: true })).toBe("spawning");
	});

	test("idleness decays to drowsy only after the threshold", () => {
		expect(stateFromSignals({ idleMs: DROWSY_AFTER_MS - 1 })).toBe("idle");
		expect(stateFromSignals({ idleMs: DROWSY_AFTER_MS })).toBe("drowsy");
	});

	test("emotions are gated on a result, never on nothing happening", () => {
		expect(stateFromSignals({ justFinished: true })).toBe("celebrate");
		expect(stateFromSignals({})).toBe("idle");
		expect(stateFromSignals()).toBe("idle");
	});

	test("moodOfState falls back to rest for anything unknown", () => {
		expect(moodOfState("working")).toBe("working");
		expect(moodOfState("nope")).toBe("rest");
		expect(moodOfState(null)).toBe("rest");
	});
});

describe("effects — state mapping and size tiers", () => {
	test("every mapped effect is a real kind with a rig layer", () => {
		const kinds = new Set<string>(PET_EFFECTS);
		for (const list of Object.values(STATE_EFFECTS)) {
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
		expect(STATE_MOTION.sending.dash).toEqual([66, 1500]);
		expect(STATE_MOTION.receiving.dash).toEqual([66, -1500]);
		expect(STATE_MOTION.sending.scale).toBe(0.21);
		expect(STATE_MOTION.receiving.scale).toBe(0.21);
	});

	// thinking-dots' motion table is EMPTY on purpose: the dots effect
	// dissolves the shared body group itself; a motion scale would compound.
	test("thinking-dots delegates its body yield to the dots effect", () => {
		expect(STATE_MOTION["thinking-dots"]).toEqual({});
		expect(STATE_EFFECTS["thinking-dots"]).toContain("dots");
	});

	test("alerting and confused share the glyph slot with opposite marks", () => {
		expect(STATE_EFFECTS.alerting).toEqual(["glyph"]);
		expect(STATE_EFFECTS.confused).toEqual(["glyph"]);
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

	test("stateDirection falls back to rest rather than throwing", () => {
		expect(stateDirection("working").eyes).toBe("tense");
		expect(stateDirection("nope").eyes).toBe("open");
	});
});
