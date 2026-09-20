/**
 * Pet effects layer — a frame-exact port of blobstudio's AGENT MORPHS
 * renderers.
 *
 * Context (2026-09-20): v1 of this layer re-imagined the seven effect shapes
 * from their parameters — right numbers, invented motion — and the user
 * called it: 「特效什么的不应该是映射而是直接吸收吧？你自己做的确保视觉
 * 效果是差不多的吗？」. They were right: parameters are not the effect. This
 * revision is a line-by-line port of the bundle's own renderer source
 * (extracted from the shipped JS): hash01 particle randomness, confetti as
 * bent quadratic strokes arcing under gravity, comets sampled into filled
 * tapering outlines with sampled caps and split at the horizon on TRUE depth
 * (z = oy·sin(tilt), not screen y), the Lissajous dash flight whose tails are
 * welded to the body by sharing one clock, the dots split that dissolves the
 * BODY into the row, the easeOutBack badge, the pulsing glyph. The full
 * spec table (periods, radii, palettes) is copied verbatim.
 *
 * Deviations are integration, not translation, and they are listed here:
 *  - paint is `url(#gui-pet-grad-shell)` — our shell IS the accent (the
 *    bundle's default was a green gradient); dots/pops/glyph all wear the
 *    body's own material, exactly as the bundle does.
 *  - the bundle drives one body group (bodyContent) for the dots shrink and
 *    the glyph step-aside; ours is the `bodyRef` group in PetSprite, which
 *    additionally carries the orbit ring and the wearables, so they dissolve
 *    with the ball instead of hovering over a dot.
 *  - glyph markup is rendered as JSX with the mark from STATE_GLYPH instead
 *    of string innerHTML (same paths, same {{GRADIENT}} → paint swap).
 *  - the bundle's elapsed is per-state-entry; ours is the mascot engine's
 *    entry clock (clockRef) where a host provides one — the dash tails must
 *    read the SAME clock the body flight rides, or they detach.
 *
 * ── Why DOM writes instead of React state ────────────────────────────────
 * Same reason as the face engine: an effect is a handful of attributes that
 * change every frame, and routing that through React would re-render the
 * whole composer 60× a second. The STRUCTURE is rendered once per state
 * change; the frame clock only writes `transform` / `d` / `r` / `opacity`.
 *
 * ── Coordinates ──────────────────────────────────────────────────────────
 * Orb-local (the FACE_BOX square), matching pet-face.ts — which is also the
 * bundle's own face space (228.541, centre 114.2705). Every spec number below
 * therefore lands as-is, no rescale.
 */

import { type ReactNode, type RefObject, useEffect, useId, useMemo, useRef } from "react";
import { FACE_BOX } from "./pet-face";
import { dashPoint } from "./pet-motion";

const ORB_C = FACE_BOX / 2;
const TAU = Math.PI * 2;

/* ── bundle primitives (verbatim) ─────────────────────────────────────────── */

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

/** Deterministic per-particle randomness — same seed, same particle, every run. */
const hash01 = (n: number): number => {
	const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
	return x - Math.floor(x);
};

const easeOutBack = (t: number): number => {
	const c = 1.7;
	const u = t - 1;
	return 1 + (c + 1) * u * u * u + c * u * u;
};

const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t));

/** The seven ribbon hues. Fixed, NOT accent-derived: confetti is the one
 *  place a mascot is allowed to break its palette. (bundle CONFETTI_COLORS) */
const CONFETTI_COLORS = ["#F472B6", "#C084FC", "#818CF8", "#38BDF8", "#34D399", "#FACC15", "#FB7185"];

/** Comet palettes — one per ribbon, each running through three neighbouring
 *  hues along its own length. A single flat colour reads as wire; a hue that
 *  travels reads as something lit and moving. (bundle COMET_COLORS) */
const COMET_COLORS: [string, string, string][] = [
	["#A855F7", "#6366F1", "#38BDF8"],
	["#22D3EE", "#34D399", "#A3E635"],
	["#FB923C", "#F43F5E", "#D946EF"],
	["#818CF8", "#C084FC", "#F472B6"],
	["#FACC15", "#FB923C", "#EC4899"],
	["#34D399", "#22D3EE", "#60A5FA"],
];

/** How much a comet swells at the near point of its ring. Pure perspective cheat. */
const ORBIT_NEAR = 1.1;

/** The body's own paint — what the bundle substitutes for {{GRADIENT}} and
 *  fills its dots and pops with: the dissolved pieces ARE the mascot. */
const BODY_PAINT = "url(#gui-pet-grad-shell)";

/* ------------------------------------------------------------------ kinds */

export const PET_EFFECTS = ["trails", "dash", "dots", "confetti", "badge", "glyph", "pops"] as const;
export type PetEffect = (typeof PET_EFFECTS)[number];

/** Render-size tier. The pet appears at 20px (message avatar) through ~120px
 *  (desktop pet), and an effect that reads at one size is noise at the other
 *  — see TIER_KEEP. */
export type PetEffectTier = "full" | "compact" | "micro";

/** Which rig layer an effect mounts in. `behind` draws UNDER the shell: the
 *  shell occludes whatever passes behind it, and that occlusion IS the depth
 *  cue. `front` draws over it. `trails` is `both`: a comet is cut at the
 *  horizon and its pieces are handed to whichever side of the body they
 *  belong on, which is what turns a flat decal into something orbiting a
 *  body. `dash` stays behind and is still visible because the body itself
 *  shrinks to a flying dot (pet-motion sending/receiving `dash` + `scale`). */
