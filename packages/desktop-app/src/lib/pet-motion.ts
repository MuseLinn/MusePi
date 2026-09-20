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
	/** Lissajous flight: [radius, period]. A negative period flies the path
	 *  backwards (receiving). The pet-effects dash tails sample the SAME
	 *  path via {@link dashPoint}, so the body is the comet's head and the
	 *  tails trail it — keep radius/period in lockstep with the effects'
	 *  DashSpec, and keep the scale small (0.21) so the body reads as the
	 *  flying dot rather than a ball swallowing its own wake. */
	dash?: [number, number];
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
 * Body motion per SESSION STATE (pet.ts PetState) — 31 entries where the old
 * MOOD_MOTION had 7.
 *
 * The numbers that came from blobstudio / OpenMausBot are ported as measured
 * (`orbit` really is circle 6 over 3200ms at scale .72; `radar` really is a
 * 6° sway over 2400ms with a .012 pulse; `progress` really is a .022 pulse
 * over 1600ms). Everything else is derived from the same rule the seven moods
 * already followed: **idle states breathe, working states swing, and only a
 * result is allowed to bounce.**
 *
 * Two structural notes:
 *  - `scale` below is not decoration. `orbit`/`radar` shrink the body
 *    because their EFFECT needs the room — a comet tail at radius 114 on a
 *    full-size body is clipped by the rig — and `sending`/`receiving`
 *    shrink to 21% precisely so the body reads as the flying dot its dash
 *    tails trail (blobstudio-measured; a full-size ball would swallow its
 *    own wake). `thinking-dots` is the exception that proves the rule: its
 *    motion table is EMPTY because the dots effect drives the shared body
 *    group itself (pet-effects bodyRef); a motion scale here would
 *    compound with it and double-shrink.
 *  - `settle` is an exit, not a loop: `powering-down` eases to 12% and holds
 *    there, which is the pet window's close animation. It is only reachable
 *    for as long as the state is held — switching away recomputes scale.
 *
 * MOOD_MOTION below stays as the legacy 7-mood fallback for hosts that have
 * not moved to the state axis yet.
 */
export const STATE_MOTION: Record<string, BodyMotion> = {
	// ── A. the turn loop
	// Idle: the slow breath. Everything else is measured against this.
	idle: { pulse: [0.018, 4200] },
	// Listening: the breath, plus a small lean toward the user.
	listening: { pulse: [0.014, 3600], tilt: -1.5 },
	// Thinking: a slow reading sway — the head moving across a page.
	thinking: { sway: [2.4, 2600], pulse: [0.012, 2600] },
	// Working: the effort bob, squashing at the bottom of its arc.
	working: { bob: [2.4, 880], squash: 0.26 },
	// Searching: a wider, faster sweep — it is covering ground.
	searching: { sway: [4, 1800], pulse: [0.012, 1800] },
	// Writing: the tightest, quickest motion in the set — a hand moving.
	writing: { bob: [1.4, 620], squash: 0.18 },
	// ── B. transfer — blobstudio-measured: the body shrinks to a flying dot
	// and RIDES its dash path; the comet tails in pet-effects are drawn on
	// the same flight line, so radius/period must stay in lockstep with the
	// effects' DASH_SPEC (66 / ±1500).
	sending: { dash: [66, 1500], scale: 0.21 },
	// Receiving: the same flight, backwards (negative period).
	receiving: { dash: [66, -1500], scale: 0.21 },
	// Uploading: pushing upward at the arc's reading scale.
	uploading: { bob: [3, 1000], scale: 0.74 },
	loading: { sway: [2.2, 1500], pulse: [0.012, 1500], scale: 0.72 },
	// ── C. progress
	progress: { pulse: [0.022, 1600], scale: 0.74 },
	// Orbit: the body itself drifts a slow circle — the loop IS the message.
	orbit: { circle: [6, 3200], scale: 0.72 },
	// Radar: a sweep with a pulse riding it, at scanning scale.
	radar: { sway: [6, 2400], pulse: [0.012, 2400], scale: 0.72 },
	// Thinking-dots: EMPTY on purpose — the dots effect itself dissolves the
	// body (pet-effects splitAmount drives the bodyRef transform+opacity);
	// a motion scale here would compound with it.
	"thinking-dots": {},
	// Humming: a contented slow bob, the quietest "alive" state.
	humming: { bob: [1.8, 2400], pulse: [0.014, 2400] },
	// ── D. notification / input
	notifying: { pulse: [0.02, 5400], tilt: 1.6 },
	// Alerting: the nervous shimmer — the only state allowed to jitter.
	alerting: { jitter: [1.1, 110], tilt: 2 },
	// Dictating: transcribing has a rhythm, so a mid-tempo sway.
	dictating: { sway: [3.2, 1400], pulse: [0.016, 1400] },
	// ── E. emotion — all one-shot arrivals, all decaying (see PET_STATES).
	excited: { enter: [1.06, 440], bob: [3, 480] },
	happy: { bob: [2.6, 620], squash: 0.22 },
	celebrate: { enter: [0.9, 560], bob: [3.6, 520], squash: 0.26 },
	// Confused: a wobbly head-shake, no bounce (nothing was achieved).
	confused: { sway: [2.6, 1300], tilt: 2.5 },
	curious: { tilt: -6, pulse: [0.014, 3000] },
	// Proud: held, lifted, still — the opposite of a bounce.
	proud: { tilt: -1.5, scale: 1.02, pulse: [0.012, 3000] },
	shy: { tilt: 3, scale: 0.97, pulse: [0.018, 3600] },
	playful: { bob: [3.4, 700], squash: 0.24 },
	// ── F. lifecycle
	// Spawning: arriving from small with an ease-out-back overshoot.
	spawning: { enter: [0.55, 620] },
	// Powering-down: the collapse — eases to 12% over SETTLE_MS and holds.
	"powering-down": { tilt: 4, settle: 0.12 },
	bouncing: { bob: [5.2, 560], squash: 0.3 },
	dragging: { tilt: -7, sway: [3.4, 820] },
	// Drowsy: the deepest, slowest breath in the table.
	drowsy: { pulse: [0.03, 6400], tilt: 2.4, scale: 0.985 },
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
	// Awe: a happy lift that settles into a proud hold.
	starstruck: { enter: [1.08, 520], bob: [2.2, 700], scale: 1.02 },
	// "Hm, let me see": a held thoughtful lean, no pop (sustained, like curious).
	thinking: { tilt: -4.5, pulse: [0.012, 3400] },
	// The hello: a springy double-bounce.
	greeting: { enter: [0.94, 480], bob: [3.2, 560], squash: 0.2 },
	// The win: the biggest bounce in the set.
	celebrate: { enter: [0.9, 560], bob: [3.6, 520], squash: 0.26 },
	// The "?": a wobbly head-shake.
	confused: { sway: [2.6, 1300], tilt: 2.5 },
	// Aww: making itself small, leaning away.
	shy: { tilt: 3, scale: 0.97, pulse: [0.018, 3600] },
	// Anticipation: quick little hops.
	excited: { enter: [1.06, 440], bob: [3, 480] },
	// The narrowed stare: a slow lean, nothing bouncy.
	suspicious: { tilt: -2.5, sway: [1.6, 2200] },
	// Woozy: rolling with the dizzy rings.
	dizzy: { sway: [3.5, 950], tilt: 3.5 },
};

