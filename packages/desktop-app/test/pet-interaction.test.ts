import { describe, expect, test } from "bun:test";
import {
	GAZE_TRAVEL,
	INTERACTION_HOLD_MS,
	interactionDirection,
	moodDirection,
	PET_INTERACTIONS,
	PET_MOODS,
} from "../src/lib/pet-face";
import { INTERACTION_MOTION, MOOD_MOTION } from "../src/lib/pet-motion";

/**
 * The pet speaks TWO axes: `PetMood` is the agent's state (a session
 * contract, written by the store), and `PetInteraction` is a user gesture
 * (transient, never stored). These tests pin the boundary between them,
 * because the failure mode of getting it wrong is silent — a reaction that
 * leaks into the session state, or a mood class lost during a reaction
 * (which would reset the error face's red eye, a pure-CSS material).
 */

describe("pet interaction axis — registered data", () => {
	test("every interaction has both a face direction and a body motion", () => {
		// A reaction defined in only one of the two tables would render as
		// half a reaction: a face with a frozen body, or vice versa.
		for (const it of PET_INTERACTIONS) {
			expect(interactionDirection(it).eyes).toBeDefined();
			expect(INTERACTION_MOTION[it]).toBeDefined();
		}
	});

	test("the two axes do not share names (an override must be unambiguous)", () => {
		const moods = new Set<string>(PET_MOODS);
		for (const it of PET_INTERACTIONS) {
			expect(moods.has(it)).toBe(false);
		}
	});

	test("an unknown interaction falls back to the rest face, not a crash", () => {
		// The caller passes a string from a data table; a future interaction
		// name reaching an older build must degrade, not throw.
		expect(interactionDirection("does-not-exist")).toEqual(moodDirection("rest"));
	});
});

describe("pet interaction axis — reactions are reactions, not moods", () => {
	test("startled holds its gape: no blink", () => {
		// A blink mid-startle reads as a wink — the flinch has to hold.
		expect(interactionDirection("startled").blinkMs).toBe(0);
		expect(interactionDirection("startled").eyes).toBe("wide");
	});

	test("dozing blinks far more slowly than rest", () => {
		// The eyes should be mostly shut; a normal cadence would read awake.
		const dozing = interactionDirection("dozing").blinkMs;
		const rest = moodDirection("rest").blinkMs;
		expect(dozing).toBeGreaterThan(rest);
	});

	test("every distraction state looks OFF-centre (look is never 0 except startle)", () => {
		// Curious / dozing / peek are all "attention went somewhere else";
		// a centred look would read as staring straight ahead, which is the
		// resting face and therefore no reaction at all.
		for (const it of ["curious", "dozing", "peek"] as const) {
			expect(Math.abs(interactionDirection(it).look)).toBeGreaterThan(0.2);
		}
		// Startle is the exception and must stay centred — it is being
		// surprised by something IN FRONT of it.
		expect(interactionDirection("startled").look).toBe(0);
	});

	test("the strongest look bias stays within the gaze travel budget", () => {
		// `look` is a FRACTION of GAZE_TRAVEL, so any |look| > 1 would push
		// the eyes past the authored travel and out of the shell's lit band.
		for (const it of PET_INTERACTIONS) {
			expect(Math.abs(interactionDirection(it).look)).toBeLessThanOrEqual(1);
		}
		// Sanity: the travel the fractions multiply into is the tuned value.
		expect(GAZE_TRAVEL.x).toBeGreaterThan(13.2);
	});
});

describe("pet interaction axis — body motion", () => {
	test("only the poke reactions may be loud (enter is the recoil)", () => {
		// Idle moods are deliberately calm (a mascot that bounces while you
		// type is one you turn off). Reactions fire on a user gesture and
		// resolve in about a second, so they are the only entries allowed an
		// overshoot entrance.
		expect(INTERACTION_MOTION.startled?.enter).toBeDefined();
		expect(INTERACTION_MOTION.delighted?.enter).toBeDefined();
		expect(INTERACTION_MOTION.peek?.enter).toBeDefined();
		// The sustained idle-ish reactions must NOT pop — curious is a held
		// lean and dozing is a wind-down, neither is an event.
		expect(INTERACTION_MOTION.curious?.enter).toBeUndefined();
		expect(INTERACTION_MOTION.dozing?.enter).toBeUndefined();
		// And no mood gained an entrance (the axis boundary again).
		for (const m of PET_MOODS) {
			expect(MOOD_MOTION[m]?.enter).toBeUndefined();
		}
	});

	test("delighted is a bounce, not a shake (no jitter)", () => {
		// Startle is the nervous one; pleasure should look springy. Sharing
		// the jitter between them would collapse the two reactions into one.
		expect(INTERACTION_MOTION.startled?.jitter).toBeDefined();
		expect(INTERACTION_MOTION.delighted?.jitter).toBeUndefined();
		expect(INTERACTION_MOTION.delighted?.bob).toBeDefined();
	});

	test("dozing is the slowest, deepest breath in the whole system", () => {
		const dozing = INTERACTION_MOTION.dozing?.pulse;
		expect(dozing).toBeDefined();
		const [amplitude, period] = dozing!;
		// Deeper than rest's 0.018…
		expect(amplitude).toBeGreaterThan(MOOD_MOTION.rest!.pulse![0]);
		// …and slower than every mood.
		for (const m of PET_MOODS) {
			const pulse = MOOD_MOTION[m]?.pulse;
			if (pulse) expect(period).toBeGreaterThan(pulse[1]);
		}
	});
});

describe("pet interaction axis — hold time", () => {
	test("a reaction releases on its own clock, fast enough to feel responsive", () => {
		// Too short and the face barely lands; too long and the pet stops
		// feeling like it is tracking the live agent mood underneath.
		expect(INTERACTION_HOLD_MS).toBeGreaterThan(600);
		expect(INTERACTION_HOLD_MS).toBeLessThan(2500);
	});
});