export const EFFECT_LAYER: Record<PetEffect, "behind" | "front" | "both"> = {
	trails: "both",
	dash: "behind",
	dots: "front",
	confetti: "front",
	pops: "front",
	badge: "front",
	glyph: "front",
};

/** What survives at each size. The rule is "shape beats detail": dots and a
 *  badge are still legible at 20px because they are a colour and a position,
 *  while confetti ribbons, dash tails and a glyph are sub-pixel smears. */
const TIER_KEEP: Record<PetEffectTier, readonly PetEffect[]> = {
	full: PET_EFFECTS,
	compact: ["trails", "dots", "badge"],
	micro: ["badge"],
};

/** Body-motion strength per tier — the compact/micro pet must not fidget at
 *  full amplitude, or a 24px avatar visibly vibrates. Also scales every
 *  effect's travel the same way the bundle scales its own strength. */
export const TIER_STRENGTH: Record<PetEffectTier, number> = { full: 1, compact: 0.6, micro: 0.35 };

/* ---------------------------------------------------- specs (bundle table) */

export interface ConfettiSpec {
	/** How many pieces are in flight per burst. */
	count: number;
	/** Milliseconds between bursts. */
	period: number;
	/** How long one piece lives, ms. */
	life: number;
	/** Radius the pieces launch from, so a burst clears the face instead of covering it. */
	origin: number;
	/** How far pieces travel beyond that, in face units. */
	spread: number;
}

export interface TrailSpec {
	/** How many comets orbit the body. */
	count: number;
	/** Milliseconds for one full orbit. */
	period: number;
	/** Orbit radius, in face units. */
	radius: number;
	/** Half-width at the head, in face units. The tail tapers from this to nothing. */
	width?: number;
	/** How much of the orbit one comet covers, in radians. Kept under π so a comet
	 *  crosses the horizon at most once and never splits into three pieces. */
	span?: number;
}

/** A body shrunk to a dot and thrown across the frame, with tails streaming behind it. */
export interface DashSpec {
	/** How many tails stream off the dot. */
	count: number;
	/** Milliseconds for one full flight. Sign carries the direction: negative
	 *  flies the route in reverse (receiving pulls the packet home). */
	period: number;
	/** How far the dot travels from centre, in face units. */
	radius: number;
	/** How far back in the flight the longest tail reaches, ms. */
	length: number;
	/** Half-width where a tail meets the dot. */
	width?: number;
}

/** The body dissolved into a row of dots — the loading indicator every chat app has. */
export interface DotsSpec {
	/** How many dots stand in for the body. */
	count: number;
	/** Milliseconds for one pass of the highlight along the row. */
	period: number;
	/** Dot radius, in face units. */
	radius: number;
	/** Distance between dot centres. */
	gap: number;
	/** How long the body takes to come apart into the row, ms. */
	split: number;
}

/** Small body-coloured dots flung off as the mascot collapses or springs into being. */
export interface PopSpec {
	count: number;
	/** Milliseconds between rounds. */
	period: number;
	/** How long one dot lives, ms. */
	life: number;
	/** How far a dot travels from centre. */
	spread: number;
	/** Largest dot radius; the rest are scaled down from it. */
	radius: number;
}

/** The unread dot that lands on the mascot's shoulder. */
export interface BadgeSpec {
	color: string;
	radius: number;
	/** Badge centre, in face units. */
	x: number;
	y: number;
	/** Milliseconds between appearances. */
	period: number;
	/** How long it is held, ms. */
	hold: number;
}

export interface GlyphSpec {
	/** The mark the mascot becomes. The paths are JSX (EffectNode); only the
	 *  envelope timing lives here. */
	markup: "!" | "?";
	/** Milliseconds between appearances. */
	period: number;
	/** How long the glyph is held, ms. */
	hold: number;
}

export interface StateEffects {
	confetti?: ConfettiSpec;
	trails?: TrailSpec;
	dash?: DashSpec;
	dots?: DotsSpec;
	pops?: PopSpec;
	badge?: BadgeSpec;
	glyph?: GlyphSpec;
}

const DOTS_SPEC: DotsSpec = { count: 3, period: 1150, radius: 17, gap: 50, split: 460 };

/**
 * Per-state effect specs. Numbers are the bundle's, copied verbatim; where a
 * state has no bundle counterpart of its own the nearest family member's
 * spec is reused and marked. States absent here play nothing.
 *
 * `STATE_EFFECTS` is DERIVED from this table, so the kind list and the
 * params cannot drift apart.
 */
