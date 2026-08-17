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
	type PetMood,
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

/* ── Builtin SVG mascot (note-bot) ───────────────────────────────────────
 * Geometry is original (MusePi = music + π): round head with headphones,
 * a quarter-note body, and mood-driven face layers below. The silhouette
 * is theme-agnostic (accent-tinted); the mood decals use currentColor so
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
			{/* Headphones: band + two cups */}
			<path
				className="gui-pet-svg__band"
				d="M95 78 A75 75 0 0 1 225 78 L225 92 A8 8 0 0 1 209 92 L209 84 A55 55 0 0 0 111 84 L111 92 A8 8 0 0 1 95 92 Z"
			/>
			<rect className="gui-pet-svg__cup" x="78" y="84" width="30" height="42" rx="12" />
			<rect className="gui-pet-svg__cup" x="212" y="84" width="30" height="42" rx="12" />
			{/* Head */}
			<circle className="gui-pet-svg__head" cx="160" cy="100" r="52" />
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

function FaceRest(): ReactNode {
	return (
		<g className="gui-pet-svg__face" aria-hidden>
			{/* Closed eyes */}
			<path className="gui-pet-svg__eye" d="M138 96 Q146 103 154 96" />
			<path className="gui-pet-svg__eye" d="M166 96 Q174 103 182 96" />
			<path className="gui-pet-svg__mouth" d="M154 112 Q160 117 166 112" />
			{/* ZZZ decal */}
			<text className="gui-pet-svg__zzz gui-pet-svg__zzz--a" x="216" y="70">
				z
			</text>
			<text className="gui-pet-svg__zzz gui-pet-svg__zzz--b" x="230" y="52">
				Z
			</text>
		</g>
	);
}

function FaceAnalyzing(): ReactNode {
	return (
		<g className="gui-pet-svg__face" aria-hidden>
			<circle className="gui-pet-svg__pupil" cx="146" cy="98" r="4" />
			<circle className="gui-pet-svg__pupil" cx="174" cy="98" r="4" />
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
			<circle className="gui-pet-svg__pupil" cx="146" cy="98" r="4" />
			<circle className="gui-pet-svg__pupil" cx="174" cy="98" r="4" />
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
			<circle className="gui-pet-svg__pupil gui-pet-svg__pupil--tense" cx="146" cy="98" r="3.5" />
			<circle className="gui-pet-svg__pupil gui-pet-svg__pupil--tense" cx="174" cy="98" r="3.5" />
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

const FACE_BY_MOOD: Record<PetMood, () => ReactNode> = {
	rest: FaceRest,
	working: FaceWorking,
	waiting: FaceWaiting,
	analyzing: FaceAnalyzing,
	error: FaceError,
};

/** Builtin SVG pet (note-bot). */
export function BuiltinPetSprite({ mood }: { mood: PetMood }): ReactNode {
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
	return <div className={`gui-petdex-sprite gui-petdex-sprite--${mood}`} style={style} aria-hidden />;
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
				pkg: { spritesheet: string; width: number; height: number; rows?: readonly number[]; contentH?: number };
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
			/>
		);
	}
	// The builtin SVG has no hover/dragging rows — show its closest faces.
	const svgMood: PetMood = mood === "hover" ? "analyzing" : mood === "dragging" ? "working" : mood;
	return (
		<div className="gui-pet" style={{ width: size * s, height: size * s * (VIEW_H / VIEW_W) }}>
			<BuiltinPetSprite mood={svgMood} />
		</div>
	);
}
