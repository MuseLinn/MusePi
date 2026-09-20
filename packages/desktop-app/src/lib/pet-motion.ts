/**
 * Pet body-motion spec — how the silhouette itself moves, per mood.
 *
 * The face engine on its own leaves the body perfectly still, which reads as
 * dead. Each mood gets a small set of numbers describing *how* it moves, and
 * {@link motionTransform} turns them into a transform for the current frame.
 *
 * Why data instead of CSS keyframes: a state's motion has to be tunable in one
 * place, has to compose (a bob can squash, a sway can carry a tilt), and has to
 * be readable by a renderer that seeks to an arbitrary time instead of ticking.
 * Hand-written keyframes give none of that, and 20 moods × 5 motions is 100
 * keyframe blocks.
 *
 * Units: amplitude is in face units (FACE_BOX = 228.541, so 6 ≈ 2.6% of the
 * box), periods in milliseconds, angles in degrees.
 */

export interface BodyMotion {
	/** Vertical travel: [amplitude, period]. */
	bob?: [number, number];
	/** Rotation: [degrees, period]. */
	sway?: [number, number];
	/** Uniform scale oscillation — breathing: [fraction, period]. */
	pulse?: [number, number];
	/** Orbital drift: [radius, period]. */
	circle?: [number, number];
	/** Fast nervous shake: [amplitude, period]. */
	jitter?: [number, number];
	/** Constant lean, degrees. */
	tilt?: number;
	/** 0…1 — how much a bob squashes the body at the bottom of its arc. */
	squash?: number;
	/** One-shot on entering the mood: [starting scale, duration ms]. */
	enter?: [number, number];
	/** Scale it eases to and holds — exits. */
	settle?: number;
	/** Constant resting scale (buys room for orbiting effects). */
	scale?: number;
}

/** How long a `settle` takes to reach its resting scale. */
export const SETTLE_MS = 1400;

/** The 7-mood axis the app speaks. Values are deliberately calm: this pet
 *  lives in a chat composer, and a mascot that bounces while you type is a
 *  mascot you turn off. Idle states breathe; only the loud states swing. */
export const MOOD_MOTION: Record<string, BodyMotion> = {
	rest: { pulse: [0.018, 4200] },
	hover: { bob: [3.2, 1500], pulse: [0.012, 1500] },
	waiting: { pulse: [0.02, 5400], tilt: 1.6 },
	analyzing: { sway: [2.4, 2600], pulse: [0.012, 2600] },
	working: { bob: [2.4, 880], squash: 0.26 },
	dragging: { tilt: -7, sway: [3.4, 820] },
	error: { jitter: [1.1, 110], tilt: 2 },
};

/**
 * Body motion for the user-initiated reactions (see pet-face.ts
 * PET_INTERACTIONS) — the same data contract as a mood, keyed on the second
 * axis. These are the ONLY entries allowed to be loud: they fire on a user
 * gesture and resolve in about a second, so an overshoot entrance reads as
 * "it felt that" rather than as a fidget.
 *
 * `enter` is doing most of the work: 0.86 → 1 on an ease-out-back is the
 * recoil-and-settle of something that just got poked, and it decays on its
 * own, so the gesture needs no exit animation in the caller.
 */
export const INTERACTION_MOTION: Record<string, BodyMotion> = {
	// The flinch: a quick pop outward, then a nervous shimmer as it settles.
	startled: { enter: [1.14, 480], jitter: [0.9, 130], scale: 1.04 },
	// The pleased wobble: a small bouncy double-take, no jitter (happy motion
	// should look springy, not shaky).
	delighted: { enter: [0.92, 520], bob: [2.6, 620], squash: 0.22 },
	// The head-tilt: hold a lean toward whatever caught its attention.
	curious: { tilt: -6, pulse: [0.014, 3000] },
	// Pre-sleep: a long, deep, slow breath — the body sinking.
	dozing: { pulse: [0.03, 6400], tilt: 2.4, scale: 0.985 },
	// Caught in the act: a small guilty start, then still.
	peek: { enter: [1.06, 420], tilt: -3.2, pulse: [0.01, 3600] },
};