const STATE_FX: Record<string, StateEffects> = {
	// The body dissolved into the three dots every chat app shows while it
	// thinks (bundle 'thinking-dots' — the bundle's own thinking indicator).
	thinking: { dots: DOTS_SPEC },
	working: { dots: DOTS_SPEC },
	writing: { dots: DOTS_SPEC },
	dictating: { dots: DOTS_SPEC },
	"thinking-dots": { dots: DOTS_SPEC },
	// Work in flight — comets orbiting the body on tilted rings. `searching`
	// rides the bundle's progress ring.
	searching: { trails: { count: 5, period: 2000, radius: 104, width: 4.8, span: 2.3 } },
	progress: { trails: { count: 5, period: 2000, radius: 104, width: 4.8, span: 2.3 } },
	loading: { trails: { count: 5, period: 2400, radius: 105, width: 5, span: 2.6 } },
	uploading: { trails: { count: 4, period: 1800, radius: 104, width: 4.8, span: 2.2 } },
	orbit: { trails: { count: 6, period: 3000, radius: 105, width: 5, span: 2.5 } },
	radar: { trails: { count: 4, period: 2400, radius: 106, width: 4.5, span: 2.1 } },
	// A packet in flight: the body balled up to a dot with its tails strung
	// out behind. The period must match pet-motion's `dash` exactly, sign
	// included — the tails are drawn from the same flight path the body rides.
	sending: { dash: { count: 3, period: 1500, radius: 66, length: 520, width: 9 } },
	receiving: { dash: { count: 3, period: -1500, radius: 66, length: 520, width: 9 } },
	// Result emotions (bundle celebrate / excited; happy reuses 'laughing').
	celebrate: { confetti: { count: 16, period: 1500, life: 1300, origin: 74, spread: 54 } },
	excited: { confetti: { count: 9, period: 2000, life: 1100, origin: 72, spread: 44 } },
	happy: { confetti: { count: 7, period: 2400, life: 1000, origin: 70, spread: 38 } },
	// Coming into being and winding down — the body collapses to a point
	// either way, and sheds a few of itself on the way.
	spawning: { pops: { count: 5, period: 3200, life: 900, spread: 62, radius: 9 } },
	"powering-down": { pops: { count: 4, period: 2600, life: 1100, spread: 54, radius: 8 } },
	// The mascot standing aside to show a symbol.
	alerting: { glyph: { markup: "!", period: 2600, hold: 1100 } },
	confused: { glyph: { markup: "?", period: 5200, hold: 1200 } },
	// Notification keeps its face and takes the badge on the shoulder instead
	// — the mascot is telling you about something, not becoming it.
	notifying: { badge: { color: "#2E9BF0", radius: 17, x: 186, y: 46, period: 3400, hold: 2000 } },
};

/**
 * Which effects a session state plays — derived from STATE_FX so the kind
 * list and its params are one table. Each state plays exactly one effect
 * (the bundle's own shape): it is the only signal that distinguishes its
 * state from its neighbours at a glance — `sending` and `receiving` are the
 * same dash at two directions, and `alerting` vs `confused` are the same
 * glyph slot with two marks, because those two states demand OPPOSITE things
 * from the user.
 */
export const STATE_EFFECTS: Record<string, readonly PetEffect[]> = Object.fromEntries(
	Object.entries(STATE_FX).map(([s, fx]) => [s, Object.keys(fx) as PetEffect[]]),
);

/** The mark a glyph state wears. */
export const STATE_GLYPH: Record<string, "!" | "?"> = { alerting: "!", confused: "?" };

/** Resolve the effects a state actually plays at a given tier. */
export function effectsForState(state: string | null | undefined, tier: PetEffectTier): readonly PetEffect[] {
	const all = (state && STATE_EFFECTS[state]) || [];
	if (tier === "full") return all;
	return all.filter(e => TIER_KEEP[tier].includes(e));
}

/* ---------------------------------------------------------------- comets */

/** One sampled outline point: position plus half-width here. */
interface Sample {
	x: number;
	y: number;
	h: number;
}

/**
 * Head→tail samples to one filled outline. (bundle cometPath, verbatim)
 *
 * `capHead` / `capTail` are false for the cut ends of a comet that has been
 * split at the horizon: a cap there would bulge in the middle of the comet
 * and read as a bead.
 */
function cometPath(s: Sample[], capHead: boolean, capTail: boolean): string {
	const n = s.length;
	if (n < 2) return "";

	// Screen-space normal at each sample, from the tangent through its neighbours.
	const nx: number[] = [];
	const ny: number[] = [];
	for (let i = 0; i < n; i++) {
		const a = s[Math.max(i - 1, 0)];
		const b = s[Math.min(i + 1, n - 1)];
		const tx = b.x - a.x;
		const ty = b.y - a.y;
		const len = Math.hypot(tx, ty) || 1;
		nx.push(-ty / len);
		ny.push(tx / len);
	}

	const point = (x: number, y: number): string => `${x.toFixed(1)} ${y.toFixed(1)}`;
	const left: string[] = [];
	const right: string[] = [];
	for (let i = 0; i < n; i++) {
		left.push(point(s[i].x + nx[i] * s[i].h, s[i].y + ny[i] * s[i].h));
		right.push(point(s[i].x - nx[i] * s[i].h, s[i].y - ny[i] * s[i].h));
	}

	// Caps are sampled rather than drawn with `A`, because the sweep flag an
	// arc needs depends on which way the comet happens to be pointing.
	// Sampling a semicircle around the end point is always the right one.
	const cap = (i: number, out: 1 | -1): string[] => {
		const STEPS = 6;
		const { x, y, h } = s[i];
		const tx = ny[i];
		const ty = -nx[i];
		const parts: string[] = [];
		for (let k = 1; k < STEPS; k++) {
			const a = (k / STEPS) * Math.PI;
			const dn = out * Math.cos(a);
			const dt = out * Math.sin(a);
			parts.push(point(x + (nx[i] * dn + tx * dt) * h, y + (ny[i] * dn + ty * dt) * h));
		}
		return parts;
	};

	// Start at the head's right shoulder, over the nose, down the left flank
	// to the tail, round the tail, then back up the right flank.
	const outline = [right[0]];
	if (capHead) outline.push(...cap(0, -1));
	outline.push(...left);
	if (capTail) outline.push(...cap(n - 1, 1));
	for (let i = n - 1; i > 0; i--) outline.push(right[i]);
	return `M${outline.join("L")}Z`;
}

