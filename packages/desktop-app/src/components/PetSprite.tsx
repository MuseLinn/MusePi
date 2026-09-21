/**
 * PetSprite — the agent companion (伙伴) renderer, BitFun parity.
 *
 * Two sources:
 *  - builtin: a hand-drawn SVG MusePi mascot (note-bot) with per-mood
 *    overlay layers — silhouette stays theme-stable, mood decals adapt
 *    (same layered architecture as BitFun's panda: static body + FaceLayers).
 *  - petdex: an imported Petdex spritesheet (8×9 frame grid) animated via
 *    CSS background-position; mood selects the row, columns cycle frames.
 */

import { type CSSProperties, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import {
	activePet,
	migratePetdexContent,
	moodOfState,
	PET_CONTENT_TARGET_H,
	PETDEX_COLUMNS,
	PETDEX_MOOD_ANIM,
	PETDEX_MOOD_ROW,
	PETDEX_ROW_FRAMES_DEFAULT,
	PETDEX_ROWS,
	type PetDisplayMode,
	type PetdexMood,
	type PetInteraction,
	type PetState,
	petEnabled,
	petMode,
	petScale,
} from "../lib/pet";
import { type PetAccessory, type PetDecor, petDecor } from "../lib/pet-decor";
import { effectsForState, PetEffects, type PetEffectTier, TIER_STRENGTH } from "../lib/pet-effects";
import {
	applyYaw,
	DEFAULT_DRIFT_MS,
	driftMsForState,
	FACE_BOX,
	type Face,
	faceFor,
	GAZE_TRAVEL,
	gazeYaw,
	interactionDirection,
	lerpFace,
	moodDirection,
	mouthFrame,
	mouthPath,
	mouthSpecFor,
	mouthStroke,
	springStep,
	stateDirection,
	toPath,
} from "../lib/pet-face";
import { gazeDrift, INTERACTION_MOTION, MOOD_MOTION, motionTransform, STATE_MOTION } from "../lib/pet-motion";

/** Live pet prefs: re-resolves when settings change (the settings page
 *  dispatches "omp-pet-changed" after saving; storage events cover other
 *  tabs/pet windows). */
export function usePet(): {
	enabled: boolean;
	mode: PetDisplayMode;
	pet: ReturnType<typeof activePet>;
	decor: PetDecor;
} {
	const [state, setState] = useState(() => ({
		enabled: petEnabled(),
		mode: petMode(),
		pet: activePet(),
		decor: petDecor(),
	}));
	useEffect(() => {
		// Old imported packages lack the contentH scan — backfill once so
		// their render size normalizes like builtins.
		migratePetdexContent();
		const refresh = (): void =>
			setState({ enabled: petEnabled(), mode: petMode(), pet: activePet(), decor: petDecor() });
		window.addEventListener("omp-pet-changed", refresh);
		window.addEventListener("storage", refresh);
		return () => {
			window.removeEventListener("omp-pet-changed", refresh);
			window.removeEventListener("storage", refresh);
		};
	}, []);
	return state;
}

/** Decoration sub-state for renderers that are NOT the settings page (chat
 *  avatar, desktop pet window): resolves once and follows the same events,
 *  so a settings toggle lands everywhere without threading props. */
export function usePetDecor(): PetDecor {
	const [decor, setDecor] = useState<PetDecor>(() => petDecor());
	useEffect(() => {
		const refresh = (): void => setDecor(petDecor());
		window.addEventListener("omp-pet-changed", refresh);
		window.addEventListener("storage", refresh);
		return () => {
			window.removeEventListener("omp-pet-changed", refresh);
			window.removeEventListener("storage", refresh);
		};
	}, []);
	return decor;
}

/* ── Refs the engine writes to. Every value the frame clock touches lives
 *  in a ref: a morph is ~50 points changing per frame, and routing that
 *  through React state would re-render the whole composer 60× a second. */
interface MascotRefs {
	eyeRefs: [RefObject<SVGPathElement | null>, RefObject<SVGPathElement | null>];
	mouthRef: RefObject<SVGPathElement | null>;
	shellRef: RefObject<SVGGElement | null>;
	/** The wearable group (headphones). The engine leans it with the gaze so
	 *  the wear reads as sitting on a turning head, not pasted on the front. */
	accessoryRef: RefObject<SVGGElement | null>;
	/** Per-entry clock (ms since the current state was entered). Handed to
	 *  the effects layer so the dash tails ride the same flight clock the
	 *  body's `dash` motion does — different clocks would detach the tail
	 *  from the dot it trails. */
	entryClockRef: RefObject<number>;
}

/** Blend weight of the mood's `drift` face during idle — subtle on purpose.
 *  The face should feel like it keeps finding new poses to rest in, not like
 *  it is cycling a slideshow. */
const DRIFT_MAX = 0.18;

/** Cursor gaze target, normalized to ±1 from the pet's centre (main window:
 *  pointermove over the avatar; pet window: the main process's click-through
 *  poll). Lived in a ref on purpose — the engine reads it per frame, so a
 *  stream of pointer updates never re-renders React. */
export interface GazeVec {
	x: number;
	y: number;
}
export type GazeRef = RefObject<GazeVec | null>;
/** Attention ease-in (ms): how fast the eyes adopt a cursor target. */
const GAZE_ATTACK_MS = 220;
/** Attention ease-out (ms): how slowly the pet "looks away" again. */
const GAZE_RELEASE_MS = 380;
/** Eye glide time constant (ms): exponential smoothing toward the target. */
const GAZE_GLIDE_MS = 120;

/** Morph duration constants (ms). Down-blink is fast, up-blink is slower —
 *  a symmetric blink reads mechanical. */
const MORPH_MS = 420;
const BLINK_DOWN_MS = 90;
const BLINK_UP_MS = 150;

/**
 * The mascot frame loop. Three systems run on one clock so they stay
 * coherent:
 *
 *   FACE    A spring-eased morph between the face we came from, this mood's
 *           face, its drift face, and the blink lash. Because every ring has
 *           the same point count, the morph is point-by-point interpolation
 *           rather than a cut.
 *   MOUTH   Re-derived every frame from the *current* eye positions, which is
 *           why it tracks the morph instead of lagging behind it.
 *   BODY    The mood's motion numbers evaluated at the clock. Also drives the
 *           ground shadow in counter-phase, so the orb reads as floating.
 */
/** gazeRef: optional live cursor target (GazeVec). Present → the eyes track
 *  the cursor (attack/glide); absent/omitted → authored drift only.
 *
 *  `interaction` is the transient user-reaction override (poke / notice /
 *  pre-sleep): when set it REPLACES the mood's face + motion for its
 *  duration, because a startle is not a shade of "working". The engine keys
 *  off the resolved direction, so switching to (or off) an interaction
 *  replays the morph and the one-shot entrance exactly like a mood change.
 *
 *  `state` is the 31-value session axis (pet.ts). When present it WINS over
 *  `mood` for both the face and the body table — the seven moods are a
 *  spritesheet contract, not an expressive one. Absent, the engine behaves
 *  exactly as it did before (hosts migrate one call site at a time).
 *  `tier` is the render-size tier, which scales motion amplitude down so a
 *  24px avatar does not visibly vibrate. */
function useMascotEngine(
	mood: PetdexMood,
	gazeRef?: GazeRef,
	interaction?: PetInteraction | null,
	state?: PetState | null,
	tier: PetEffectTier = "full",
): MascotRefs {
	const eye0 = useRef<SVGPathElement | null>(null);
	const eye1 = useRef<SVGPathElement | null>(null);
	const mouthRef = useRef<SVGPathElement | null>(null);
	const shellRef = useRef<SVGGElement | null>(null);
	const accessoryRef = useRef<SVGGElement | null>(null);
	const gazeSmooth = useRef({ x: 0, y: 0, att: 0 });
	// ── Cross-direction continuity (refs, NOT effect closure): every mood
	// or interaction change re-runs the frame effect, and anything a switch
	// must NOT reset outlives it in these.
	// lastExpr/lastSpec — the face as the previous frame actually painted
	// it (blink included, gaze excluded): the source the next morph eases
	// FROM. The engine used to seed `from` with the NEW target, so every
	// switch was a hard cut and the morph machinery never played once
	// (2026-09-20, user: 表情切换是「突变的」而不是自然的).
	const lastExpr = useRef<Face | null>(null);
	const lastSpec = useRef<number[] | null>(null);
	// phase — the persistent loop clock (idle drift, saccade, body loops).
	// Resetting it per switch would jump every sine mid-arc; letting it run
	// keeps loops seamless across directions.
	const phaseRef = useRef(0);
	// entry — time since THIS direction was entered; drives the one-shot
	// enter/settle motions (reset per switch by the frame effect).
	const entryRef = useRef(0);
	// blink — phase persisted too: a blink in flight is never cut short by
	// a mood change. `next` stays wall-clock (compared against `now`).
	const blinkRef = useRef({ t: 1, next: performance.now() + 900 });

	// Static per-mood face data — decoded once per mood, never per frame.
	const prepped = useMemo(() => {
		const dir = interaction ? interactionDirection(interaction) : state ? stateDirection(state) : moodDirection(mood);
		const base = faceFor(dir.eyes);
		return {
			base,
			drift: faceFor(dir.drift ?? dir.eyes),
			lash: faceFor("closed"),
			mouth: mouthSpecFor(dir.eyes),
			mouthDrift: mouthSpecFor(dir.drift ?? dir.eyes),
			blinkMs: dir.blinkMs,
			look: dir.look,
			driftMs: interaction || !state ? DEFAULT_DRIFT_MS : driftMsForState(state),
			motion:
				(interaction
					? INTERACTION_MOTION[interaction]
					: state
						? (STATE_MOTION[state] ?? MOOD_MOTION[moodOfState(state)])
						: MOOD_MOTION[mood]) ?? {},
			strength: TIER_STRENGTH[tier],
		};
	}, [mood, interaction, state, tier]);

	useEffect(() => {
		let raf = 0;
		let last = performance.now();
		// One-shot entrance clock: a new direction replays its arrival.
		entryRef.current = 0;
		// Morph source: whatever the face ACTUALLY looked like on the last
		// frame before this change — not the new target. First mount has no
		// history: start exactly on the new base.
		const from: Face = lastExpr.current ?? prepped.base;
		const fromSpec: number[] = lastSpec.current ?? prepped.mouth;
		let morphT = lastExpr.current ? 0 : 1;
		if (!lastExpr.current) {
			// Seed the paths so the first frame never paints an invalid empty d.
			eye0.current?.setAttribute("d", toPath(prepped.base[0]));
			eye1.current?.setAttribute("d", toPath(prepped.base[1]));
		}

		const tick = (now: number): void => {
			const dt = Math.min(now - last, 64);
			last = now;
			phaseRef.current += dt;
			entryRef.current += dt;
			const elapsed = phaseRef.current;
			const entryElapsed = entryRef.current;

			// ── blink: fast close, slower open, on the mood's cadence.
			const blink = blinkRef.current;
			if (prepped.blinkMs > 0 && blink.t >= 1 && now >= blink.next) {
				blink.t = 0;
				blink.next = now + prepped.blinkMs;
			}
			if (blink.t < 1) blink.t = Math.min(1, blink.t + dt / (blink.t < 0.5 ? BLINK_DOWN_MS : BLINK_UP_MS));

			// ── face morph, eased FROM the last painted frame (see lastExpr).
			if (morphT < 1) morphT = Math.min(1, morphT + dt / MORPH_MS);
			const base = lerpFace(from, prepped.base, springStep(morphT));
			// The drift face eases in on a slow sine once the morph has landed,
			// so a long idle keeps making new faces without ever looking busy.
			// The drift clock is per-state (pet-face.ts STATE_DRIFT_MS): busy
			// states find a new resting pose faster than ambient ones.
			const driftT = morphT >= 1 ? (Math.sin(elapsed / prepped.driftMs) * 0.5 + 0.5) * DRIFT_MAX : 0;
			let rings = lerpFace(base, prepped.drift, driftT);
			// The mouth morphs in lockstep with the eyes (last painted spec →
			// the new base spec), then picks up the drift.
			let spec = mixSpec(
				mixSpec(fromSpec, prepped.mouth, springStep(morphT)),
				prepped.mouthDrift,
				morphT >= 1 ? driftT / DRIFT_MAX : 0,
			);
			if (blink.t < 1) {
				// Ease toward the lash on both halves of the blink. `blink.t`
				// runs 0→1 across close-then-open, so the bell is the weight.
				const w = blink.t < 0.5 ? blink.t * 2 : (1 - blink.t) * 2;
				rings = lerpFace(rings, prepped.lash, w * 0.96);
				spec = mixSpec(spec, prepped.mouth, w * 0.6);
			}
			// Remember the painted face — BEFORE the gaze offset (the gaze is
			// a view-space translate, not part of the expression) — as the
			// next switch's morph source.
			lastExpr.current = rings;
			lastSpec.current = spec;

			// ── gaze: authored look bias plus an idle saccade, applied as a yaw
			// so the eyes slide across the sphere and compress at the limb. When
			// a cursor target is present the eyes ease toward it (GAZE_GLIDE)
			// while attention (attack/release) blends the authored drift out —
			// so the orb "notices" you without snapping, and keeps a residue
			// of its idle personality while tracking.
			const target = gazeRef?.current ?? null;
			const gs = gazeSmooth.current;
			if (target) {
				const k = 1 - Math.exp(-dt / GAZE_GLIDE_MS);
				gs.x += (target.x - gs.x) * k;
				gs.y += (target.y - gs.y) * k;
				gs.att = Math.min(1, gs.att + dt / GAZE_ATTACK_MS);
			} else {
				gs.att = Math.max(0, gs.att - dt / GAZE_RELEASE_MS);
			}
			const gaze = gazeDrift(elapsed, prepped.look);
			const gx = (gaze.x * (1 - gs.att) + gs.x * gs.att) * GAZE_TRAVEL.x;
			const gy = (gaze.y * (1 - gs.att) + gs.y * gs.att) * GAZE_TRAVEL.y;
			const yaw = gazeYaw(gx);
			const face: Face = [
				applyYaw(
					rings[0].map(([x, y]) => [x + gx, y + gy] as [number, number]),
					yaw,
				),
				applyYaw(
					rings[1].map(([x, y]) => [x + gx, y + gy] as [number, number]),
					yaw,
				),
			];

			eye0.current?.setAttribute("d", toPath(face[0]));
			eye1.current?.setAttribute("d", toPath(face[1]));
			const frame = mouthFrame(face, spec);
			mouthRef.current?.setAttribute("d", mouthPath(frame, spec));
			mouthRef.current?.setAttribute("stroke-width", mouthStroke(spec).toFixed(2));

			// ── body. The face already lives in the orb's own coordinate space,
			// so the rig carries only the mood's motion. The motion helper
			// pivots around the box it is given, so it gets the orb box and the
			// rig keeps its padding shift in front of the motion.
			const shell = shellRef.current;
			if (shell) {
				// Loops ride the persistent phase; the one-shot enter/settle
				// ride the per-entry clock (replayed on every direction change).
				const motion = motionTransform(prepped.motion, elapsed, prepped.strength, FACE_BOX, entryElapsed);
				// Head-turn coupling: the rig rolls a hair TOWARD the gaze, the
				// way a whole head turns to look. blobstudio's lookAt reads as
				// "the body joins the eyes"; eyes-in-place alone is what made
				// our gaze read as slidey rather than attentive. ~1° at full
				// deflection — the accessory's own lean was reduced by the same
				// amount, so the total tilt the wear shows is unchanged.
				shell.setAttribute(
					"transform",
					`translate(${SIDE} ${TOP}) ${motion} rotate(${(gx * GAZE_ROLL).toFixed(2)} ${ORB_C} ${ORB_C})`.trim(),
				);
			}
			// ── the wearable leans with the gaze. The face turns inside the
			// ball (eyes slide + yaw); the headphones pivot a hair the same
			// way so the cups track the head's turn along the shell surface.
			// Amplitudes are small on purpose: ±6px of slide and ±2° of roll
			// at full deflection reads as physical — more reads as the wear
			// detaching from the body it is sitting on. The roll here is only
			// the PART the rig does not already carry (GAZE_ROLL above): the
			// cups hang off the shell, so they inherit its head-turn too.
			const acc = accessoryRef.current;
			if (acc) {
				acc.setAttribute(
					"transform",
					`translate(${(gx * 0.3).toFixed(2)} ${(gy * 0.24).toFixed(2)}) rotate(${(gx * 0.06).toFixed(2)} ${ORB_C} ${ORB_C}) translate(${ORB_C} ${ORB_C}) scale(${HEADPHONE_SCALE}) translate(${-ORB_C} ${-ORB_C})`,
				);
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [prepped]);

	return { eyeRefs: [eye0, eye1], mouthRef, shellRef, accessoryRef, entryClockRef: entryRef };
}

/** Blend two mouth specs. All four numbers are independent, so a plain
 *  per-slot lerp is exactly right here. */
function mixSpec(a: number[], b: number[], t: number): number[] {
	if (t <= 0) return a;
	if (t >= 1) return b;
	return a.map((v, i) => v + ((b[i] ?? v) - v) * t);
}

/* ── Builtin SVG mascot (orb-bot v7, brand default) ──────────────────────
 * A levitating tech orb — the floating-desktop-pet archetype the GrokBot
 * companion mascots share: one dominant silhouette (the sphere), one
 * signature feature (the tilted gold orbit ring), one emissive face.
 *
 * This is an ENGINE, not an illustration. The face is authored as control
 * numbers in lib/pet-face.ts (two eye rings plus four mouth numbers per
 * shape) and rendered through a sphere projection with a spring morph, so it
 * eases between expressions instead of cutting. Body motion is a data table
 * (lib/pet-motion.ts) read by a frame clock, which is how a mood can bob AND
 * squash AND sway at once.
 *
 * Palette is deliberately two families — graphite shell and brand gold —
 * with red appearing exactly once, on the error face. A limited palette is
 * what makes a mascot read as designed rather than assembled. */

/** The ball plus the breathing room the orbit ring needs. The engine authors
 *  the face in a FACE_BOX square and the silhouette *is* that square, so the
 *  face paints at scale 1 straight onto the ball with no anchor scale to keep
 *  in sync — the rig only needs to frame the ring's overhang.
 *
 *  The rig used to reserve HEADROOM for the crown's beacon mast and a FLOOR
 *  for the hover-thrust / ground-shadow family. Both are gone (2026-09-20,
 *  pet-decor.ts): with them the padding was ~1.28× the ball and the ball
 *  rendered at only ~77% of the box — which is exactly why an inline 30px
 *  box produced a ~23px ball that still read as oversized once the wrapper
 *  was sized by CSS. The box now hugs the art: SIDE still frames the ring
 *  (rx 104 of a 228.5 ball, tilted -18°, so a little air is needed left and
 *  right), TOP/BOTTOM clear the ring's vertical travel plus its sink while
 *  the body motions.
 *
 *  Everything inside the rig is authored around the sphere centre
 *  (FACE_BOX/2, matching the engine's own SPHERE_C); the rig itself is
 *  shifted by (SIDE, TOP) once, in the frame loop, so the padding never
 *  leaks into the art. */
const TOP = 24;
const SIDE = 20;
const BOTTOM = 22;
const VIEW_W = FACE_BOX + SIDE * 2;
const VIEW_H = FACE_BOX + TOP + BOTTOM;

/** The box ratio every host resolves against (`.gui-pet`'s
 *  `aspect-ratio: var(--gui-pet-ratio, …)`). Exported and written by
 *  PetSprite so the padding constants above stay the single source: the old
 *  literal 1.037 sat in two stylesheet rules and nothing ever wrote the
 *  variable, so retuning VIEW would have desynced the box silently — every
 *  host would keep reserving the OLD ratio and stretch the orb. */
export const PET_BOX_RATIO = VIEW_W / VIEW_H;

/** Sphere centre in orb-local coordinates — the engine's own SPHERE_C. The
 *  rig shifts this down by TOP and right by SIDE into the padded view. */
const ORB_C = FACE_BOX / 2;
const ORB_R = FACE_BOX / 2;

/** Degrees of head-turn per unit of gaze travel (GAZE_TRAVEL full swing ≈
 *  ±1°). The rig rolls toward the cursor so the body joins the eyes —
 *  see the shell transform in the frame loop. */
const GAZE_ROLL = 0.05;

/** Uniform headset enlargement about the sphere centre (2026-09-21, user:
 *  「耳机稍微大一点」). 1.08 is the largest factor that keeps EVERY authored
 *  extreme inside the rig padding (TOP 24 / SIDE 20): the canopy mesh's
 *  14px round caps are the binding constraint — the apex clears easily, but
 *  the chord endpoints sit ±116.3 from centre and their caps reach −20.6 at
 *  1.10, past SIDE 20, so the svg would shave the cap. Applied in the frame
 *  loop's accessory transform, NOT as a static group attribute — the engine
 *  owns that attribute and rewrites it every frame. */
const HEADPHONE_SCALE = 1.08;

/** One ear cup, authored in its OWN centred frame (the caller owns the
 *  translate + tilt, so all layers move as one rigid object): anodized-white
 *  plate → white mesh cushion → dark seam, plus the rim highlight that gives
 *  the plate curvature and — on the right cup — the rose-gold Digital Crown.
 *  AirPods Max styling per the user (2026-09-20): the white must stay CLEAR
 *  of the gold shell, which is what the warm-grey outline is for. */
function HeadphoneCup({ crown = false }: { crown?: boolean }): ReactNode {
	return (
		<>
			<ellipse
				rx="12.6"
				ry="25"
				fill="url(#gui-pet-grad-wear)"
				stroke="var(--gui-pet-wear-edge, oklch(72% 0.012 90))"
				strokeWidth="2.2"
			/>
			{/* Ear cushion: same white family as the plate, a HAIR darker —
			 * AirPods Max's mesh pad reads as one material with the cup until
			 * the seam. The dark cavity does the separating, not a colour
			 * change. */}
			<ellipse rx="9" ry="20.5" fill="var(--gui-pet-wear-pad, oklch(94% 0.005 95))" />
			<ellipse rx="4.8" ry="12.5" fill="var(--gui-pet-wear-c, oklch(45% 0.012 80))" />
			{/* Rim highlight on the lit shoulder (−130°…−70° of the plate's
			 * ellipse) — the arc that turns a flat ellipse into a surface
			 * catching the same upper-left light as the shell. */}
			<path
				d="M -7.2 -17.8 A 11.2 23.2 0 0 1 3.8 -21.9"
				fill="none"
				stroke="var(--gui-pet-wear-hi, oklch(100% 0 0))"
				strokeWidth="1.8"
				strokeLinecap="round"
				opacity="0.85"
			/>
			{crown && (
				/* Digital Crown — the rose-gold control knob on the upper edge
				 * of the right cup. THE AirPods Max signature: a tiny cylinder
				 * breaking the cup's silhouette. Half-tucked so it reads as
				 * mounted hardware, not a floating pill. */
				<rect
					x={2}
					y={-31}
					width={7}
					height={10}
					rx={2.4}
					fill="url(#gui-pet-grad-rose)"
					stroke="var(--gui-pet-rose-c, oklch(58% 0.07 32))"
					strokeWidth="1.2"
				/>
			)}
		</>
	);
}

function Mascot({
	mood,
	state,
	tier = "full",
	gazeRef,
	interaction,
	gloss,
	accessory = "none",
}: {
	mood: PetdexMood;
	/** Session state (pet.ts PetState). Optional — without it the sprite
	 *  renders the legacy 7-mood behaviour with no effects. */
	state?: PetState | null;
	/** Render-size tier: which effects survive and how loud the body moves. */
	tier?: PetEffectTier;
	gazeRef?: GazeRef;
	interaction?: PetInteraction | null;
	gloss: boolean;
	accessory?: PetAccessory;
}): ReactNode {
	const refs = useMascotEngine(mood, gazeRef, interaction, state, tier);
	// The shared body unit — ring, shell, gloss, face and wearables — that
	// the effects layer drives DIRECTLY per frame (the dots dissolve it, the
	// glyph steps it aside). A DOM ref, not engine state: writing it through
	// React would re-render the rig 60× a second.
	const bodyRef = useRef<SVGGElement | null>(null);
	// Three classes ride the svg: `--<mood>` carries the MATERIAL state (the
	// error face's red eye, hover's brightened glow, waiting's dimmed light —
	// all pure-CSS), `--<state>` lets a stylesheet tune one state's material
	// without a mood-wide rule, and `--<interaction>` carries the reaction.
	// Dropping the mood class during a reaction would silently reset those
	// materials, so the reaction is additive rather than a replacement.
	return (
		<svg
			className={`gui-pet-svg gui-pet-svg--${mood}${state ? ` gui-pet-svg--${state}` : ""}${gloss ? "" : " gui-pet-svg--flat"}${interaction ? ` gui-pet-svg--${interaction}` : ""}`}
			viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
			xmlns="http://www.w3.org/2000/svg"
			aria-hidden
		>
			<Silhouette {...refs} bodyRef={bodyRef} gloss={gloss} accessory={accessory} state={state} tier={tier} />
		</svg>
	);
}

/** The silhouette, the materials and the mounting points the engine drives.
 *  Order matters: the orbit ring is drawn in two halves so it reads as one
 *  loop passing around the body rather than a band stuck on its front.
 *
 *  Floor layers (thrust / bounce / ground) and the crown beacon used to live
 *  here unconditionally. They are gone — see pet-decor.ts. `gloss` is the
 *  surface-shading opt-out; `accessory` is the wearable pick (none / note /
 *  headphones), drawn inside the rig so it rides the body motion. */
function Silhouette({
	eyeRefs,
	mouthRef,
	shellRef,
	accessoryRef,
	entryClockRef,
	bodyRef,
	gloss,
	accessory,
	state,
	tier = "full",
}: MascotRefs & {
	/** The shared body unit the effects layer drives (see Mascot). */
	bodyRef: RefObject<SVGGElement | null>;
	gloss: boolean;
	accessory: PetAccessory;
	state?: PetState | null;
	tier?: PetEffectTier;
}): ReactNode {
	// The face yields where an effect OWNS the read: during a dash flight
	// the body IS a 21% comet head, and a morphing face on it is noise. The
	// dots/glyph body-yields no longer live here — they drive the shared
	// body group itself (bodyRef, pet-effects updateDots/updateGlyph), so
	// the face fades and shrinks WITH the ball instead of being CSS-dimmed
	// behind an effect.
	const fx = state ? effectsForState(state, tier) : [];
	const faceClass = `gui-pet-svg__face${fx.includes("dash") ? " gui-pet-svg__face--hidden" : ""}`;
	return (
		<g aria-hidden className="gui-pet-svg__silhouette">
			<defs>
				{/* Shell: the sphere IS the accent — lit crown, body, terminator.
				 * The fallback trio is the brand-gold dark-theme derivation
				 * (pet-palette.ts: L .87/.75/.41 at the accent hue, accent-level
				 * chroma), so the pre-palette first paint is already the bright
				 * warm orb. History is the lesson here: two hand-picked
				 * graphite fallbacks shipped (#4a5768/#26303d/#0e141c then
				 * #7d7159/#453a24/#1c1408) and were reported as 「颜色都是黑色
				 * 球体而不是主题色」 / 「品牌金色，但显示的还是黑色带点黄」; the
				 * DERIVED value then fixed the fallbacks but the derivation
				 * itself (dark graphite at L .56/.36/.19) was read as black a
				 * THIRD time (「现在依然是黑色为底色」). A dark desaturated shell
				 * is a black ball to the eye — the derivation now rides the
				 * accent and the fallback must always be the derived value.
				 * PetPaletteVars is the single source. */}
				<radialGradient id="gui-pet-grad-shell" cx="0.34" cy="0.26" r="0.92">
					<stop offset="0" stopColor="var(--gui-pet-shell-a, oklch(89.07% 0.0798 79.84deg))" />
					<stop offset="0.5" stopColor="var(--gui-pet-shell-b, oklch(75.07% 0.1036 79.84deg))" />
					<stop offset="1" stopColor="var(--gui-pet-shell-c, oklch(41.29% 0.0907 79.84deg))" />
				</radialGradient>
				{/* Orbit ring: the accent (brand gold by default), brightest where
				 * it crosses the light (top-left) and dimmest at the far side.
				 * This is the surface that carries the theme, now that the face
				 * is white. */}
				<linearGradient id="gui-pet-grad-ring" x1="0" y1="0" x2="1" y2="1">
					{/* A METAL falloff, not a tint ramp (2026-09-20 user: 「这个
					 * 黄感觉不是很有高级细腻质感」). Three evenly-placed stops on
					 * three flat ladder colours is why the old ring read as
					 * coloured plastic: brightness changed, material didn't.
					 * This holds the specular for a beat, crashes to the body
					 * through the terminator, then lifts a hair at the far edge
					 * — the bounce every polished surface steals back from its
					 * environment, and the single cheapest cue that separates
					 * metal from paint. The lift is a color-mix of the two end
					 * tokens so no fourth palette variable has to exist. */}
					<stop offset="0" stopColor="var(--gui-pet-gold-a, oklch(93.07% 0.0518 79.85deg))" />
					<stop offset="0.15" stopColor="var(--gui-pet-gold-a, oklch(93.07% 0.0518 79.85deg))" />
					<stop offset="0.5" stopColor="var(--gui-pet-gold-b, oklch(81.07% 0.1101 79.85deg))" />
					<stop offset="0.86" stopColor="var(--gui-pet-gold-c, oklch(45.04% 0.0777 79.85deg))" />
					<stop
						offset="1"
						stopColor="color-mix(in oklab, var(--gui-pet-gold-c, oklch(45.04% 0.0777 79.85deg)) 70%, var(--gui-pet-gold-b, oklch(81.07% 0.1101 79.85deg)))"
					/>
				</linearGradient>
				{/* Wearable (headphones): AirPods Max white + rose gold — a
				 * FIXED identity, deliberately NOT derived from the accent.
				 * History: a ring-gradient wear sat tone-on-tone on the accent
				 * ball and read as a same-colour growth (2026-09-20 user:
				 * 「耳机应该有单独的配色吧」), so the wear went neutral
				 * charcoal; the charcoal then read as 「秃头」 and the user
				 * pinned the target: 「耳机是白色的吧，不是现在这种灰黑色的，
				 * 那种 AirPods Max 一样的白色和玫瑰金色」. Warm anodized-white
				 * body, rose-gold hardware, fixed by construction (the palette
				 * never emits these hooks — the fallback literals ARE the
				 * values; 20% white-on-gold would dissolve, which is also why
				 * the cup keeps a warm-grey OUTLINE). */}
				<linearGradient id="gui-pet-grad-wear" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0" stopColor="var(--gui-pet-wear-a, oklch(97% 0.004 95))" />
					<stop offset="1" stopColor="var(--gui-pet-wear-b, oklch(90% 0.006 95))" />
				</linearGradient>
				{/* The rose-gold hardware ramp (arms, canopy frame, Digital
				 * Crown): highlight → body → shade. Mirrors the gold ring's
				 * metal logic at a pink-copper hue, but it is a fixed literal
				 * ramp, not accent-derived. */}
				<linearGradient id="gui-pet-grad-rose" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0" stopColor="var(--gui-pet-rose-a, oklch(83% 0.05 40))" />
					<stop offset="0.55" stopColor="var(--gui-pet-rose-b, oklch(72% 0.075 35))" />
					<stop offset="1" stopColor="var(--gui-pet-rose-c, oklch(58% 0.07 32))" />
				</linearGradient>
				{/* Eye light: white with a hot core. A flat fill reads as paint;
				 * a gradient reads as something emitting. The face is white in
				 * every theme (pet-palette.ts `--gui-pet-face`): the ring is
				 * what carries the accent, and keeping the face neutral means
				 * the brightest thing on the orb is always readable, whatever
				 * the accent hue does to the shell. */}
				<radialGradient id="gui-pet-grad-eye" cx="0.5" cy="0.3" r="0.78">
					<stop offset="0" stopColor="#ffffff" />
					<stop offset="0.45" stopColor="var(--gui-pet-face, #f4f6f9)" />
					<stop offset="1" stopColor="color-mix(in oklab, var(--gui-pet-face, #f4f6f9) 82%, #8f96a3)" />
				</radialGradient>
				<radialGradient id="gui-pet-grad-eye-err" cx="0.5" cy="0.3" r="0.78">
					<stop offset="0" stopColor="#ffd9d5" />
					<stop offset="0.45" stopColor="var(--color-danger)" />
					<stop offset="1" stopColor="color-mix(in oklab, var(--color-danger) 60%, #000)" />
				</radialGradient>
			</defs>
			<g className="gui-pet-svg__body">
				{/* The rig. Orb-local coordinates; shifted into the padded view
				 * and then driven by the frame loop for mood motion. THREE
				 * siblings share the padding shift: the effects layers sit
				 * OUTSIDE the motion rig on purpose — they are authored in
				 * world space (the dash tails sample the flight path on their
				 * own, via the shared entry clock), and inheriting the body's
				 * motion transform would fling the dash head to twice the
				 * flight offset and drag every trail along with the body it
				 * is supposed to trail. */}
				<g transform={`translate(${SIDE} ${TOP})`}>
					{/* ── Effects, BACK layer (trails / dash) ── drawn under the
					 * shell on purpose: the ball occludes whatever passes
					 * behind it, and that occlusion is what turns a flat decal
					 * into something orbiting a body. This mount point replaces
					 * the old hardcoded three-dot CSS spinner (2026-09-20) —
					 * three static lights on a spun circle could say "busy" and
					 * nothing else, while the session has 31 things to say. */}
					<PetEffects state={state} layer="behind" tier={tier} clockRef={entryClockRef} bodyRef={bodyRef} />
				</g>
				<g ref={shellRef} transform={`translate(${SIDE} ${TOP})`}>
					{/* The body unit the effects drive directly (bodyRef): the
					 * dots dissolve it, the glyph steps it aside. Everything
					 * that IS the pet rides inside — wearables too, so the
					 * headphones dissolve with the ball instead of hovering
					 * over a dot. */}
					<g ref={bodyRef}>
						{/* Orbit ring, back half — behind the shell, so the front arc
						 * reads as the same loop coming round. */}
						<ellipse
							className="gui-pet-svg__ring gui-pet-svg__ring--back"
							cx={ORB_C}
							cy={ORB_C + 3}
							rx="104"
							ry="34"
							transform={`rotate(-18 ${ORB_C} ${ORB_C + 3})`}
						/>
						{/* Shell — the orb itself, which is also the face's sphere. */}
						<circle className="gui-pet-svg__shell" cx={ORB_C} cy={ORB_C} r={ORB_R} />
						{/* Crown gloss + secondary catch-light + specular sweep:
						 * cheap sphericity, and the one decoration that is correct
						 * in every context (pet-decor.ts). Off → the shell reads as
						 * a flat silhouette, which is the quieter look some users
						 * asked for. */}
						{gloss && (
							<>
								<ellipse
									className="gui-pet-svg__gloss"
									cx={ORB_C - 34}
									cy={ORB_C - 57}
									rx="31"
									ry="14"
									transform={`rotate(-22 ${ORB_C - 34} ${ORB_C - 57})`}
								/>
								<ellipse
									className="gui-pet-svg__gloss-dot"
									cx={ORB_C - 56}
									cy={ORB_C - 30}
									rx="7"
									ry="4"
									transform={`rotate(-22 ${ORB_C - 56} ${ORB_C - 30})`}
								/>
								<ellipse
									className="gui-pet-svg__sweep"
									cx={ORB_C - 20}
									cy={ORB_C - 64}
									rx="15"
									ry="5.6"
									transform={`rotate(-22 ${ORB_C - 20} ${ORB_C - 64})`}
								/>
							</>
						)}
						{/* The face, in the engine's own coordinates — no offset needed,
						 * because the rig already sits on the sphere centre. All three
						 * paths are rewritten every frame. */}
						<g className={faceClass}>
							<path className="gui-pet-svg__eye" ref={eyeRefs[0]} />
							<path className="gui-pet-svg__eye" ref={eyeRefs[1]} />
							<path className="gui-pet-svg__mouth" ref={mouthRef} />
						</g>
						{/* ── Wearable accessories (pet-decor.ts PetAccessory) ──
						 * Static art in orb-local coordinates: they scale with the
						 * ball and ride the body motion for free. Both are authored
						 * to stay inside the rig's TOP/SIDE padding — the note's
						 * stem top and the band apex were checked against the
						 * viewBox (TOP=24 / SIDE=20) so nothing clips. */}
						{accessory === "headphones" && (
							<g ref={accessoryRef} className="gui-pet-svg__accessory">
								{/* ── Canopy (AirPods Max knit mesh) ── a wide white
								 * arc held between TWO rose-gold frame rails. The old
								 * single thin band read as a halo on a bald head
								 * (2026-09-20 user: 「看着有点像秃头」) and then as
								 * the wrong colour entirely (「耳机是白色的吧，不是
								 * 现在这种灰黑色的，那种 AirPods Max 一样的白色和玫
								 * 瑰金色」). The three radii are concentric about the
								 * arc's own centre (114.27, 119.31 for the mesh), so
								 * the frame rails hug the mesh edge for its whole
								 * run — outer r 128 over endpoints y 74, inner r 118.5
								 * over y 84, apexes −0.5 / −11.6, inside TOP 24. */}
								<path
									d={`M -2 ${ORB_C - 36} A 123.3 123.3 0 0 1 ${2 * ORB_C + 2} ${ORB_C - 36}`}
									fill="none"
									stroke="url(#gui-pet-grad-wear)"
									strokeWidth="14"
									strokeLinecap="round"
								/>
								<path
									d="M -2 74 A 128 128 0 0 1 230.54 74"
									fill="none"
									stroke="url(#gui-pet-grad-rose)"
									strokeWidth="2.6"
									strokeLinecap="round"
								/>
								<path
									d="M -2 84 A 118.5 118.5 0 0 1 230.54 84"
									fill="none"
									stroke="url(#gui-pet-grad-rose)"
									strokeWidth="2.6"
									strokeLinecap="round"
								/>
								{/* ── Telescoping arms ── rose-gold, the extension
								 * joint between canopy rail and cup. Un-tilted in orb
								 * coordinates: the rails end vertically here, and a
								 * tilt would pull the arm's foot off the rail it has
								 * to meet. */}
								<rect
									x={-6.5}
									y={74}
									width={9}
									height={30}
									rx={4.5}
									fill="url(#gui-pet-grad-rose)"
									stroke="var(--gui-pet-rose-c, oklch(58% 0.07 32))"
									strokeWidth="1.2"
								/>
								<rect
									x={2 * ORB_C - 2.5}
									y={74}
									width={9}
									height={30}
									rx={4.5}
									fill="url(#gui-pet-grad-rose)"
									stroke="var(--gui-pet-rose-c, oklch(58% 0.07 32))"
									strokeWidth="1.2"
								/>
								{/* ── Cups ── each authored in its own centred frame so
								 * the layers stay concentric while the tilt reads as
								 * one rigid object. The right cup carries the Digital
								 * Crown. */}
								<g transform={`translate(${ORB_C - ORB_R - 2} ${ORB_C - 10}) rotate(-14)`}>
									<HeadphoneCup />
								</g>
								<g transform={`translate(${ORB_C + ORB_R + 2} ${ORB_C - 10}) rotate(14)`}>
									<HeadphoneCup crown />
								</g>
							</g>
						)}
						{accessory === "note" && (
							<g className="gui-pet-svg__accessory">
								{/* An eighth-note mark ON the shell's upper right — a
								 * decal, not a floating charm (a floater would clip at
								 * the rig's headroom and read as the old beacon noise).
								 * Head + stem + flag, all in the ring's gold. */}
								<ellipse
									cx={ORB_C + 40}
									cy={ORB_C - 64}
									rx="11.5"
									ry="8.8"
									transform={`rotate(-18 ${ORB_C + 40} ${ORB_C - 64})`}
									fill="url(#gui-pet-grad-ring)"
								/>
								<path
									d={`M ${ORB_C + 50} ${ORB_C - 62} L ${ORB_C + 50} ${ORB_C - 100}`}
									stroke="url(#gui-pet-grad-ring)"
									strokeWidth="5.5"
									strokeLinecap="round"
								/>
								<path
									d={`M ${ORB_C + 50} ${ORB_C - 100} C ${ORB_C + 63} ${ORB_C - 94}, ${ORB_C + 66} ${ORB_C - 82}, ${ORB_C + 57} ${ORB_C - 70}`}
									fill="none"
									stroke="url(#gui-pet-grad-ring)"
									strokeWidth="5.5"
									strokeLinecap="round"
								/>
								{/* Echo dot — keeps the mark from reading as a lone
								 * speck; tucked back inside the shell edge. */}
								<circle cx={ORB_C + 58} cy={ORB_C - 44} r="4" fill="url(#gui-pet-grad-ring)" opacity="0.75" />
							</g>
						)}
					</g>
				</g>
				<g transform={`translate(${SIDE} ${TOP})`}>
					{/* ── Effects, FRONT layer (dots / confetti / pops / badge /
					 * glyph) ── content, not weather: they replace or annotate
					 * the face, so they paint over the whole body unit. */}
					<PetEffects state={state} layer="front" tier={tier} clockRef={entryClockRef} bodyRef={bodyRef} />
				</g>
			</g>
		</g>
	);
}

/** Builtin SVG pet (orb-bot v8) — natively speaks every PetdexMood,
 *  including the floating desktop pet's hover/dragging rows. `gazeRef`
 *  (optional) turns eye tracking on — see GazeVec. `interaction` overlays a
 *  transient user reaction (see pet-face.ts PET_INTERACTIONS). `gloss`
 *  toggles the shell's surface shading (pet-decor.ts) — the React prop so
 *  the settings preview can render a specific option without touching
 *  storage; renderers that just want the live pref pass `usePetDecor()`. */
export function BuiltinPetSprite({
	mood,
	state,
	tier,
	gazeRef,
	interaction,
	gloss = true,
	accessory = "none",
}: {
	mood: PetdexMood;
	/** Session state — see Mascot. Omit for legacy 7-mood rendering. */
	state?: PetState | null;
	tier?: PetEffectTier;
	gazeRef?: GazeRef;
	interaction?: PetInteraction | null;
	gloss?: boolean;
	accessory?: PetAccessory;
}): ReactNode {
	return (
		<Mascot
			mood={mood}
			state={state}
			tier={tier}
			gazeRef={gazeRef}
			interaction={interaction}
			gloss={gloss}
			accessory={accessory}
		/>
	);
}

/** The sizing box for a bare builtin SVG — `.gui-pet` plus the two variables
 *  that make it resolvable outside a `PetSprite`.
 *
 *  This exists because `.gui-pet-svg` (the svg root) has NO size rule of its
 *  own: gui-pet.css only sizes `.gui-pet svg`, a DESCENDANT selector. Any
 *  call site that rendered `<BuiltinPetSprite>` without the wrapper — the
 *  chat avatar did, and every avatar slot went blank (2026-09-20 user:
 *  「头像小球不显示了」) — handed the svg an unresolvable box. Wrapping is
 *  the contract, so it is a component instead of a rule to remember.
 *
 *  `size` is the fallback box only (see PetSprite); hosts that want a fixed
 *  slot size their own wrapper through `--gui-pet-height` (`.gui-pet--h`
 *  hosts) or `--gui-pet-width`. */
export function PetBox({
	size = 48,
	className,
	style,
	children,
}: {
	size?: number;
	className?: string;
	style?: CSSProperties;
	children: ReactNode;
}): ReactNode {
	return (
		<div
			className={`gui-pet${className ? ` ${className}` : ""}`}
			style={
				{
					"--gui-pet-fallback": `${size}px`,
					"--gui-pet-ratio": `${PET_BOX_RATIO}`,
					...style,
				} as CSSProperties
			}
		>
			{children}
		</div>
	);
}

/** The state-axis stage for imported sprites (PetdexSprite `state`).
 *
 *  This is the blobstudio SHAPE contract absorbed: the source's motion and
 *  effects are deliberately shape-agnostic ("an uploaded logo behaves
 *  exactly like the built-in circle"), so an imported pet rides the SAME
 *  engine as the builtin — body motion (pet-motion STATE_MOTION) and the
 *  effects layers (pet-effects) — with no per-shape code. Only the face
 *  tables do not apply: an arbitrary sheet has no eye/mouth rings to
 *  project onto.
 *
 *  Everything inside the stage is authored in FACE_BOX face units and
 *  normalized to the art's rendered size with ONE scale (`u`), so motion
 *  amplitudes and effect coordinates keep their source proportions at any
 *  host size. The effects' `htmlBodyRef` points at the art wrapper, so the
 *  dots dissolve the sprite and the glyph steps it aside exactly as they
 *  dissolve the builtin ball. */
function PetdexStateStage({
	mood,
	src,
	state,
	tier,
	frozen,
	smooth,
	isSvg,
	row,
	valid,
	cycleMs,
	u,
	artW,
	artH,
}: {
	mood: PetdexMood;
	src: string;
	state: PetState;
	tier: PetEffectTier;
	frozen: boolean;
	smooth: boolean;
	isSvg: boolean;
	row: number;
	valid: number;
	cycleMs: number;
	/** px per face unit — the stage-to-host scale. */
	u: number;
	/** Art frame size in face units (content height = full box). */
	artW: number;
	artH: number;
}): ReactNode {
	const entryRef = useRef(0);
	const motionRef = useRef<HTMLDivElement | null>(null);
	const bodyRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		let raf = 0;
		let last = performance.now();
		// Per-entry clock, like the source: every state replays its arrival.
		entryRef.current = 0;
		const motion = STATE_MOTION[state] ?? {};
		const strength = TIER_STRENGTH[tier];
		const tick = (now: number): void => {
			const dt = Math.min(now - last, 64);
			last = now;
			entryRef.current += dt;
			const m = motionRef.current;
			if (m) {
				// Same engine as the builtin's BODY system; the effects read
				// the same entry clock (clockRef), so the dash tails stay
				// welded to the flight the body rides.
				m.style.transform = motionTransform(motion, entryRef.current, strength, FACE_BOX, entryRef.current) || "";
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [state, tier]);

	const artStyle: CSSProperties = {
		position: "absolute",
		left: `${(FACE_BOX - artW) / 2}px`,
		top: "0px",
		width: `${artW}px`,
		height: `${artH}px`,
		backgroundImage: `url("${src}")`,
		backgroundSize: `${artW}px ${artH}px`,
		backgroundPosition: isSvg ? "0 0" : `0 ${-(row * artH)}px`,
		// The JS motion owns the body transform in state mode — the mood's
		// CSS transform animation would compound with it.
		animation: frozen ? "none" : `gui-petdex-cycle ${cycleMs}ms steps(${valid}) infinite`,
		...(isSvg ? {} : { "--gui-petdex-cycle-end": `${-(artW * valid)}px` }),
	} as CSSProperties;

	const fxBox: CSSProperties = {
		position: "absolute",
		left: 0,
		top: 0,
		overflow: "visible",
		pointerEvents: "none",
	};

	return (
		<div style={{ position: "relative", width: `${artW * u}px`, height: `${artH * u}px` }} aria-hidden>
			<div
				style={{
					position: "absolute",
					left: "50%",
					top: "50%",
					width: `${FACE_BOX}px`,
					height: `${FACE_BOX}px`,
					transform: `translate(-50%, -50%) scale(${u})`,
					transformOrigin: "center",
				}}
			>
				<svg viewBox={`0 0 ${FACE_BOX} ${FACE_BOX}`} width={FACE_BOX} height={FACE_BOX} style={fxBox}>
					{/* The dots/pops/glyph paint with url(#gui-pet-grad-shell) —
					 * the builtin defines that gradient in its own defs; a host
					 * page with ONLY an imported pet has no such def, so this
					 * svg carries the identical fallback (duplicate ids resolve
					 * to the first occurrence, which is the same gradient). */}
					<defs>
						<radialGradient id="gui-pet-grad-shell" cx="0.34" cy="0.26" r="0.92">
							<stop offset="0" stopColor="var(--gui-pet-shell-a, oklch(89.07% 0.0798 79.84deg))" />
							<stop offset="0.5" stopColor="var(--gui-pet-shell-b, oklch(75.07% 0.1036 79.84deg))" />
							<stop offset="1" stopColor="var(--gui-pet-shell-c, oklch(41.29% 0.0907 79.84deg))" />
						</radialGradient>
					</defs>
					<PetEffects state={state} layer="behind" tier={tier} clockRef={entryRef} htmlBodyRef={bodyRef} />
				</svg>
				<div ref={motionRef} style={{ position: "absolute", inset: 0 }}>
					{/* The body unit the effects drive (dots dissolve it, the
					 * glyph steps it aside) — separate from the motion wrapper
					 * so the two transforms compose instead of clobbering. */}
					<div ref={bodyRef} style={{ position: "absolute", inset: 0 }}>
						<div
							className={`gui-petdex-sprite gui-petdex-sprite--${mood}${smooth || isSvg ? " gui-petdex-sprite--smooth" : ""}`}
							style={artStyle}
						/>
					</div>
				</div>
				<svg viewBox={`0 0 ${FACE_BOX} ${FACE_BOX}`} width={FACE_BOX} height={FACE_BOX} style={fxBox}>
					<PetEffects state={state} layer="front" tier={tier} clockRef={entryRef} htmlBodyRef={bodyRef} />
				</svg>
			</div>
		</div>
	);
}

/** Petdex spritesheet pet — CSS background-position frame animation with a
 *  mood-driven cycle speed and a paired transform animation (BitFun parity:
 *  rest breathes slowly, working bobs fast, hover lifts, dragging wiggles).
 *  `mood` accepts the petdex-only hover/dragging states (rows 1/2) that the
 *  floating desktop pet uses. `contentH` (rest-row content height, scanned
 *  at import / known for builtins) normalizes the visual size so imported
 *  sheets with larger frames render at the same body size as builtins;
 *  `scale` is the user's size slider (0.6–1.5).
 *
 *  `state` switches the sprite onto the 31-state axis: body motion and
 *  effects come from the shared engine (see PetdexStateStage) instead of
 *  the mood CSS keyframes — the imported-pet parity with the builtin. */
export function PetdexSprite({
	mood,
	src,
	width,
	height,
	format,
	rows,
	contentH,
	scale = 1,
	frozen = false,
	smooth = false,
	state,
	tier = "full",
}: {
	mood: PetdexMood;
	src: string;
	width: number;
	height: number;
	/** "svg" renders the WHOLE image as one static frame (user SVG import);
	 *  default/absent is the 8×9 petdex frame grid. */
	format?: "sheet" | "svg";
	rows?: readonly number[];
	contentH?: number;
	scale?: number;
	/** Freeze the frame loop (background-position steps) but keep the mood's
	 *  transform animation. Hovering a pet should read as "looking at you",
	 *  not as running — the hover row's frames are a walk cycle on most
	 *  packs, and stepping them reads as motion with no direction context. */
	frozen?: boolean;
	/** Smooth (bilinear) downscaling for vector-style sheets — the pixel-art
	 *  `image-rendering: pixelated` treatment would alias them badly. */
	smooth?: boolean;
	/** Session state (pet.ts PetState) — opts the sprite into the state
	 *  axis (motion + effects). Absent → legacy mood-keyframe behaviour. */
	state?: PetState | null;
	/** Render-size tier for the state axis (scales motion + effects). */
	tier?: PetEffectTier;
}): ReactNode {
	const anim = PETDEX_MOOD_ANIM[mood];
	// Body-size normalization + user scale: scale the frame and the whole
	// sheet together (background-size must match the element scaling).
	// An SVG import has no frame grid — its width/height ARE the frame, and
	// the whole image is content, so contentH === height at import.
	const isSvg = format === "svg";
	const frameW = isSvg ? width : width / PETDEX_COLUMNS;
	const frameH = isSvg ? height : height / PETDEX_ROWS;
	const row = PETDEX_MOOD_ROW[mood];
	// Cycle only the row's valid frames — sheets pad calm rows with empty
	// columns, and stepping into one blanks the pet for a frame each loop.
	const valid = isSvg
		? 1
		: Math.min(PETDEX_COLUMNS, Math.max(1, (rows ?? PETDEX_ROW_FRAMES_DEFAULT)[row] ?? PETDEX_COLUMNS));
	const k = scale * (contentH && contentH > 0 ? PET_CONTENT_TARGET_H / contentH : 1);

	// ── State axis: the imported pet as a blobstudio "uploaded logo".
	// The frame box is expressed in face units (its height maps to the full
	// FACE_BOX), so pet-motion amplitudes and pet-effects coordinates keep
	// their source proportions at any host size.
	if (state) {
		const u = frameH > 0 ? (frameH * k) / FACE_BOX : 1;
		return (
			<PetdexStateStage
				mood={mood}
				src={src}
				state={state}
				tier={tier}
				frozen={frozen}
				smooth={smooth}
				isSvg={isSvg}
				row={row}
				valid={valid}
				cycleMs={anim.cycleMs}
				u={u}
				artW={FACE_BOX * (frameW / frameH)}
				artH={FACE_BOX}
			/>
		);
	}

	const style: CSSProperties = {
		width: `${frameW * k}px`,
		height: `${frameH * k}px`,
		backgroundImage: `url("${src}")`,
		backgroundSize: `${width * k}px ${height * k}px`,
		// An SVG import has ONE frame — the row offset would shift the whole
		// image out of the box (blank pet on hover/dragging rows).
		backgroundPosition: isSvg ? "0 0" : `0 ${-(row * frameH * k)}px`,
		animation: frozen
			? `gui-petdex-${anim.transform} ${anim.transformMs}ms ease-in-out infinite`
			: `gui-petdex-cycle ${anim.cycleMs}ms steps(${valid}) infinite, gui-petdex-${anim.transform} ${anim.transformMs}ms ease-in-out infinite`,
		...(frozen || isSvg ? {} : { "--gui-petdex-cycle-end": `${-(frameW * valid * k)}px` }),
	} as CSSProperties;
	// An imported SVG is always vector-sharp — the pixelated class would
	// alias it, so the smooth treatment is forced on.
	return (
		<div
			className={`gui-petdex-sprite gui-petdex-sprite--${mood}${smooth || isSvg ? " gui-petdex-sprite--smooth" : ""}`}
			style={style}
			aria-hidden
		/>
	);
}

/** Unified pet renderer: builtin or petdex.
 *
 *  Sizing is deliberately NOT the same for the two kinds:
 *
 *  - petdex spritesheets bake their own frame geometry, so they carry an
 *    inline width/height (that is their intrinsic size) — unchanged.
 *  - the builtin SVG is a vector whose natural size is whatever its box is.
 *    It used to set an inline `width: size * scale` too, which was a bug:
 *    an inline style outranks every stylesheet rule, so the composer's
 *    `.gui-composer-pet` container clamp (34–46px) never applied and the
 *    pet rendered at the authoring scale instead. Docked on an input's edge
 *    that read as "a giant ball stuck on the window" (2026-09-20, user:
 *    「顶栏的小球怎么还是这么大，我换其他头像就正常」 — other presets never
 *    went through this branch). The wrapper now owns the width; the SVG
 *    keeps its aspect ratio through the box's `aspect-ratio`, so height
 *    follows for free. Hosts that need a fixed size (avatar slot, desktop
 *    pet window) set it on their own wrapper — see `.gui-avatar-pet`,
 *    `.pet-window__stage`.
 *
 *  `size` therefore only survives as the FALLBACK for a host that gives the
 *  box neither a width nor a height, so the mascot cannot collapse to 0. */
export function PetSprite({
	mood,
	state,
	tier,
	pet,
	size = 48,
	scale,
	frozen = false,
	gazeRef,
	interaction,
	gloss,
	accessory,
}: {
	mood: PetdexMood;
	/** Session state (pet.ts PetState) — only when the host has moved to the
	 *  state axis. Builtin: drives the 31-value face/motion tables and the
	 *  effects layer. Petdex: rides the same motion/effects engine
	 *  (PetdexStateStage) — the imported-pet parity with the builtin; the
	 *  face tables do not apply (no eye rings to project onto). */
	state?: PetState | null;
	/** Render-size tier — builtin and petdex state mode. Defaults to "full". */
	tier?: PetEffectTier;
	pet:
		| { kind: "builtin"; id: string }
		| {
				kind: "petdex";
				pkg: {
					spritesheet: string;
					width: number;
					height: number;
					format?: "sheet" | "svg";
					rows?: readonly number[];
					contentH?: number;
					smooth?: boolean;
				};
		  };
	/** Builtin-only fallback box (px) for hosts that size the wrapper via
	 *  CSS: used when the box has neither a width nor a height to resolve
	 *  against. Petdex ignores it — its sheet carries the real geometry. */
	size?: number;
	scale?: number;
	/** Passed through to PetdexSprite (freeze frame loop, keep transform). */
	frozen?: boolean;
	/** Eye-tracking target for the builtin sprite (petdex sheets ignore it —
	 *  their frames are baked bitmaps, the eyes cannot move). */
	gazeRef?: GazeRef;
	/** Transient user reaction, layered over `mood`. Builtin-only: an imported
	 *  spritesheet has no reaction rows to play, so it is ignored there rather
	 *  than remapping the pet to an unrelated row. */
	interaction?: PetInteraction | null;
	/** Builtin-only surface shading (pet-decor.ts). Pass the live pref from
	 *  usePet()/usePetDecor(); an explicit value previews an option in
	 *  settings. (Omitting does NOT read storage — there is no subscription
	 *  in this subtree.) */
	gloss?: boolean;
	/** Builtin-only wearable (pet-decor.ts). Same contract as `gloss`. */
	accessory?: PetAccessory;
}): ReactNode {
	if (pet.kind === "petdex") {
		// Sheets keep their own scale slider: their intrinsic size is the
		// frame grid, so nothing else can size them.
		return (
			<PetdexSprite
				mood={mood}
				src={pet.pkg.spritesheet}
				width={pet.pkg.width}
				height={pet.pkg.height}
				format={pet.pkg.format}
				rows={pet.pkg.rows}
				contentH={pet.pkg.contentH}
				scale={scale ?? petScale()}
				frozen={frozen}
				smooth={pet.pkg.smooth}
				state={state}
				tier={tier}
			/>
		);
	}
	// The builtin orb speaks hover/dragging natively — no face mapping.
	// The box publishes its own ratio (see PET_BOX_RATIO) so no stylesheet
	// has to hardcode a number that must track the VIEW constants.
	return (
		<div
			className="gui-pet"
			style={{ "--gui-pet-fallback": `${size}px`, "--gui-pet-ratio": `${PET_BOX_RATIO}` } as CSSProperties}
		>
			<BuiltinPetSprite
				mood={mood}
				state={state}
				tier={tier}
				gazeRef={gazeRef}
				interaction={interaction}
				gloss={gloss}
				accessory={accessory}
			/>
		</div>
	);
}