const easeOutBack = (t: number): number => {
	const c = 1.7;
	const u = t - 1;
	return 1 + (c + 1) * u * u * u + c * u * u;
};

const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t));

/**
 * Build the body's transform for this frame. `elapsed` is time since the
 * mood was entered (one-shot entrances need it); loops read it too so two
 * pets on screen never pulse in lockstep. `strength` is the user's motion
 * preference — 0 holds the body perfectly still.
 */
export function motionTransform(motion: BodyMotion, elapsed: number, strength: number, box: number): string {
	if (strength <= 0) return "";
	const centre = box / 2;
	const ground = box;
	const wave = (period: number, phase = 0): number => Math.sin((elapsed / period) * Math.PI * 2 + phase);

	let dx = 0;
	let dy = 0;
	let rotation = motion.tilt ? motion.tilt * strength : 0;
	let scale = 1;
	let sx = 1;
	let sy = 1;

	if (motion.bob) {
		const [amplitude, period] = motion.bob;
		const p = wave(period);
		dy -= amplitude * strength * p;
		if (motion.squash) {
			// Squash at the bottom of the arc, stretch at the top. Volume conserved.
			const amount = motion.squash * strength * Math.max(0, -p);
			sy = 1 - amount * 0.5;
			sx = 1 + amount * 0.5;
		}
	}
	if (motion.circle) {
		const [radius, period] = motion.circle;
		dx += radius * strength * wave(period);
		dy += radius * strength * wave(period, Math.PI / 2);
	}
	if (motion.sway) {
		const [degrees, period] = motion.sway;
		rotation += degrees * strength * wave(period);
	}
	if (motion.pulse) {
		const [fraction, period] = motion.pulse;
		scale *= 1 + fraction * strength * wave(period);
	}
	if (motion.jitter) {
		const [amplitude, period] = motion.jitter;
		// Two incommensurate waves read as nervous rather than metronomic.
		dx += amplitude * strength * wave(period);
		dy += amplitude * strength * wave(period * 0.63, 1.1);
	}
	if (motion.enter) {
		const [from, duration] = motion.enter;
		const t = elapsed / duration;
		scale *= t >= 1 ? 1 : from + (1 - from) * easeOutBack(Math.max(t, 0));
	}
	if (motion.settle !== undefined) {
		const t = Math.min(Math.max(elapsed / SETTLE_MS, 0), 1);
		scale *= 1 + (motion.settle - 1) * easeInOut(t) * strength;
	}
	if (motion.scale !== undefined) scale *= 1 + (motion.scale - 1) * strength;

	const parts: string[] = [];
	if (dx || dy) parts.push(`translate(${dx.toFixed(2)} ${dy.toFixed(2)})`);
	if (rotation) parts.push(`rotate(${rotation.toFixed(2)} ${centre} ${centre})`);
	if (scale !== 1) {
		parts.push(`translate(${centre} ${centre}) scale(${scale.toFixed(4)}) translate(${-centre} ${-centre})`);
	}
	if (sx !== 1 || sy !== 1) {
		// Squash pivots on the ground, not the middle — otherwise the pet
		// floats instead of landing.
		parts.push(
			`translate(${centre} ${ground}) scale(${sx.toFixed(4)} ${sy.toFixed(4)}) translate(${-centre} ${-ground})`,
		);
	}
	return parts.join(" ");
}

/**
 * Idle gaze drift ("saccade"): a slow wander around the mood's resting look
 * point, with two quick darts per cycle. Eyes that only ever sit still read
 * as a texture; eyes that dart read as a creature deciding what to look at.
 * Coordinates are multipliers of GAZE_TRAVEL, so this is renderer-agnostic.
 */
export function gazeDrift(elapsed: number, base: number): { x: number; y: number } {
	const t = elapsed / 1000;
	const wander = Math.sin(t * 0.52) * 0.55 + Math.sin(t * 0.23 + 1.7) * 0.3;
	// Two darts per 9s, each a fast step that then holds.
	const dart = Math.max(0, Math.sin((elapsed / 9000) * Math.PI * 2));
	const x = base + wander * 0.22 + (dart > 0.96 ? 0.3 : 0);
	const y = Math.sin(t * 0.37 + 0.9) * 0.28;
	return { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) };
}