/* ---------------------------------------------------------------- trails */

/**
 * One side's half of the comet field. The bundle draws back+front in ONE
 * pass; ours are two mount points with two clocks, so each side runs the
 * same deterministic geometry and keeps only its own pieces — identical
 * seeds and (near-identical) elapsed make the two halves one object.
 * (bundle drawTrails, split per side)
 */
function drawTrailsSide(
	g: SVGGElement,
	side: "back" | "front",
	spec: TrailSpec,
	elapsed: number,
	strength: number,
	cx: number,
	cy: number,
	uid: string,
): void {
	const count = spec.count;
	const width = spec.width ?? 7;
	const span = Math.min(spec.span ?? 2.4, Math.PI - 0.05);
	const SAMPLES = 22;

	const paths = Array.from(g.querySelectorAll(":scope > path")) as SVGPathElement[];
	const grads = Array.from(g.querySelectorAll(":scope > defs > linearGradient")) as SVGLinearGradientElement[];
	let used = 0;

	for (let i = 0; i < count; i++) {
		const seedA = hash01(i + 3);
		const seedB = hash01(i + 29);
		const seedC = hash01(i + 71);

		// Every ring gets its own tip, roll and speed. Shared values would
		// stack the comets into what looks like one thick ring seen edge-on.
		const tilt = 0.3 + seedA * 0.66;
		const roll = seedB * TAU;
		const period = spec.period * (0.78 + seedC * 0.55);
		const direction = i % 2 === 0 ? 1 : -1;
		const radius = spec.radius * strength * (0.94 + seedB * 0.12);
		const head = direction * (elapsed / period) * TAU + seedA * TAU;

		const cosT = Math.cos(tilt);
		const sinT = Math.sin(tilt);
		const cosR = Math.cos(roll);
		const sinR = Math.sin(roll);

		// Split into runs of constant depth sign; each run becomes one path.
		const runs: { samples: Sample[]; front: boolean }[] = [];
		let run: Sample[] = [];
		let runSide = 0;

		// A comet that clips the horizon leaves a stub on the far side — a few
		// samples' worth, shorter than the comet is wide. Capped like a real
		// end it reads as a bead floating off the comet, so anything under a
		// few widths long is dropped and the surviving piece takes the cap.
		const keep = (samples: Sample[]): boolean => {
			if (samples.length < 3) return false;
			let length = 0;
			for (let s = 1; s < samples.length; s++) {
				length += Math.hypot(samples[s].x - samples[s - 1].x, samples[s].y - samples[s - 1].y);
			}
			return length > width * 3.5;
		};

		for (let s = 0; s < SAMPLES; s++) {
			const k = s / (SAMPLES - 1);
			const angle = head - direction * span * k;
			const ox = Math.cos(angle) * radius;
			const oy = Math.sin(angle) * radius;
			// Tip the ring away from the viewer, then roll it in the screen plane.
			const ty = oy * cosT;
			const z = oy * sinT;
			const near = 1 + (z / radius) * (ORBIT_NEAR - 1);
			const x = cx + (ox * cosR - ty * sinR) * near;
			const y = cy + (ox * sinR + ty * cosR) * near;
			// Mostly full width, thinning to a third by the tail.
			const h = width * near * (1 - 0.68 * k ** 1.5) * strength;

			// The split sign is TRUE depth, not screen y.
			const nowSide = z >= 0 ? 1 : -1;
			if (nowSide !== runSide) {
				if (keep(run)) runs.push({ samples: run, front: runSide > 0 });
				// Repeat the crossing sample so the two pieces meet rather
				// than leaving a gap.
				run = run.length ? [run[run.length - 1]] : [];
				runSide = nowSide;
			}
			run.push({ x, y, h });
		}
		if (keep(run)) runs.push({ samples: run, front: runSide > 0 });
		if (!runs.length) continue;

		// The gradient spans the whole comet, not each piece, so a hue still
		// runs head to tail across a horizon cut.
		const first = runs[0].samples;
		const lastRun = runs[runs.length - 1].samples;
		const grad = grads[i];
		if (grad) {
			grad.setAttribute("x1", first[0].x.toFixed(1));
			grad.setAttribute("y1", first[0].y.toFixed(1));
			grad.setAttribute("x2", lastRun[lastRun.length - 1].x.toFixed(1));
			grad.setAttribute("y2", lastRun[lastRun.length - 1].y.toFixed(1));
		}

		for (let r = 0; r < runs.length; r++) {
			if ((side === "front") !== runs[r].front) continue;
			const path = paths[used++];
			if (!path) continue;
			// Only the true ends get capped; the cut where the comet crosses
			// the horizon is a seam between two pieces of one object.
			path.setAttribute("d", cometPath(runs[r].samples, r === 0, r === runs.length - 1));
			path.setAttribute("fill", `url(#${uid}-comet-${i})`);
			path.setAttribute("opacity", "1");
		}
	}

	for (let i = used; i < paths.length; i++) paths[i].setAttribute("opacity", "0");
}

/* ------------------------------------------------------------------ dash */

/** The tails streaming off a dashing dot — the flight path it has just come
 *  through. The flight itself rides the body (pet-motion `dash`); this draws
 *  the same path stretched back in time. (bundle drawDash, verbatim) */