const easeOutBack = (t: number): number => {
	const c = 1.7;
	const u = t - 1;
	return 1 + (c + 1) * u * u * u + c * u * u;
};

const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t));

/**
 * The dash flight path (blobstudio-measured): a Lissajous figure-of-eight,
 * flattened to 44% vertical so the loop stays inside the rig. Radius is in
 * face units, period in ms; a negative period runs the path backwards.
 *
 * Shared by TWO renderers that must agree per frame — the body motion
 * ({@link motionTransform} translates the body to this point) and the
 * pet-effects dash tails (which sample the same path behind it). That is
 * why it lives here and not in pet-effects: one function, one flight line.
 */
export function dashPoint(radius: number, period: number, elapsed: number): { x: number; y: number } {
	const a = (elapsed / period) * Math.PI * 2;
	return { x: Math.cos(a) * radius, y: Math.sin(a * 2) * radius * 0.44 };
}

/**
 * Build the body's transform for this frame. `elapsed` is the PERSISTENT
 * loop clock — it keeps running across mood/interaction switches so sine
 * loops never jump mid-arc; `entryElapsed` is time since the current state
 * was entered and drives the one-shot entrances (`enter`/`settle`), which
 * must replay per arrival. Defaults to `elapsed` for callers that don't
 * track an entry clock. `strength` is the user's motion preference — 0
 * holds the body perfectly still.
 */
export function motionTransform(
	motion: BodyMotion,
	elapsed: number,
	strength: number,
	box: number,
	entryElapsed: number = elapsed,
): string {
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
	if (motion.dash) {
		// The body flies its own dash path so the pet-effects comet tails
		// (sampled from the same dashPoint) trail it instead of chasing it.
		// Rides the ENTRY clock, like the tails do: both renderers must
		// agree on where in the flight the state currently is, and the
		// persistent phase clock would leave them at different loop points
		// after every state switch.
		const [radius, period] = motion.dash;
		const p = dashPoint(radius * strength, period, entryElapsed);
		dx += p.x;
		dy += p.y;
	}
	if (motion.enter) {
		const [from, duration] = motion.enter;
		const t = entryElapsed / duration;
		scale *= t >= 1 ? 1 : from + (1 - from) * easeOutBack(Math.max(t, 0));
	}
	if (motion.settle !== undefined) {
		const t = Math.min(Math.max(entryElapsed / SETTLE_MS, 0), 1);
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
