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
	petEnabled,
	petMode,
	petScale,
} from "../lib/pet";
import {
	applyYaw,
	FACE_BOX,
	type Face,
	faceFor,
	GAZE_TRAVEL,
	gazeYaw,
	lerpFace,
	moodDirection,
	mouthFrame,
	mouthPath,
	mouthSpecFor,
	mouthStroke,
	springStep,
	toPath,
} from "../lib/pet-face";
import { gazeDrift, MOOD_MOTION, motionTransform } from "../lib/pet-motion";

/** Live pet prefs: re-resolves when settings change (the settings page
 *  dispatches "omp-pet-changed" after saving; storage events cover other
 *  tabs/pet windows). */
export function usePet(): { enabled: boolean; mode: PetDisplayMode; pet: ReturnType<typeof activePet> } {
	const [state, setState] = useState(() => ({ enabled: petEnabled(), mode: petMode(), pet: activePet() }));
	useEffect(() => {
		// Old imported packages lack the contentH scan — backfill once so
		// their render size normalizes like builtins.
		migratePetdexContent();
		const refresh = (): void => setState({ enabled: petEnabled(), mode: petMode(), pet: activePet() });
		window.addEventListener("omp-pet-changed", refresh);
		window.addEventListener("storage", refresh);
		return () => {
			window.removeEventListener("omp-pet-changed", refresh);
			window.removeEventListener("storage", refresh);
		};
	}, []);
	return state;
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
 *  the cursor (attack/glide); absent/omitted → authored drift only. */
function useMascotEngine(mood: PetdexMood, gazeRef?: GazeRef): MascotRefs {
	const eye0 = useRef<SVGPathElement | null>(null);
	const eye1 = useRef<SVGPathElement | null>(null);
	const mouthRef = useRef<SVGPathElement | null>(null);
	const shellRef = useRef<SVGGElement | null>(null);
	const gazeSmooth = useRef({ x: 0, y: 0, att: 0 });

	// Static per-mood face data — decoded once per mood, never per frame.
	const prepped = useMemo(() => {
		const dir = moodDirection(mood);
		const base = faceFor(dir.eyes);
		return {
			base,
			drift: faceFor(dir.drift ?? dir.eyes),
			lash: faceFor("closed"),
			mouth: mouthSpecFor(dir.eyes),
			mouthDrift: mouthSpecFor(dir.drift ?? dir.eyes),
			blinkMs: dir.blinkMs,
			look: dir.look,
			motion: MOOD_MOTION[mood] ?? {},
		};
	}, [mood]);

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
				shell.setAttribute("transform", `translate(${SIDE} ${HEADROOM}) ${motion}`.trim());
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

/** The orb plus the breathing room the antenna, orbit ring and ground shadow
 *  need. The engine authors the face in a FACE_BOX square and the silhouette
 *  *is* that square, so the face paints at scale 1 straight onto the ball with
 *  no anchor scale to keep in sync — the rig only needs headroom above and a
 *  floor below.
 *
 *  Everything inside the rig is authored around the sphere centre (FACE_BOX/2,
 *  matching the engine's own SPHERE_C); the rig itself is shifted down by
 *  PAD_TOP once, in the frame loop, so the padding never leaks into the art. */
const HEADROOM = 40;
const SIDE = 26;
const FLOOR = 30;
const VIEW_W = FACE_BOX + SIDE * 2;
const VIEW_H = FACE_BOX + HEADROOM + FLOOR;

/** Sphere centre in orb-local coordinates — the engine's own SPHERE_C. The
 *  rig shifts this down by HEADROOM and right by SIDE into the padded view. */
const ORB_C = FACE_BOX / 2;
const ORB_R = FACE_BOX / 2;

function Mascot({ mood, gazeRef }: { mood: PetdexMood; gazeRef?: GazeRef }): ReactNode {
	const refs = useMascotEngine(mood, gazeRef);
	return (
		<svg
			className={`gui-pet-svg gui-pet-svg--${mood}`}
			viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
			xmlns="http://www.w3.org/2000/svg"
			aria-hidden
		>
			<Silhouette {...refs} />
		</svg>
	);
}

/** The silhouette, the materials and the mounting points the engine drives.
 *  Order matters: the orbit ring is drawn in two halves so it reads as one
 *  loop passing around the body rather than a band stuck on its front. */
function Silhouette({ eyeRefs, mouthRef, shellRef }: MascotRefs): ReactNode {
	return (
		<g aria-hidden className="gui-pet-svg__silhouette">
			<defs>
				{/* Shell: a graphite sphere lit from the upper left — lit crown,
				 * body, terminator. Dark reads as hardware, and it lets the gold
				 * light do the talking. */}
				<radialGradient id="gui-pet-grad-shell" cx="0.34" cy="0.26" r="0.92">
					<stop offset="0" stopColor="var(--gui-pet-shell-a, #4a5768)" />
					<stop offset="0.5" stopColor="var(--gui-pet-shell-b, #26303d)" />
					<stop offset="1" stopColor="var(--gui-pet-shell-c, #0e141c)" />
				</radialGradient>
				{/* Orbit ring: brand gold, brightest where it crosses the light
				 * (top-left) and dimmest at the far side. */}
				<linearGradient id="gui-pet-grad-ring" x1="0" y1="0" x2="1" y2="1">
					<stop offset="0" stopColor="var(--gui-pet-gold-a, #f7dd93)" />
					<stop offset="0.55" stopColor="var(--gui-pet-gold-b, #d9a83f)" />
					<stop offset="1" stopColor="var(--gui-pet-gold-c, #8a6420)" />
				</linearGradient>
				{/* Bounce: warm gold thrown back up from the surface the orb hovers
				 * over — the cue that sells "floating". */}
				<radialGradient id="gui-pet-grad-bounce" cx="0.5" cy="0.5" r="0.5">
					<stop offset="0" stopColor="var(--gui-pet-gold-b, #d9a83f)" stopOpacity="0.5" />
					<stop offset="1" stopColor="var(--gui-pet-gold-b, #d9a83f)" stopOpacity="0" />
				</radialGradient>
				{/* Thrust: the hover glow under the shell. */}
				<radialGradient id="gui-pet-grad-thrust" cx="0.5" cy="0.5" r="0.5">
					<stop offset="0" stopColor="var(--gui-pet-gold-b, #d9a83f)" stopOpacity="0.44" />
					<stop offset="0.6" stopColor="var(--gui-pet-gold-b, #d9a83f)" stopOpacity="0.14" />
					<stop offset="1" stopColor="var(--gui-pet-gold-b, #d9a83f)" stopOpacity="0" />
				</radialGradient>
				{/* Ground shadow: neutral falloff, cooler than the gold. */}
				<radialGradient id="gui-pet-grad-ground" cx="0.5" cy="0.5" r="0.5">
					<stop offset="0" stopColor="#0b1220" stopOpacity="0.4" />
					<stop offset="0.62" stopColor="#0b1220" stopOpacity="0.17" />
					<stop offset="1" stopColor="#0b1220" stopOpacity="0" />
				</radialGradient>
				{/* Eye light: gold with a hot core. A flat fill reads as paint;
				 * a gradient reads as something emitting. */}
				<radialGradient id="gui-pet-grad-eye" cx="0.5" cy="0.3" r="0.78">
					<stop offset="0" stopColor="#fffaf0" />
					<stop offset="0.4" stopColor="var(--gui-pet-gold-a, #f7dd93)" />
					<stop offset="1" stopColor="var(--gui-pet-gold-b, #d9a83f)" />
				</radialGradient>
				<radialGradient id="gui-pet-grad-eye-err" cx="0.5" cy="0.3" r="0.78">
					<stop offset="0" stopColor="#ffd9d5" />
					<stop offset="0.45" stopColor="var(--color-danger)" />
					<stop offset="1" stopColor="color-mix(in oklab, var(--color-danger) 60%, #000)" />
				</radialGradient>
			</defs>
			{/* Ground shadow + hover thrust stay on the ground while the shell
			 * drifts above them — deliberately outside the motion group, and in
			 * view coordinates because they do not move with the orb. */}
			<ellipse className="gui-pet-svg__ground" cx={SIDE + ORB_C} cy={HEADROOM + ORB_C + ORB_R + 20} rx="58" ry="8" />
			<ellipse
				className="gui-pet-svg__thrust"
				cx={SIDE + ORB_C}
				cy={HEADROOM + ORB_C + ORB_R + 14}
				rx="50"
				ry="13"
			/>
			<g className="gui-pet-svg__body">
				{/* The rig. Orb-local coordinates; shifted into the padded view
				 * and then driven by the frame loop for mood motion. */}
				<g ref={shellRef} transform={`translate(${SIDE} ${HEADROOM})`}>
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
					{/* Crown gloss + secondary catch-light: cheap sphericity. */}
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
					{/* Bounce light along the bottom + rim down the right edge.
					 * Both sit just inside the silhouette so they read as light
					 * on the sphere, not as a stroke around it. */}
					<ellipse className="gui-pet-svg__bounce" cx={ORB_C - 2} cy={ORB_C + 78} rx="48" ry="11" />
					<path
						className="gui-pet-svg__rim"
						d={`M${ORB_C + 74} ${ORB_C + 82} A${ORB_R - 3} ${ORB_R - 3} 0 0 0 ${ORB_C + 92} ${ORB_C + 8}`}
					/>
					{/* Specular sweep drifting across the crown. */}
					<ellipse
						className="gui-pet-svg__sweep"
						cx={ORB_C - 20}
						cy={ORB_C - 64}
						rx="15"
						ry="5.6"
						transform={`rotate(-22 ${ORB_C - 20} ${ORB_C - 64})`}
					/>
					{/* The face, in the engine's own coordinates — no offset needed,
					 * because the rig already sits on the sphere centre. All three
					 * paths are rewritten every frame. */}
					<g className="gui-pet-svg__face">
						<path className="gui-pet-svg__eye" ref={eyeRefs[0]} />
						<path className="gui-pet-svg__eye" ref={eyeRefs[1]} />
						<path className="gui-pet-svg__mouth" ref={mouthRef} />
					</g>
					{/* Beacon mast on the crown: idle sway, fast pulse while
					 * working. Drawn over the shell so it reads as mounted. */}
					<g className="gui-pet-svg__antenna-group">
						<path
							className="gui-pet-svg__antenna"
							d={`M${ORB_C} ${ORB_C - ORB_R + 6} L${ORB_C} ${ORB_C - ORB_R - 16}`}
						/>
						<circle className="gui-pet-svg__antenna-halo" cx={ORB_C} cy={ORB_C - ORB_R - 22} r="11" />
						<circle className="gui-pet-svg__antenna-tip" cx={ORB_C} cy={ORB_C - ORB_R - 22} r="6" />
					</g>
				</g>
			</g>
		</g>
	);
}

/** Builtin SVG pet (orb-bot v7) — natively speaks every PetdexMood,
 *  including the floating desktop pet's hover/dragging rows. `gazeRef`
 *  (optional) turns eye tracking on — see GazeVec. */
export function BuiltinPetSprite({ mood, gazeRef }: { mood: PetdexMood; gazeRef?: GazeRef }): ReactNode {
	return <Mascot mood={mood} gazeRef={gazeRef} />;
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
	const frameW = width / PETDEX_COLUMNS;
	const frameH = height / PETDEX_ROWS;
	const anim = PETDEX_MOOD_ANIM[mood];
	const row = PETDEX_MOOD_ROW[mood];
	// Cycle only the row's valid frames — sheets pad calm rows with empty
	// columns, and stepping into one blanks the pet for a frame each loop.
	const valid = Math.min(PETDEX_COLUMNS, Math.max(1, (rows ?? PETDEX_ROW_FRAMES_DEFAULT)[row] ?? PETDEX_COLUMNS));
	// Body-size normalization + user scale: scale the frame and the whole
	// sheet together (background-size must match the element scaling).
	const k = scale * (contentH && contentH > 0 ? PET_CONTENT_TARGET_H / contentH : 1);
	const style: CSSProperties = {
		width: `${frameW * k}px`,
		height: `${frameH * k}px`,
		backgroundImage: `url("${src}")`,
		backgroundSize: `${width * k}px ${height * k}px`,
		backgroundPosition: `0 ${-(row * frameH * k)}px`,
		animation: frozen
			? `gui-petdex-${anim.transform} ${anim.transformMs}ms ease-in-out infinite`
			: `gui-petdex-cycle ${anim.cycleMs}ms steps(${valid}) infinite, gui-petdex-${anim.transform} ${anim.transformMs}ms ease-in-out infinite`,
		...(frozen ? {} : { "--gui-petdex-cycle-end": `${-(frameW * valid * k)}px` }),
	} as CSSProperties;
	return (
		<div
			className={`gui-petdex-sprite gui-petdex-sprite--${mood}${smooth ? " gui-petdex-sprite--smooth" : ""}`}
			style={style}
			aria-hidden
		/>
	);
}

/** Unified pet renderer: builtin or petdex, sized via CSS font-size scale.
 *  `mood` accepts the petdex-only hover/dragging states (rows 1/2); the
 *  builtin SVG maps them to its closest faces. `scale` defaults to the
 *  settings slider (musepi-gui-pet-scale, 0.6–1.5); pass it explicitly when
 *  the caller tracks the pref itself (desktop pet window). */
export function PetSprite({
	mood,
	pet,
	size = 48,
	scale,
	frozen = false,
	gazeRef,
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
					rows?: readonly number[];
					contentH?: number;
					smooth?: boolean;
				};
		  };
	size?: number;
	scale?: number;
	/** Passed through to PetdexSprite (freeze frame loop, keep transform). */
	frozen?: boolean;
	/** Eye-tracking target for the builtin sprite (petdex sheets ignore it —
	 *  their frames are baked bitmaps, the eyes cannot move). */
	gazeRef?: GazeRef;
}): ReactNode {
	const s = scale ?? petScale();
	if (pet.kind === "petdex") {
		return (
			<PetdexSprite
				mood={mood}
				src={pet.pkg.spritesheet}
				width={pet.pkg.width}
				height={pet.pkg.height}
				rows={pet.pkg.rows}
				contentH={pet.pkg.contentH}
				scale={s}
				frozen={frozen}
				smooth={pet.pkg.smooth}
			/>
		);
	}
	// The builtin orb speaks hover/dragging natively — no face mapping.
	return (
		<div className="gui-pet" style={{ width: size * s, height: size * s * (VIEW_H / VIEW_W) }}>
			<BuiltinPetSprite mood={mood} gazeRef={gazeRef} />
		</div>
	);
}