function drawDash(
	g: SVGGElement,
	spec: DashSpec,
	elapsed: number,
	strength: number,
	cx: number,
	cy: number,
	uid: string,
): void {
	const count = spec.count;
	const width = spec.width ?? 8;
	const SAMPLES = 18;
	const paths = Array.from(g.querySelectorAll(":scope > path")) as SVGPathElement[];
	const grads = Array.from(g.querySelectorAll(":scope > defs > linearGradient")) as SVGLinearGradientElement[];

	for (let i = 0; i < count; i++) {
		const seed = hash01(i + 13);
		// Staggered lengths and a small lateral offset fan the tails instead
		// of stacking them.
		const length = spec.length * (0.66 + seed * 0.5);
		const offset = (i - (count - 1) / 2) * width * 0.85;
		const samples: Sample[] = [];

		for (let s = 0; s < SAMPLES; s++) {
			const k = s / (SAMPLES - 1);
			const at = elapsed - length * k;
			const p = dashPoint(spec.radius * strength, spec.period, at);
			// Push each tail off the flight line so they read as separate ribbons.
			const q = dashPoint(spec.radius * strength, spec.period, at + 1);
			const tx = q.x - p.x;
			const ty = q.y - p.y;
			const len = Math.hypot(tx, ty) || 1;
			samples.push({
				x: cx + p.x - (ty / len) * offset,
				y: cy + p.y + (tx / len) * offset,
				h: width * (1 - k ** 1.7) * strength,
			});
		}

		const grad = grads[i];
		if (grad) {
			grad.setAttribute("x1", samples[0].x.toFixed(1));
			grad.setAttribute("y1", samples[0].y.toFixed(1));
			grad.setAttribute("x2", samples[SAMPLES - 1].x.toFixed(1));
			grad.setAttribute("y2", samples[SAMPLES - 1].y.toFixed(1));
		}

		const path = paths[i];
		if (!path) continue;
		path.setAttribute("d", cometPath(samples, true, true));
		path.setAttribute("fill", `url(#${uid}-comet-${i})`);
		path.setAttribute("opacity", "1");
	}
}

/* ------------------------------------------------------------------ dots */

/** How far the body has come apart into the row, 0..1. `share` shortens the
 *  window: the body finishes its part of the split before the dots finish
 *  theirs. (bundle splitAmount) */
function splitAmount(spec: DotsSpec, elapsed: number, share = 1): number {
	if (spec.split <= 0) return 1;
	return easeInOut(clamp(elapsed / (spec.split * share), 0, 1));
}

/** The body is done breaking up this far into the dots' own window. */
const BODY_SPLIT_SHARE = 0.62;

/** The body dissolved into a row of dots, with a brightness that walks along
 *  the row. The walk is what makes three dots read as thinking rather than as
 *  an ellipsis. (bundle drawDots, verbatim) */
function drawDots(
	g: SVGGElement,
	spec: DotsSpec,
	elapsed: number,
	strength: number,
	cx: number,
	cy: number,
	paint: string,
	split: number,
): void {
	const circles = Array.from(g.querySelectorAll(":scope > circle")) as SVGCircleElement[];
	for (let i = 0; i < spec.count; i++) {
		const circle = circles[i];
		if (!circle) continue;
		const phase = elapsed / spec.period - i * 0.16;
		// Squared cosine peaks sharply, so one dot leads and the others trail
		// it. Scaled by the split so the row is still while it is forming.
		const lift = (0.5 + 0.5 * Math.cos(TAU * phase)) ** 3 * split;
		// Every dot starts stacked at the centre, under the body, and travels
		// out to its place.
		const x = cx + (i - (spec.count - 1) / 2) * spec.gap * split;
		const y = cy - lift * 9 * strength;
		circle.setAttribute("cx", x.toFixed(1));
		circle.setAttribute("cy", y.toFixed(1));
		circle.setAttribute("r", (spec.radius * (0.82 + lift * 0.3) * split).toFixed(1));
		circle.setAttribute("fill", paint);
		circle.setAttribute("opacity", (0.34 + lift * 0.66).toFixed(3));
	}
}

/** One frame of the dots state, including the body it dissolves: the body
 *  shrinks into the middle dot rather than cutting to it, on its own shorter
 *  clock (BODY_SPLIT_SHARE) so it has finished before the row has. */
function updateDots(
	g: SVGGElement,
	spec: DotsSpec,
	elapsed: number,
	strength: number,
	body: SVGGElement | null,
	htmlBody: HTMLElement | null,
): void {
	const split = splitAmount(spec, elapsed);
	drawDots(g, spec, elapsed, strength, ORB_C, ORB_C, BODY_PAINT, split);
	// The HTML-channel body (imported sprites) dissolves the same way, as CSS.
	if (htmlBody) {
		const shed = splitAmount(spec, elapsed, BODY_SPLIT_SHARE);
		const target = spec.radius / (FACE_BOX / 2);
		const scale = 1 - (1 - target) * shed;
		htmlBody.style.transformOrigin = "50% 50%";
		htmlBody.style.transform = `scale(${scale.toFixed(4)})`;
		htmlBody.style.opacity = (1 - clamp((shed - 0.62) / 0.3, 0, 1)).toFixed(3);
	}
	if (!body) return;
	const shed = splitAmount(spec, elapsed, BODY_SPLIT_SHARE);
	const target = spec.radius / (FACE_BOX / 2);
	const scale = 1 - (1 - target) * shed;
	body.setAttribute(
		"transform",
		`translate(${ORB_C.toFixed(1)} ${ORB_C.toFixed(1)}) scale(${scale.toFixed(4)}) translate(${(-ORB_C).toFixed(1)} ${(-ORB_C).toFixed(1)})`,
	);
	// Held solid while it is still big enough to recognise, then dissolved
	// quickly once it is down near dot size.
	body.style.opacity = (1 - clamp((shed - 0.62) / 0.3, 0, 1)).toFixed(3);
}

