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
	PET_CONTENT_TARGET_H,
	PETDEX_COLUMNS,
	PETDEX_MOOD_ANIM,
	PETDEX_MOOD_ROW,
	PETDEX_ROW_FRAMES_DEFAULT,
	PETDEX_ROWS,
	type PetDisplayMode,
	type PetdexMood,
	type PetInteraction,
	petEnabled,
	petMode,
	petScale,
} from "../lib/pet";
import { type PetAccessory, type PetDecor, petDecor } from "../lib/pet-decor";
import {
	applyYaw,
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
	toPath,
} from "../lib/pet-face";
import { gazeDrift, INTERACTION_MOTION, MOOD_MOTION, motionTransform } from "../lib/pet-motion";

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
 *  replays the morph and the one-shot entrance exactly like a mood change. */
function useMascotEngine(mood: PetdexMood, gazeRef?: GazeRef, interaction?: PetInteraction | null): MascotRefs {
	const eye0 = useRef<SVGPathElement | null>(null);
	const eye1 = useRef<SVGPathElement | null>(null);
	const mouthRef = useRef<SVGPathElement | null>(null);
	const shellRef = useRef<SVGGElement | null>(null);
	const gazeSmooth = useRef({ x: 0, y: 0, att: 0 });

	// Static per-mood face data — decoded once per mood, never per frame.
	const prepped = useMemo(() => {
		const dir = interaction ? interactionDirection(interaction) : moodDirection(mood);
		const base = faceFor(dir.eyes);
		return {
			base,
			drift: faceFor(dir.drift ?? dir.eyes),
			lash: faceFor("closed"),
			mouth: mouthSpecFor(dir.eyes),
			mouthDrift: mouthSpecFor(dir.drift ?? dir.eyes),
			blinkMs: dir.blinkMs,
			look: dir.look,
			motion: (interaction ? INTERACTION_MOTION[interaction] : MOOD_MOTION[mood]) ?? {},
		};
	}, [mood, interaction]);

	useEffect(() => {
		const clock = { start: performance.now(), last: performance.now() };
		// Morph + blink phase live in the effect closure, so changing mood
		// never restarts the body clock (an entrance animation would replay).
		const from: Face = prepped.base;
		let morphT = 1;
		let blinkT = 1;
		let nextBlink = clock.start + 900;
		let raf = 0;
		// Seed the paths so the first frame never paints an invalid empty d.
		eye0.current?.setAttribute("d", toPath(prepped.base[0]));
		eye1.current?.setAttribute("d", toPath(prepped.base[1]));

		const tick = (now: number): void => {
			const dt = Math.min(now - clock.last, 64);
			clock.last = now;
			const elapsed = now - clock.start;

			// ── blink: fast close, slower open, on the mood's cadence.
			if (prepped.blinkMs > 0 && blinkT >= 1 && now >= nextBlink) {
				blinkT = 0;
				nextBlink = now + prepped.blinkMs;
			}
			if (blinkT < 1) blinkT = Math.min(1, blinkT + dt / (blinkT < 0.5 ? BLINK_DOWN_MS : BLINK_UP_MS));

			// ── face morph.
			if (morphT < 1) morphT = Math.min(1, morphT + dt / MORPH_MS);
			const base = lerpFace(from, prepped.base, springStep(morphT));
			// The drift face eases in on a slow sine once the morph has landed,
			// so a long idle keeps making new faces without ever looking busy.
			const driftT = morphT >= 1 ? (Math.sin(elapsed / 3400) * 0.5 + 0.5) * DRIFT_MAX : 0;
			let rings = lerpFace(base, prepped.drift, driftT);
			let spec = mixSpec(prepped.mouth, prepped.mouthDrift, morphT >= 1 ? driftT / DRIFT_MAX : 0);
			if (blinkT < 1) {
				// Ease toward the lash on both halves of the blink. `blinkT`
				// runs 0→1 across close-then-open, so the bell is the weight.
				const w = blinkT < 0.5 ? blinkT * 2 : (1 - blinkT) * 2;
				rings = lerpFace(rings, prepped.lash, w * 0.96);
				spec = mixSpec(spec, prepped.mouth, w * 0.6);
			}

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
				const motion = motionTransform(prepped.motion, elapsed, 1, FACE_BOX);
				shell.setAttribute("transform", `translate(${SIDE} ${TOP}) ${motion}`.trim());
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [prepped]);

	return { eyeRefs: [eye0, eye1], mouthRef, shellRef };
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

function Mascot({
	mood,
	gazeRef,
	interaction,
	gloss,
	accessory = "none",
}: {
	mood: PetdexMood;
	gazeRef?: GazeRef;
	interaction?: PetInteraction | null;
	gloss: boolean;
	accessory?: PetAccessory;
}): ReactNode {
	const refs = useMascotEngine(mood, gazeRef, interaction);
	// Both classes ride the svg: `--<mood>` carries the MATERIAL state (the
	// error face's red eye, hover's brightened glow, waiting's dimmed light —
	// all pure-CSS), while `--<interaction>` carries the reaction. Dropping
	// the mood class during a reaction would silently reset those materials,
	// so the reaction is additive rather than a replacement.
	return (
		<svg
			className={`gui-pet-svg gui-pet-svg--${mood}${gloss ? "" : " gui-pet-svg--flat"}${interaction ? ` gui-pet-svg--${interaction}` : ""}`}
			viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
			xmlns="http://www.w3.org/2000/svg"
			aria-hidden
		>
			<Silhouette {...refs} gloss={gloss} accessory={accessory} />
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
	gloss,
	accessory,
}: MascotRefs & { gloss: boolean; accessory: PetAccessory }): ReactNode {
	return (
		<g aria-hidden className="gui-pet-svg__silhouette">
			<defs>
				{/* Shell: an accent-hued sphere lit from the upper left — lit
				 * crown, body, terminator. The fallback trio is the brand-gold
				 * dark-theme derivation (pet-palette.ts: L .56/.36/.19 at the
				 * accent hue, low chroma), so the pre-palette first paint is
				 * already the warm orb rather than a cold slate ball. Two
				 * different wrong-graphite fallbacks have shipped here before
				 * (#4a5768/#26303d/#0e141c then #7d7159/#453a24/#1c1408) and
				 * both were reported as 「颜色都是黑色球体而不是主题色」 /
				 * 「品牌金色，但显示的还是黑色带点黄」 — the lesson is that
				 * the fallback must be the DERIVED value, not a hand-picked
				 * "close enough" one. PetPaletteVars is the single source. */}
				<radialGradient id="gui-pet-grad-shell" cx="0.34" cy="0.26" r="0.92">
					<stop offset="0" stopColor="var(--gui-pet-shell-a, oklch(56.00% 0.0450 79.84deg))" />
					<stop offset="0.5" stopColor="var(--gui-pet-shell-b, oklch(36.00% 0.0500 79.84deg))" />
					<stop offset="1" stopColor="var(--gui-pet-shell-c, oklch(19.00% 0.0450 79.84deg))" />
				</radialGradient>
				{/* Orbit ring: the accent (brand gold by default), brightest where
				 * it crosses the light (top-left) and dimmest at the far side.
				 * This is the surface that carries the theme, now that the face
				 * is white. */}
				<linearGradient id="gui-pet-grad-ring" x1="0" y1="0" x2="1" y2="1">
					<stop offset="0" stopColor="var(--gui-pet-gold-a, oklch(87.07% 0.1400 79.84deg))" />
					<stop offset="0.55" stopColor="var(--gui-pet-gold-b, oklch(75.07% 0.1295 79.84deg))" />
					<stop offset="1" stopColor="var(--gui-pet-gold-c, oklch(46.54% 0.1166 79.84deg))" />
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
				 * and then driven by the frame loop for mood motion. */}
				<g ref={shellRef} transform={`translate(${SIDE} ${TOP})`}>
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
					{/* Rim light down the right edge — sits just inside the
					 * silhouette so it reads as light on the sphere, not as a
					 * stroke around it. Always on: it is what separates the ball
					 * from a dark chat background, so it is not decoration. */}
					<path
						className="gui-pet-svg__rim"
						d={`M${ORB_C + 74} ${ORB_C + 82} A${ORB_R - 3} ${ORB_R - 3} 0 0 0 ${ORB_C + 92} ${ORB_C + 8}`}
					/>
					{/* The face, in the engine's own coordinates — no offset needed,
					 * because the rig already sits on the sphere centre. All three
					 * paths are rewritten every frame. */}
					<g className="gui-pet-svg__face">
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
						<g className="gui-pet-svg__accessory">
							{/* Band: one arc over the crown, endpoints meeting the
							 * cups' tops (cup top ≈ y 78, apex ≈ y −4 — 4px above
							 * the shell, inside the rig's headroom). Gold carries
							 * the accent; cups stay shell-dark with a gold rim so
							 * the wear reads as part of the body, not a sticker. */}
							<path
								d={`M -2 ${ORB_C - 36} A 123.3 123.3 0 0 1 ${2 * ORB_C + 2} ${ORB_C - 36}`}
								fill="none"
								stroke="url(#gui-pet-grad-ring)"
								strokeWidth="9"
								strokeLinecap="round"
							/>
							<ellipse
								cx={ORB_C - ORB_R - 2}
								cy={ORB_C - 10}
								rx="13"
								ry="26"
								transform={`rotate(-14 ${ORB_C - ORB_R - 2} ${ORB_C - 10})`}
								fill="url(#gui-pet-grad-shell)"
								stroke="url(#gui-pet-grad-ring)"
								strokeWidth="2.5"
							/>
							<ellipse
								cx={ORB_C + ORB_R + 2}
								cy={ORB_C - 10}
								rx="13"
								ry="26"
								transform={`rotate(14 ${ORB_C + ORB_R + 2} ${ORB_C - 10})`}
								fill="url(#gui-pet-grad-shell)"
								stroke="url(#gui-pet-grad-ring)"
								strokeWidth="2.5"
							/>
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
	gazeRef,
	interaction,
	gloss = true,
	accessory = "none",
}: {
	mood: PetdexMood;
	gazeRef?: GazeRef;
	interaction?: PetInteraction | null;
	gloss?: boolean;
	accessory?: PetAccessory;
}): ReactNode {
	return <Mascot mood={mood} gazeRef={gazeRef} interaction={interaction} gloss={gloss} accessory={accessory} />;
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

/** Petdex spritesheet pet — CSS background-position frame animation with a
 *  mood-driven cycle speed and a paired transform animation (BitFun parity:
 *  rest breathes slowly, working bobs fast, hover lifts, dragging wiggles).
 *  `mood` accepts the petdex-only hover/dragging states (rows 1/2) that the
 *  floating desktop pet uses. `contentH` (rest-row content height, scanned
 *  at import / known for builtins) normalizes the visual size so imported
 *  sheets with larger frames render at the same body size as builtins;
 *  `scale` is the user's size slider (0.6–1.5). */
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
				gazeRef={gazeRef}
				interaction={interaction}
				gloss={gloss}
				accessory={accessory}
			/>
		</div>
	);
}
