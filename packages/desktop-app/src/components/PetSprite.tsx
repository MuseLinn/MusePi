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
	visorPath,
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
	visorRef: RefObject<SVGPathElement | null>;
	eyeRefs: [RefObject<SVGPathElement | null>, RefObject<SVGPathElement | null>];
	mouthRef: RefObject<SVGPathElement | null>;
	shellRef: RefObject<SVGGElement | null>;
}

/** Blend weight of the mood's `drift` face during idle — subtle on purpose.
 *  The face should feel like it keeps finding new poses to rest in, not like
 *  it is cycling a slideshow. */
const DRIFT_MAX = 0.18;

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
function useMascotEngine(mood: PetdexMood): MascotRefs {
	const visorRef = useRef<SVGPathElement | null>(null);
	const eye0 = useRef<SVGPathElement | null>(null);
	const eye1 = useRef<SVGPathElement | null>(null);
	const mouthRef = useRef<SVGPathElement | null>(null);
	const shellRef = useRef<SVGGElement | null>(null);

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
		// A blank visor path is invalid SVG on the very first frame — seed it.
		visorRef.current?.setAttribute("d", visorPath(prepped.base));
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
			// so the eyes slide across the sphere and compress at the limb.
			const gaze = gazeDrift(elapsed, prepped.look);
			const gx = gaze.x * GAZE_TRAVEL.x;
			const gy = gaze.y * GAZE_TRAVEL.y;
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
			visorRef.current?.setAttribute("d", visorPath(face));
			const frame = mouthFrame(face, spec);
			mouthRef.current?.setAttribute("d", mouthPath(frame, spec));
			mouthRef.current?.setAttribute("stroke-width", mouthStroke(spec).toFixed(2));

			// ── body. Face units → the view box, then the mood's motion on top
			// in view-box space so the spec's numbers stay in face units.
			const shell = shellRef.current;
			if (shell) {
				const k = FACE_ANCHOR.scale;
				shell.setAttribute(
					"transform",
					`translate(${FACE_ANCHOR.x} ${FACE_ANCHOR.y}) scale(${k}) ` +
						`translate(${-FACE_BOX / 2} ${-FACE_BOX / 2})`,
				);
				const motion = motionTransform(prepped.motion, elapsed, 1, FACE_BOX);
				const rig = shell.parentNode;
				if (rig instanceof SVGGElement) rig.setAttribute("transform", motion);
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [prepped]);

	return { visorRef, eyeRefs: [eye0, eye1], mouthRef, shellRef };
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

const VIEW_W = 320;
const VIEW_H = 248;

/** Where the orb's face sits in the view box. The engine emits face-space
 *  coordinates (a FACE_BOX square centred on the sphere); this maps them onto
 *  the shell at the size the silhouette was drawn for. */
const FACE_ANCHOR = { x: 160, y: 116, scale: 0.61 };

function Mascot({ mood }: { mood: PetdexMood }): ReactNode {
	const refs = useMascotEngine(mood);
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
function Silhouette({ visorRef, eyeRefs, mouthRef, shellRef }: MascotRefs): ReactNode {
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
				{/* Visor: near-black glass with a vertical falloff, so the face
				 * panel reads recessed into the shell instead of painted on. */}
				<radialGradient id="gui-pet-grad-visor" cx="0.42" cy="0.22" r="0.92">
					<stop offset="0" stopColor="#141d2a" />
					<stop offset="0.6" stopColor="#0a1018" />
					<stop offset="1" stopColor="#05080d" />
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
			 * drifts above them — deliberately outside the motion group. */}
			<ellipse className="gui-pet-svg__ground" cx="160" cy="230" rx="52" ry="7.5" />
			<ellipse className="gui-pet-svg__thrust" cx="160" cy="225" rx="44" ry="12" />
			<g className="gui-pet-svg__body">
				<g ref={shellRef}>
					{/* Orbit ring, back half — behind the shell, so the front arc
					 * reads as the same loop coming round. */}
					<ellipse
						className="gui-pet-svg__ring gui-pet-svg__ring--back"
						cx="160"
						cy="114"
						rx="90"
						ry="31"
						transform="rotate(-18 160 114)"
					/>
					{/* Shell */}
					<circle className="gui-pet-svg__shell" cx="160" cy="114" r="64" />
					{/* Crown gloss + secondary catch-light: cheap sphericity. */}
					<ellipse
						className="gui-pet-svg__gloss"
						cx="136"
						cy="80"
						rx="24"
						ry="11.5"
						transform="rotate(-22 136 80)"
					/>
					<ellipse
						className="gui-pet-svg__gloss-dot"
						cx="119"
						cy="98"
						rx="5.5"
						ry="3.2"
						transform="rotate(-22 119 98)"
					/>
					{/* Bounce light along the bottom + rim down the right edge. */}
					<ellipse className="gui-pet-svg__bounce" cx="157" cy="172" rx="40" ry="9" />
					<path className="gui-pet-svg__rim" d="M220 122 A64 64 0 0 1 133 172" />
					{/* Specular sweep drifting across the crown. */}
					<ellipse
						className="gui-pet-svg__sweep"
						cx="147"
						cy="74"
						rx="12"
						ry="4.6"
						transform="rotate(-22 147 74)"
					/>
					{/* The face: dark panel, two eyes, mouth. All four paths are
					 * rewritten every frame by the engine. */}
					<g className="gui-pet-svg__face">
						<path className="gui-pet-svg__visor" ref={visorRef} />
						<path className="gui-pet-svg__eye" ref={eyeRefs[0]} />
						<path className="gui-pet-svg__eye" ref={eyeRefs[1]} />
						<path className="gui-pet-svg__mouth" ref={mouthRef} />
					</g>
					{/* π brand mark, etched low on the shell. */}
					<g className="gui-pet-svg__crest">
						<path d="M151 161 H169" />
						<path d="M157 161 V172" />
						<path d="M165 161 V172" />
					</g>
					{/* Beacon mast on the crown: idle sway, fast pulse while
					 * working. Drawn over the shell so it reads as mounted. */}
					<g className="gui-pet-svg__antenna-group">
						<path className="gui-pet-svg__antenna" d="M160 50 L160 34" />
						<circle className="gui-pet-svg__antenna-halo" cx="160" cy="28" r="9" />
						<circle className="gui-pet-svg__antenna-tip" cx="160" cy="28" r="5" />
					</g>
				</g>
			</g>
		</g>
	);
}

/** Builtin SVG pet (orb-bot v7) — natively speaks every PetdexMood,
 *  including the floating desktop pet's hover/dragging rows. */
export function BuiltinPetSprite({ mood }: { mood: PetdexMood }): ReactNode {
	return <Mascot mood={mood} />;
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
			<BuiltinPetSprite mood={mood} />
		</div>
	);
}