/* -------------------------------------------------------------- confetti */

/** Confetti: short curved strokes thrown outward, arcing down as they fade.
 *  (bundle drawConfetti, verbatim) */
function drawConfetti(
	g: SVGGElement,
	spec: ConfettiSpec,
	elapsed: number,
	strength: number,
	cx: number,
	cy: number,
): void {
	const paths = Array.from(g.querySelectorAll(":scope > path")) as SVGPathElement[];
	for (let i = 0; i < spec.count; i++) {
		const path = paths[i];
		if (!path) continue;
		const seedA = hash01(i + 1);
		const seedB = hash01(i + 41);
		const seedC = hash01(i + 91);

		// Stagger the pieces across the burst window so they don't leave as
		// one wall.
		const t = (((elapsed + seedC * spec.period) % spec.period) / spec.life) * 1;
		if (t > 1) {
			path.setAttribute("opacity", "0");
			continue;
		}

		const angle = seedA * TAU;
		const travel = spec.spread * (0.45 + seedB * 0.55) * (1 - (1 - t) * (1 - t));
		const distance = (spec.origin + travel) * strength;
		const gravity = 34 * strength * t * t;
		const x = cx + Math.cos(angle) * distance;
		const y = cy + Math.sin(angle) * distance + gravity;
		const length = 11 + seedB * 12;
		const spin = angle + (seedC - 0.5) * 5 * t;
		const ex = x + Math.cos(spin) * length;
		const ey = y + Math.sin(spin) * length;
		// A slight bend reads as paper rather than a matchstick.
		const bend = (seedA - 0.5) * length * 0.7;
		const mx = (x + ex) / 2 - Math.sin(spin) * bend;
		const my = (y + ey) / 2 + Math.cos(spin) * bend;

		path.setAttribute(
			"d",
			`M${x.toFixed(1)} ${y.toFixed(1)} Q${mx.toFixed(1)} ${my.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`,
		);
		path.setAttribute("stroke", CONFETTI_COLORS[i % CONFETTI_COLORS.length]);
		path.setAttribute("stroke-width", (4 + seedB * 2.4).toFixed(1));
		path.setAttribute("opacity", (t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 0.88).toFixed(3));
	}
}

/* ------------------------------------------------------------------ pops */

/** Small body-coloured dots shed as the mascot arrives or winds down.
 *  (bundle drawPops, verbatim) */
function drawPops(g: SVGGElement, spec: PopSpec, elapsed: number, strength: number, cx: number, cy: number): void {
	const circles = Array.from(g.querySelectorAll(":scope > circle")) as SVGCircleElement[];
	for (let i = 0; i < spec.count; i++) {
		const circle = circles[i];
		if (!circle) continue;
		const seedA = hash01(i + 7);
		const seedB = hash01(i + 53);
		const t = ((elapsed + seedB * spec.period) % spec.period) / spec.life;
		if (t > 1) {
			circle.setAttribute("opacity", "0");
			continue;
		}
		const angle = seedA * TAU;
		// Decelerating travel: they are thrown, not driven.
		const distance = spec.spread * (0.4 + seedB * 0.6) * (1 - (1 - t) * (1 - t)) * strength;
		circle.setAttribute("cx", (cx + Math.cos(angle) * distance).toFixed(1));
		circle.setAttribute("cy", (cy + Math.sin(angle) * distance).toFixed(1));
		circle.setAttribute("r", (spec.radius * (0.45 + seedA * 0.55) * (1 - t * 0.55)).toFixed(1));
		circle.setAttribute("fill", BODY_PAINT);
		circle.setAttribute("opacity", (t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85).toFixed(3));
	}
}

/* ----------------------------------------------------------------- badge */

/** The unread dot, springing onto the mascot's shoulder and holding there.
 *  (bundle drawBadge, verbatim) */
function drawBadge(g: SVGGElement, spec: BadgeSpec, elapsed: number, strength: number): void {
	const circles = Array.from(g.querySelectorAll(":scope > circle")) as SVGCircleElement[];
	const circle = circles[0];
	if (!circle) return;
	const position = elapsed % spec.period;
	const start = spec.period - spec.hold;
	if (position < start) {
		circle.setAttribute("opacity", "0");
		return;
	}
	const into = position - start;
	const ARRIVE = 340;
	const t = Math.min(into / ARRIVE, 1);
	const leaving = Math.max(0, Math.min(1, (spec.hold - into) / 180));
	circle.setAttribute("cx", spec.x.toFixed(1));
	circle.setAttribute("cy", spec.y.toFixed(1));
	circle.setAttribute("r", (spec.radius * easeOutBack(t) * strength).toFixed(2));
	circle.setAttribute("fill", spec.color);
	circle.setAttribute("opacity", leaving.toFixed(3));
}

/* ----------------------------------------------------------------- glyph */

/** How present the glyph is right now, 0..1, with eased edges.
 *  (bundle glyphAmount, verbatim) */
function glyphAmount(spec: GlyphSpec, elapsed: number): number {
	const position = elapsed % spec.period;
	const start = spec.period - spec.hold;
	if (position < start) return 0;
	const into = position - start;
	const remaining = spec.hold - into;
	const EASE = 200;
	return Math.max(0, Math.min(1, Math.min(into, remaining) / EASE));
}

