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

import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
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

/* ── Builtin SVG mascot (note-bot v2, brand default) ─────────────────────
 * Geometry is original (MusePi = music + π): round head with headphones,
 * a quarter-note body, and mood-driven face layers. v2 (2026-09-16) adds
 * the delicacy pass: ground shadow, head gloss, antenna with mood pulse,
 * native hover/dragging faces, blinking, wandering pupils — all pure
 * transform/opacity keyframes (GPU-composited, no steps() → silky at any
 * window scale, unlike spritesheet frame stepping). The silhouette is
 * theme-agnostic (accent-tinted); the mood decals use currentColor so
 * they read on both light and dark surfaces. */

const VIEW_W = 320;
const VIEW_H = 204;

function Silhouette(): ReactNode {
	return (
		<g aria-hidden className="gui-pet-svg__silhouette">
			<defs>
				{/* Color-block gradient palette (no accent purple): mint→teal
				 * head, teal band, amber→rose cups, gold→orange note body. */}
				<linearGradient id="gui-pet-grad-head" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0" stopColor="var(--gui-pet-head-a, #34d399)" />
					<stop offset="1" stopColor="var(--gui-pet-head-b, #0ea5a5)" />
				</linearGradient>
				<linearGradient id="gui-pet-grad-band" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0" stopColor="var(--gui-pet-band-a, #14b8a6)" />
					<stop offset="1" stopColor="var(--gui-pet-band-b, #0f766e)" />
				</linearGradient>
				<linearGradient id="gui-pet-grad-cup" x1="0" y1="0" x2="1" y2="1">
					<stop offset="0" stopColor="var(--gui-pet-cup-a, #fdba74)" />
					<stop offset="1" stopColor="var(--gui-pet-cup-b, #fb7185)" />
				</linearGradient>
				<linearGradient id="gui-pet-grad-body" x1="0" y1="0" x2="0" y2="1">
					<stop offset="0" stopColor="var(--gui-pet-body-a, #fbbf24)" />
					<stop offset="1" stopColor="var(--gui-pet-body-b, #f97316)" />
				</linearGradient>
			</defs>
			{/* Ground shadow: breathes in counter-phase with the body lift so
			 * the pet reads as floating, not sliding. */}
			<ellipse className="gui-pet-svg__ground" cx="160" cy="193" rx="56" ry="7" />
			{/* Headphones: band + two cups */}
			<path
				className="gui-pet-svg__band"
				d="M95 78 A75 75 0 0 1 225 78 L225 92 A8 8 0 0 1 209 92 L209 84 A55 55 0 0 0 111 84 L111 92 A8 8 0 0 1 95 92 Z"
			/>
			<rect className="gui-pet-svg__cup" x="78" y="84" width="30" height="42" rx="12" />
			<rect className="gui-pet-svg__cup" x="212" y="84" width="30" height="42" rx="12" />
			{/* Cup inner detail: a soft inset sheen so the cups read rounded. */}
			<rect className="gui-pet-svg__cup-sheen" x="83" y="90" width="9" height="30" rx="4.5" />
			<rect className="gui-pet-svg__cup-sheen" x="217" y="90" width="9" height="30" rx="4.5" />
			{/* Head */}
			<circle className="gui-pet-svg__head" cx="160" cy="100" r="52" />
			{/* Gloss: a soft top-left highlight gives the head volume. */}
			<ellipse className="gui-pet-svg__gloss" cx="141" cy="76" rx="24" ry="13" />
			{/* Antenna: mood beacon on the band — gentle idle blink, rapid
			 * pulse while working. */}
			<path className="gui-pet-svg__antenna" d="M160 52 L160 34" />
			<circle className="gui-pet-svg__antenna-tip" cx="160" cy="29" r="5" />
			{/* Rosy cheeks (color-block accent over the head) */}
			<ellipse className="gui-pet-svg__blush" cx="137" cy="120" rx="11" ry="6.5" />
			<ellipse className="gui-pet-svg__blush" cx="183" cy="120" rx="11" ry="6.5" />
			{/* Body: rounded note flag */}
			<path
				className="gui-pet-svg__body"
				d="M118 152 C118 130 202 130 202 152 L202 178 C202 190 118 190 118 178 Z"
			/>
			<path
				className="gui-pet-svg__stem"
				d="M178 158 C186 142 198 136 210 134 L210 148 C200 150 190 156 186 168 Z"
			/>
		</g>
	);
}

/** Open rounded-rect eyes inside a blink group (blink keyframes live in
 *  gui-pet.css on .gui-pet-svg__blink), with a white sparkle dot each so
 *  the gaze reads alive. `dx` shifts the pair for looking-around moods. */
function OpenEyes(): ReactNode {
	return (
		<g className="gui-pet-svg__blink" aria-hidden>
			<rect className="gui-pet-svg__eye-open" x="142.5" y="90" width="8" height="15" rx="4" />
			<rect className="gui-pet-svg__eye-open" x="170.5" y="90" width="8" height="15" rx="4" />
			<circle className="gui-pet-svg__sparkle-dot" cx="145" cy="94" r="1.8" />
			<circle className="gui-pet-svg__sparkle-dot" cx="173" cy="94" r="1.8" />
		</g>
	);
}

function FaceRest(): ReactNode {
	return (
		<g className="gui-pet-svg__face" aria-hidden>
			<OpenEyes />
			<path className="gui-pet-svg__mouth" d="M154 112 Q160 117 166 112" />
		</g>
	);
}

function FaceHover(): ReactNode {
	return (
		<g className="gui-pet-svg__face" aria-hidden>
			{/* Wide, delighted eyes — bigger sparkles, lifted brows omitted
			 * (the window's hover lift already reads as anticipation). */}
			<g className="gui-pet-svg__blink" aria-hidden>
				<rect className="gui-pet-svg__eye-open" x="142" y="88" width="9" height="17" rx="4.5" />
				<rect className="gui-pet-svg__eye-open" x="170" y="88" width="9" height="17" rx="4.5" />
				<circle className="gui-pet-svg__sparkle-dot gui-pet-svg__sparkle-dot--big" cx="144.5" cy="93" r="2.4" />
				<circle className="gui-pet-svg__sparkle-dot gui-pet-svg__sparkle-dot--big" cx="172.5" cy="93" r="2.4" />
			</g>
			{/* Open happy mouth */}
			<path className="gui-pet-svg__mouth gui-pet-svg__mouth--open" d="M152 112 Q160 122 168 112 Z" />
			{/* Twinkle pluses around the head */}
			<path className="gui-pet-svg__twinkle gui-pet-svg__twinkle--a" d="M108 62 L108 74 M102 68 L114 68" />
			<path className="gui-pet-svg__twinkle gui-pet-svg__twinkle--b" d="M218 54 L218 66 M212 60 L224 60" />
			<path className="gui-pet-svg__twinkle gui-pet-svg__twinkle--c" d="M238 92 L238 102 M233 97 L243 97" />
		</g>
	);
}

function FaceDragging(): ReactNode {
	return (
		<g className="gui-pet-svg__face" aria-hidden>
			{/* Squeezed-shut "> <" eyes — the wheee face */}
			<path className="gui-pet-svg__xeye gui-pet-svg__xeye--drag" d="M140 92 L152 100 M152 92 L140 100" />
			<path className="gui-pet-svg__xeye gui-pet-svg__xeye--drag" d="M168 92 L180 100 M180 92 L168 100" />
			<ellipse className="gui-pet-svg__mouth-o" cx="160" cy="116" rx="7" ry="5.5" />
			{/* Wind streaks: the world rushing past while carried */}
			<path className="gui-pet-svg__wind gui-pet-svg__wind--a" d="M60 96 L92 96" />
			<path className="gui-pet-svg__wind gui-pet-svg__wind--b" d="M48 112 L84 112" />
			<path className="gui-pet-svg__wind gui-pet-svg__wind--c" d="M64 128 L96 128" />
		</g>
	);
}

function FaceAnalyzing(): ReactNode {
	return (
		<g className="gui-pet-svg__face" aria-hidden>
			{/* Pupils wander a slow scan path (up-left → up-right) — the
			 * keyframes in gui-pet.css move the whole eye group. */}
			<g className="gui-pet-svg__scan" aria-hidden>
				<circle className="gui-pet-svg__pupil" cx="146" cy="98" r="4" />
				<circle className="gui-pet-svg__pupil" cx="174" cy="98" r="4" />
			</g>
			<path className="gui-pet-svg__mouth" d="M150 114 Q160 121 170 114" />
			{/* Think pips ladder up */}
			<circle className="gui-pet-svg__pip gui-pet-svg__pip--a" cx="218" cy="86" r="4" />
			<circle className="gui-pet-svg__pip gui-pet-svg__pip--b" cx="230" cy="72" r="4" />
			<circle className="gui-pet-svg__pip gui-pet-svg__pip--c" cx="242" cy="58" r="4" />
		</g>
	);
}

function FaceWaiting(): ReactNode {
	return (
		<g className="gui-pet-svg__face" aria-hidden>
			<OpenEyes />
			<path className="gui-pet-svg__mouth" d="M154 112 Q160 117 166 112" />
			{/* Wait dots bob */}
			<circle className="gui-pet-svg__dot gui-pet-svg__dot--a" cx="210" cy="150" r="3" />
			<circle className="gui-pet-svg__dot gui-pet-svg__dot--b" cx="222" cy="150" r="3" />
			<circle className="gui-pet-svg__dot gui-pet-svg__dot--c" cx="234" cy="150" r="3" />
		</g>
	);
}

function FaceWorking(): ReactNode {
	return (
		<g className="gui-pet-svg__face" aria-hidden>
			{/* Focused pupils flick side-to-side (reading/typing cadence). */}
			<g className="gui-pet-svg__type" aria-hidden>
				<circle className="gui-pet-svg__pupil gui-pet-svg__pupil--tense" cx="146" cy="98" r="3.5" />
				<circle className="gui-pet-svg__pupil gui-pet-svg__pupil--tense" cx="174" cy="98" r="3.5" />
			</g>
			<path className="gui-pet-svg__mouth" d="M152 116 Q160 112 168 116" />
			{/* Sweat drop trickles */}
			<path className="gui-pet-svg__sweat" d="M96 92 Q92 100 96 104 Q100 100 96 92 Z" />
		</g>
	);
}

function FaceError(): ReactNode {
	return (
		<g className="gui-pet-svg__face" aria-hidden>
			{/* X eyes */}
			<path className="gui-pet-svg__xeye" d="M140 92 L152 104 M152 92 L140 104" />
			<path className="gui-pet-svg__xeye" d="M168 92 L180 104 M180 92 L168 104" />
			<path className="gui-pet-svg__mouth" d="M152 116 Q160 124 168 116" />
		</g>
	);
}

const FACE_BY_MOOD: Record<PetdexMood, () => ReactNode> = {
	rest: FaceRest,
	hover: FaceHover,
	dragging: FaceDragging,
	working: FaceWorking,
	waiting: FaceWaiting,
	analyzing: FaceAnalyzing,
	error: FaceError,
};

/** Builtin SVG pet (note-bot v2) — natively speaks every PetdexMood,
 *  including the floating desktop pet's hover/dragging rows. */
export function BuiltinPetSprite({ mood }: { mood: PetdexMood }): ReactNode {
	const Face = FACE_BY_MOOD[mood];
	return (
		<svg
			className={`gui-pet-svg gui-pet-svg--${mood}`}
			viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
			xmlns="http://www.w3.org/2000/svg"
			aria-hidden
		>
			<Silhouette />
			<Face />
		</svg>
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
	// The builtin v2 speaks hover/dragging natively — no face mapping.
	return (
		<div className="gui-pet" style={{ width: size * s, height: size * s * (VIEW_H / VIEW_W) }}>
			<BuiltinPetSprite mood={mood} />
		</div>
	);
}