/** One frame of the glyph state: the mark scales in as it arrives and the
 *  body steps aside rather than sitting behind it. */
function updateGlyph(
	g: SVGGElement,
	spec: GlyphSpec,
	elapsed: number,
	body: SVGGElement | null,
	htmlBody: HTMLElement | null,
): void {
	const amount = glyphAmount(spec, elapsed);
	g.style.opacity = String(amount);
	const scale = 0.72 + 0.28 * amount;
	g.setAttribute(
		"transform",
		`translate(${ORB_C.toFixed(1)} ${ORB_C.toFixed(1)}) scale(${scale.toFixed(3)}) translate(${(-ORB_C).toFixed(1)} ${(-ORB_C).toFixed(1)})`,
	);
	if (body) body.style.opacity = String(1 - amount);
	if (htmlBody) htmlBody.style.opacity = String(1 - amount);
}

/* -------------------------------------------------------------- dispatch */

interface FrameCtx {
	elapsed: number;
	strength: number;
	spec: StateEffects | undefined;
	uid: string;
	side: "back" | "front";
	body: SVGGElement | null;
	htmlBody: HTMLElement | null;
}

function updateEffect(kind: PetEffect, g: SVGGElement, fx: FrameCtx): void {
	switch (kind) {
		case "trails":
			if (fx.spec?.trails) drawTrailsSide(g, fx.side, fx.spec.trails, fx.elapsed, fx.strength, ORB_C, ORB_C, fx.uid);
			break;
		case "dash":
			if (fx.spec?.dash) drawDash(g, fx.spec.dash, fx.elapsed, fx.strength, ORB_C, ORB_C, fx.uid);
			break;
		case "dots":
			if (fx.spec?.dots) updateDots(g, fx.spec.dots, fx.elapsed, fx.strength, fx.body, fx.htmlBody);
			break;
		case "confetti":
			if (fx.spec?.confetti) drawConfetti(g, fx.spec.confetti, fx.elapsed, fx.strength, ORB_C, ORB_C);
			break;
		case "badge":
			if (fx.spec?.badge) drawBadge(g, fx.spec.badge, fx.elapsed, fx.strength);
			break;
		case "pops":
			if (fx.spec?.pops) drawPops(g, fx.spec.pops, fx.elapsed, fx.strength, ORB_C, ORB_C);
			break;
		case "glyph":
			if (fx.spec?.glyph) updateGlyph(g, fx.spec.glyph, fx.elapsed, fx.body, fx.htmlBody);
			break;
	}
}

/** How many elements one kind's structure needs — the state-change key, so a
 *  count change rebuilds the pool. */
function fxCount(kind: PetEffect, spec: StateEffects | undefined): number {
	switch (kind) {
		case "trails":
			return (spec?.trails?.count ?? 0) * 2;
		case "dash":
			return spec?.dash?.count ?? 0;
		case "dots":
			return spec?.dots?.count ?? 0;
		case "confetti":
			return spec?.confetti?.count ?? 0;
		case "pops":
			return spec?.pops?.count ?? 0;
		default:
			return 0;
	}
}

/* ------------------------------------------------------------- structure */

/** One <linearGradient> per comet: stops set once, endpoints written every
 *  frame, so a hue runs head-to-tail no matter how the ring is turned. */
function CometDefs({ uid, count }: { uid: string; count: number }): ReactNode {
	return (
		<defs>
			{Array.from({ length: count }, (_, i) => {
				const colors = COMET_COLORS[i % COMET_COLORS.length];
				return (
					<linearGradient key={i} id={`${uid}-comet-${i}`} gradientUnits="userSpaceOnUse">
						{/* The last stop fades: taper alone ends the comet's shape,
						 * this ends its presence. */}
						<stop offset="0%" stopColor={colors[0]} stopOpacity={1} />
						<stop offset="52%" stopColor={colors[1]} stopOpacity={1} />
						<stop offset="100%" stopColor={colors[2]} stopOpacity={0.35} />
					</linearGradient>
				);
			})}
		</defs>
	);
}

function EffectNode({
	kind,
	spec,
	glyph,
	uid,
}: {
	kind: PetEffect;
	spec: StateEffects | undefined;
	glyph: "!" | "?";
	uid: string;
}): ReactNode {
	switch (kind) {
		case "trails": {
			const count = spec?.trails?.count ?? 0;
			return (
				<g data-effect="trails">
					<CometDefs uid={uid} count={count} />
					{/* A comet crosses the horizon at most once, so it is at
					 * most two pieces — but both can land on the same side, so
					 * each layer holds two per comet. */}
					{Array.from({ length: count * 2 }, (_, i) => (
						<path key={i} opacity={0} />
					))}
				</g>
			);
		}
		case "dash": {
			const count = spec?.dash?.count ?? 0;
			return (
				<g data-effect="dash">
					<CometDefs uid={uid} count={count} />
					{Array.from({ length: count }, (_, i) => (
						<path key={i} opacity={0} />
					))}
				</g>
			);
		}
		case "dots":
			return (
				<g data-effect="dots">
					{Array.from({ length: spec?.dots?.count ?? 0 }, (_, i) => (
						<circle key={i} opacity={0} />
					))}
				</g>
			);
		case "confetti":
			return (
				<g data-effect="confetti">
					{Array.from({ length: spec?.confetti?.count ?? 0 }, (_, i) => (
						<path key={i} fill="none" strokeLinecap="round" opacity={0} />
					))}
				</g>
			);
		case "badge":
			return (
				<g data-effect="badge">
					<circle opacity={0} />
				</g>
			);
		case "glyph":
			return (
				<g data-effect="glyph" opacity={0}>
					{glyph === "!" ? (
						<>
							{/* The exclamation: a tapered bar and a dot, so it
							 * reads as a character rather than a rectangle. */}
							<path
								fill={BODY_PAINT}
								d="M99 58 Q99 43 114.3 43 Q129.6 43 129.6 58 L123 150 Q122 161 114.3 161 Q106.6 161 105.6 150 Z"
							/>
							<circle fill={BODY_PAINT} cx="114.3" cy="188" r="15" />
						</>
					) : (
						<>
							{/* The question mark: stroked, so it stays light. */}
							<path
								fill="none"
								stroke={BODY_PAINT}
								strokeWidth="19"
								strokeLinecap="round"
								d="M88 76 A27 27 0 1 1 114.3 112 L114.3 132"
							/>
							<circle fill={BODY_PAINT} cx="114.3" cy="170" r="13" />
						</>
					)}
				</g>
			);
		case "pops":
			return (
				<g data-effect="pops">
					{Array.from({ length: spec?.pops?.count ?? 0 }, (_, i) => (
						<circle key={i} opacity={0} />
					))}
				</g>
			);
	}
}

/* ------------------------------------------------------------ the layer */

/**
 * Mount the effects one state plays, in one rig layer.
 *
 * The structure is re-rendered only when the resolved effect SET changes; the
 * clock then writes attributes directly, so a state that runs for ten minutes
 * costs zero React renders. When the set resolves empty the component renders
 * nothing at all — no idle rAF for the states that carry no effect.
 *
 * `clockRef` is the mascot engine's per-entry clock; the dash tails must read
 * the same clock the body flight rides (pet-motion `dash`), or they detach
 * from the dot. `bodyRef` is the shared body unit (PetSprite): the dots
 * dissolve it and the glyph steps it aside. `htmlBodyRef` is the same body
 * contract for pets whose body is an HTML element (imported petdex sprites):
 * same dissolve/step-aside, written as CSS transform/opacity.
 */
export function PetEffects({
	state,
	layer,
	tier = "full",
	clockRef,
	bodyRef,
	htmlBodyRef,
}: {
	/** Session state (pet.ts PetState). Null/absent → no effects. */
	state?: string | null;
	/** Which rig layer this mount point is. */
	layer: "behind" | "front";
	tier?: PetEffectTier;
	/** Shared per-entry clock (ms since the state was entered). */
	clockRef?: RefObject<number>;
	/** The body unit the dots dissolve and the glyph steps aside. */
	bodyRef?: RefObject<SVGGElement | null>;
	/** HTML-channel body unit (imported sprites) — same contract as bodyRef. */
	htmlBodyRef?: RefObject<HTMLElement | null>;
}): ReactNode {
	const host = useRef<SVGGElement | null>(null);
	const uid = `gui-pet-fx-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
	const kinds = useMemo(
		() =>
			effectsForState(state, tier).filter(e => {
				const l = EFFECT_LAYER[e];
				return l === layer || l === "both";
			}),
		[state, tier, layer],
	);
	const spec = state ? STATE_FX[state] : undefined;
	const glyph = (state && STATE_GLYPH[state]) || "!";
	const strength = TIER_STRENGTH[tier];
	const side = layer === "front" ? "front" : "back";

	useEffect(() => {
		const root = host.current;
		if (!root) return;
		let raf = 0;
		let last = performance.now();
		let own = 0;
		const tick = (now: number): void => {
			const dt = Math.min(now - last, 64);
			last = now;
			own += dt;
			const elapsed = clockRef ? clockRef.current : own;
			const ctx: FrameCtx = {
				elapsed,
				strength,
				spec,
				uid,
				side,
				body: bodyRef?.current ?? null,
				htmlBody: htmlBodyRef?.current ?? null,
			};
			for (let i = 0; i < root.children.length; i++) {
				const child = root.children[i] as SVGGElement;
				const kind = child.dataset.effect as PetEffect | undefined;
				if (kind) updateEffect(kind, child, ctx);
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => {
			cancelAnimationFrame(raf);
			// The body hooks are shared and persistent — an effect that owned
			// the body (dots shrink / glyph step-aside) must hand it back whole
			// before the next state's effects take over.
			const body = bodyRef?.current;
			if (body) {
				if (kinds.includes("dots")) {
					body.removeAttribute("transform");
					body.style.opacity = "1";
				} else if (kinds.includes("glyph")) {
					body.style.opacity = "1";
				}
			}
			const htmlBody = htmlBodyRef?.current;
			if (htmlBody) {
				if (kinds.includes("dots")) {
					htmlBody.style.transform = "";
					htmlBody.style.opacity = "1";
				} else if (kinds.includes("glyph")) {
					htmlBody.style.opacity = "1";
				}
			}
		};
	}, [kinds, clockRef, bodyRef, htmlBodyRef, spec, uid, side, strength]);

	if (kinds.length === 0) return null;
	return (
		<g ref={host} className="gui-pet-svg__fx" aria-hidden>
			{kinds.map(k => (
				<EffectNode key={`${k}:${fxCount(k, spec)}`} kind={k} spec={spec} glyph={glyph} uid={uid} />
			))}
		</g>
	);
}
