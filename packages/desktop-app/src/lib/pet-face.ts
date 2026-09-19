/**
 * Pet face engine — the geometric heart of the builtin orb-bot mascot.
 *
 * Everything here is data + pure geometry: no React, no DOM. The face is
 * authored as a small set of control numbers and the shapes are derived from
 * them, which is what makes a two-dozen-expression mascot maintainable — you
 * tune four numbers for a mouth, not a hand-drawn path.
 *
 * ── Face space ────────────────────────────────────────────────────────────
 * The face is painted on a sphere of radius SPHERE_R centred at SPHERE_C
 * inside a FACE_BOX-unit square. Eyes are rings of points on that sphere, so
 * a gaze deflection slides them across it and compresses them at the limb —
 * the detail that separates "a face on a sticker" from "a face on a body".
 *
 * ── Why rings and not paths ───────────────────────────────────────────────
 * An expression is a pair of closed point rings. Two expressions interpolate
 * point-by-point, so the face *morphs* between moods instead of cutting — and
 * a morph is what reads as alive. Every ring therefore carries a fixed point
 * count (24) and a matching winding direction.
 *
 * ── Mouth ─────────────────────────────────────────────────────────────────
 * The mouth is never authored per expression. It hangs off the eyes: centred
 * under the pair, tilted with them, pushed clear of the taller eye. Four
 * numbers per mood (`[halfWidth, curve, gap, skew]`) cover all of them, and
 * the mouth stays coherent for free whenever the eyes move.
 *
 * Lineage: the GrokBot-style companion look is an engine, not an illustration.
 * This reproduces the engine and leaves silhouette and palette to the house
 * design system.
 */

/* ------------------------------------------------------------------ space */

/** The square every coordinate in this file is expressed in. */
export const FACE_BOX = 228.541;

/** Sphere the face is painted on. */
export const SPHERE_C = 114.2705;
export const SPHERE_R = 105;

/** Face-space centre expression rings are normalised around. */
export const FACE_CENTRE = [120, 122.5] as const;

/** How far a full-deflection gaze moves the eyes, in face units. */
export const GAZE_TRAVEL = { x: 13.2, y: 8.4 } as const;

/** Points per eye ring. Fixed so any two expressions interpolate. */
export const RING_POINTS = 24;

export type Ring = Array<[number, number]>;
export type Face = [Ring, Ring];

/** The 7-mood axis the rest of the app speaks (PetdexMood). */
export const PET_MOODS = ["rest", "hover", "dragging", "working", "waiting", "analyzing", "error"] as const;
export type PetMood = (typeof PET_MOODS)[number];

export type EyeShape =
	| "open"
	| "closed"
	| "happy"
	| "half"
	| "wide"
	| "squint"
	| "tense"
	| "sad"
	| "bored"
	| "dizzy"
	| "cross"
	| "star";

/* ------------------------------------------------------- expression data */

/**
 * One row per eye shape. Each eye is `x,y x,y …` with 24 points, authored as
 * a closed loop. Read them as: open = a tall rounded blob, closed = a soft
 * down-curve, happy = an up-curve, half/tense/bored = flattened bars, wide =
 * a taller rounder blob, squint = a pleased slit, sad = corners dropped,
 * dizzy = a coil, cross = an X, star = a four-point sparkle.
 */
const ENCODED_EYES: Record<EyeShape, [string, string]> = {
	open: [
		"88.6,99.6 93.9,100.7 98.8,103.6 102.4,108.2 104.4,113.7 104.8,119.6 104.1,125.5 103.4,131.4 102.8,137.4 102.1,143.3 101.4,149.2 100.8,155.1 100.1,161 99.5,166.9 98.8,172.8 98.1,178.7 97.5,184.6 96.8,190.6 94.9,195 91.3,197.4 87.1,197.6 83.2,195.9 80.2,192.7 78.4,188.5 77.6,184 77.4,179.4 77.2,174.8 77,170.2 76.8,165.6 76.6,161 76.4,156.4 76.2,151.8 76,147.2 75.8,142.6 76,138 76.6,133.4 77.7,128.9 79.4,124.6 81.8,120.7 84.9,117.4 88.4,114.8 92.1,112.8 95.6,111.3 95.6,111.3 95.6,111.3 95.6,111.3 95.6,111.3 95.6,111.3",
		"141.2,100.5 146.5,101.4 151.3,104.1 154.8,108.5 156.8,113.9 157.3,119.7 156.6,125.6 155.9,131.5 155.3,137.4 154.6,143.4 153.9,149.3 153.3,155.2 152.6,161.1 151.9,167 151.3,172.9 150.6,178.9 149.9,184.8 149.3,190.7 147.6,195.2 144.2,197.8 140.1,198.2 136.1,196.7 133,193.7 131,189.6 130.1,185.2 129.9,180.6 129.7,176 129.5,171.4 129.3,166.8 129.1,162.2 128.9,157.6 128.7,153 128.5,148.4 128.3,143.8 128.4,139.2 128.9,134.6 129.9,130.1 131.5,125.8 133.8,121.9 136.8,118.5 140.2,115.7 143.9,113.5 147.5,111.9 147.5,111.9 147.5,111.9 147.5,111.9 147.5,111.9 147.5,111.9",
	],
	closed: [
		"78,124 83,130 89,134.5 96,136.5 103,135.5 109,132 113,127 115,121.5 114,116 110,112.5 104,112 97,113.5 90,116 83,119 78,124 79,125.5 81.5,127 85,128 89,128.5 93,128.5 97,128 101,127 104,125.5 106,123.5 107,121.5 106.5,119.5 105,117.5 102.5,116 99,115 95,114.5 91,114.5 87,115.5 83.5,117.5 80.5,120 78,124",
		"130,125 135,131 141,135.5 148,137.5 155,136.5 161,133 165,128 167,122.5 166,117 162,113.5 156,113 149,114.5 142,117 135,120 130,125 131,126.5 133.5,128 137,129 141,129.5 145,129.5 149,129 153,128 156,126.5 158,124.5 159,122.5 158.5,120.5 157,118.5 154.5,117 151,116 147,115.5 143,115.5 139,116.5 135.5,118.5 132.5,121 130,125",
	],
	happy: [
		"76,138 80,130 86,123.5 93,119 101,117 109,118 116,122 121,128 124,135 123,141 118,144.5 111,145 103,144 95,143.5 87,143.5 80,142 76,138 77.5,138.5 81,140.5 86,142 92,142.5 98,142.5 104,142 109.5,140.5 114,138 117,134.5 118.5,130.5 117.5,126.5 115,122.5 111,119.5 106,117.5 100.5,116.5 95,116.5 89.5,117.5 84,120 79.5,123.5 76,138",
		"128,139 132,131 138,124.5 145,120 153,118 161,119 168,123 173,129 176,136 175,142 170,145.5 163,146 155,145 147,144.5 139,144.5 132,143 128,139 129.5,139.5 133,141.5 138,143 144,143.5 150,143.5 156,143 161.5,141.5 166,139 169,135.5 170.5,131.5 169.5,127.5 167,123.5 163,120.5 158,118.5 152.5,117.5 147,117.5 141.5,118.5 136,121 131.5,124.5 128,139",
	],
	half: [
		"77,128 84,124 92,122.5 100,123 108,125 114,128 116,132 113,135 105,136 96,135.5 87,134.5 80,132.5 77,128 78,128.5 82,130 88,131.5 95,132 102,132 108,131 112,129.5 114,127.5 113.5,126.5 111,125.5 106,124.5 99,124 92,124 85.5,124.5 80,125.5 77,128",
		"129,129 136,125 144,123.5 152,124 160,126 166,129 168,133 165,136 157,137 148,136.5 139,135.5 132,133.5 129,129 130,129.5 134,131 140,132.5 147,133 154,133 160,132 164,130.5 166,128.5 165.5,127.5 163,126.5 158,125.5 151,125 144,125 137.5,125.5 132,126.5 129,129",
	],
	wide: [
		"87.5,92.6 93.6,93.8 99.1,97.1 103.2,102.3 105.5,108.5 105.9,115.2 105.1,121.9 104.3,128.6 103.6,135.3 102.8,142 102,148.7 101.3,155.4 100.5,162.1 99.8,168.8 99,175.5 98.2,182.2 97.5,188.9 96.8,195.6 94.7,200.5 90.7,203.2 86,203.4 81.6,201.5 78.3,197.9 76.3,193.2 75.4,188.2 75.2,183.1 75,178 74.8,172.9 74.6,167.8 74.4,162.7 74.2,157.6 74,152.5 73.8,147.4 73.6,142.3 73.8,137.2 74.5,132.1 75.7,127.1 77.6,122.3 80.3,117.9 83.7,114.3 87.6,111.4 91.6,109.2 95.4,107.5 95.4,107.5 95.4,107.5 95.4,107.5 95.4,107.5 95.4,107.5",
		"140.3,93.5 146.4,94.6 151.9,97.9 156,103 158.4,109.2 158.8,115.9 158,122.6 157.2,129.3 156.5,136 155.7,142.7 154.9,149.4 154.2,156.1 153.4,162.8 152.7,169.5 151.9,176.2 151.1,182.9 150.4,189.6 149.7,196.3 147.8,201.3 143.9,204.1 139.3,204.4 134.8,202.6 131.5,199.1 129.4,194.4 128.5,189.4 128.3,184.3 128.1,179.2 127.9,174.1 127.7,169 127.5,163.9 127.3,158.8 127.1,153.7 126.9,148.6 126.7,143.5 126.9,138.4 127.5,133.3 128.7,128.3 130.5,123.5 133.1,119 136.4,115.3 140.1,112.3 144,110 147.8,108.2 147.8,108.2 147.8,108.2 147.8,108.2 147.8,108.2 147.8,108.2",
	],
	squint: [
		"76.5,133 82,127 89,123 97,121 105,122 112,126 116,131.5 116.5,137 112,140.5 104.5,141.5 96,141 87.5,140 80.5,137.5 76.5,133 77,134 81,136.5 87,138.5 94,139.5 101,139.5 107,138 111.5,135.5 114.5,132.5 114.5,129.5 112,127.5 107.5,125.5 101.5,124 95,123.5 88.5,124.5 82.5,126.5 78,129.5 76.5,133",
		"128.5,134 134,128 141,124 149,122 157,123 164,127 168,132.5 168.5,138 164,141.5 156.5,142.5 148,142 139.5,141 132.5,138.5 128.5,134 129,135 133,137.5 139,139.5 146,140.5 153,140.5 159,139 163.5,136.5 166.5,133.5 166.5,130.5 164,128.5 159.5,126.5 153.5,125 147,124.5 140.5,125.5 134.5,127.5 130,130.5 128.5,134",
	],
	tense: [
		"78,133 85,129.5 93,128 101,128.5 108,130.5 112.5,133 113.5,136.5 110,139 102,139.5 93,139 85,137.5 80,135.5 78,133 79,133.5 83,135 90,136 98,136.5 105,135.5 110,134 112,132 111.5,131 109,130 104,129 96,128.5 88,129.5 81.5,131 78,133",
		"131,134 138,130.5 146,129 154,129.5 161,131.5 165.5,134 166.5,137.5 163,140 155,140.5 146,140 138,138.5 133,136.5 131,134 132,134.5 136,136 143,137 151,137.5 158,136.5 163,135 165,133 164.5,132 162,131 157,130 149,129.5 141,130.5 134.5,132 131,134",
	],
	sad: [
		"78,128 83,132.5 89.5,136 97,137.5 104,136 109.5,132.5 112.5,128 112.5,122.5 109.5,118.5 103.5,117 96,117.5 88.5,119.5 82.5,123 78,128 79,126 82,121.5 87,118.5 93,117 99,117 104.5,118.5 108.5,121.5 110.5,125.5 110.5,129.5 108,133 103.5,135 98,135.5 92,135 86.5,133 82,129.5 78,128",
		"130,129 135,133.5 141.5,137 149,138.5 156,137 161.5,133.5 164.5,129 164.5,123.5 161.5,119.5 155.5,118 148,118.5 140.5,120.5 134.5,124 130,129 131,127 134,122.5 139,119.5 145,118 151,118 156.5,119.5 160.5,122.5 162.5,126.5 162.5,130.5 160,134 155.5,136 150,136.5 144,136 138.5,134 134,130.5 130,129",
	],
	bored: [
		"78,130 86,128 94,127 102,127 109,128 113,130 114,133 110,134.5 102,134 93,133.5 85,133 80,131.5 78,130 79,130.5 84,132 91,133 99,133.5 106,133 111,131.5 113,129.5 112.5,128.5 109,128 102,127.5 94,127.5 86,128.5 80,129.5 78,130",
		"131,126 139,124 147,123 155,123 162,124 166,126 167,129 163,130.5 155,130 146,129.5 138,129 133,127.5 131,126 132,126.5 137,128 144,129 152,129.5 159,129 164,127.5 166,125.5 165.5,124.5 162,124 155,123.5 147,123.5 139,124.5 133,125.5 131,126",
	],
	dizzy: [
		"86,110 92,107 99,107.5 105,111 108.5,117 108,124 104,129.5 98,132 91,131 86.5,126.5 86,120 88.5,114.5 93,111.5 98.5,111 103,114 105,119 103.5,124 99,126.5 94,125.5 91.5,121.5 92.5,117.5 95.5,116 98.5,118 98,121.5 95,122.5 93,120.5 93.5,118.5 95.5,118.5 96,120 94,116 96,113 99,113.5 101,116 100,119 97,120 94.5,118 95,115.5 97.5,115 99,117 98,119 96,118.5",
		"150,111 156,108 163,108.5 169,112 172.5,118 172,125 168,130.5 162,133 155,132 150.5,127.5 150,121 152.5,115.5 157,112.5 162.5,112 167,115 169,120 167.5,125 163,127.5 158,126.5 155.5,122.5 156.5,118.5 159.5,117 162.5,119 162,122.5 159,123.5 157,121.5 157.5,119.5 159.5,119.5 160,121 158,117 160,114 163,114.5 165,117 164,120 161,121 158.5,119 159,116.5 161.5,116 163,118 162,120 160,119.5",
	],
	cross: [
		"80,116 92,128 92,128 80,140 88,143 100,131 100,131 112,143 119,137 107,125 107,125 119,113 112,107 100,119 100,119 88,107 80,116 82,116 90,112 95,113 100,119 105,113 110,112 118,116 114,122 108,125 114,128 118,134 110,138 105,132 100,125 95,132 90,138 82,134 86,128 92,125 86,122 82,116 80,116 80,116 80,116 80,116",
		"133,117 145,129 145,129 133,141 141,144 153,132 153,132 165,144 172,138 160,126 160,126 172,114 165,108 153,120 153,120 141,108 133,117 135,117 143,113 148,114 153,120 158,114 163,113 171,117 167,123 161,126 167,129 171,135 163,139 158,133 153,126 148,133 143,139 135,135 139,129 145,126 139,123 135,117 133,117 133,117 133,117 133,117",
	],
	star: [
		"95,104 96.5,114 98,116 110,119 98,122 96.5,124 95,134 93.5,124 92,122 80,119 92,116 93.5,114 95,104 95.5,114 96.5,116 102,119 96.5,122 95.5,124 95,129 94.5,124 93.5,122 88,119 93.5,116 94.5,114 95,104 95,104 95,104 95,104 95,104 95,104 95,104 95,104 95,104 95,104 95,104 95,104 95,104 95,104 95,104 95,104",
		"149,105 150.5,115 152,117 164,120 152,123 150.5,125 149,135 147.5,125 146,123 134,120 146,117 147.5,115 149,105 149.5,115 150.5,117 156,120 150.5,123 149.5,125 149,130 148.5,125 147.5,123 142,120 147.5,117 148.5,115 149,105 149,105 149,105 149,105 149,105 149,105 149,105 149,105 149,105 149,105 149,105 149,105 149,105 149,105 149,105 149,105",
	],
};

/** Mouth per shape: `[halfWidth, curve, gap, skew]`.
 *  curve  + bows the middle down => a smile; − => a frown.
 *  gap    clearance below the lowest eye edge.
 *  skew   extra tilt in degrees on top of the eye-pair tilt (smirks). */
const MOUTH_SPEC: Record<EyeShape, number[]> = {
	open: [14, 3, 20, 0],
	closed: [13, 1, 20, 0],
	happy: [25, 14, 13, 0],
	half: [11, 4, 18, 0],
	wide: [16, -2, 22, 0],
	squint: [15, 5, 20, 0],
	tense: [12, 2, 20, 0],
	sad: [17, -7, 18, 0],
	bored: [12, 3, 20, 0],
	dizzy: [14, 1, 20, 0],
	cross: [23, 12, 13, 0],
	star: [16, -3, 22, 0],
};

/** Mouth thickness, in face-space units. */
export const MOUTH_STROKE = 7.5;

/* --------------------------------------------------------------- decoding */

function decodeEyes(pair: [string, string]): Face {
	const decode = (encoded: string): Ring => {
		const pts = encoded.split(" ").map(p => p.split(",").map(Number) as [number, number]);
		const ring: Ring = [];
		// Resample to exactly RING_POINTS so every shape interpolates with
		// every other shape regardless of how it was authored.
		for (let i = 0; i < RING_POINTS; i++) ring.push(pts[Math.round((i * (pts.length - 1)) / (RING_POINTS - 1))]);
		return ring;
	};
	return [decode(pair[0]), decode(pair[1])];
}

const ringCentre = (ring: Ring): [number, number] => {
	let x = 0;
	let y = 0;
	for (const p of ring) {
		x += p[0];
		y += p[1];
	}
	return [x / ring.length, y / ring.length];
};

/* ------------------------------------------------------------- directions */

/** How each mood plays the eye vocabulary. `drift` is a second shape the
 *  face eases into while idling — a pet that only ever holds one face reads
 *  as a texture; one that keeps finding new faces reads as a creature. */
export interface MoodDirection {
	eyes: EyeShape;
	drift?: EyeShape;
	/** Blink cadence in ms; 0 disables blinking (strained / error faces). */
	blinkMs: number;
	/** Resting look bias, -1…1 (a fraction of GAZE_TRAVEL). */
	look: number;
}

const MOOD_DIRECTION: Record<PetMood, MoodDirection> = {
	rest: { eyes: "open", drift: "happy", blinkMs: 5200, look: 0.18 },
	hover: { eyes: "squint", drift: "happy", blinkMs: 3800, look: 0 },
	dragging: { eyes: "wide", drift: "dizzy", blinkMs: 2400, look: -0.3 },
	working: { eyes: "tense", blinkMs: 0, look: 0.34 },
	waiting: { eyes: "half", drift: "bored", blinkMs: 6400, look: -0.14 },
	analyzing: { eyes: "half", drift: "dizzy", blinkMs: 0, look: 0.4 },
	error: { eyes: "cross", blinkMs: 0, look: 0 },
};

export const moodDirection = (mood: string): MoodDirection => MOOD_DIRECTION[mood as PetMood] ?? MOOD_DIRECTION.rest;

/* ---------------------------------------------------------------- geometry */

/** The face normalised to look straight ahead, plus the look-direction that
 *  was removed. Keeping gaze separate means the resting face can look at the
 *  user while expressive poses still glance where they were authored to. */
export function faceFor(shape: EyeShape): Face {
	const rings = decodeEyes(ENCODED_EYES[shape]);
	const a = ringCentre(rings[0]);
	const b = ringCentre(rings[1]);
	const gaze: [number, number] = [(a[0] + b[0]) / 2 - FACE_CENTRE[0], (a[1] + b[1]) / 2 - FACE_CENTRE[1]];
	return [shiftRing(rings[0], -gaze[0], -gaze[1]), shiftRing(rings[1], -gaze[0], -gaze[1])];
}

export const mouthSpecFor = (shape: EyeShape): number[] => MOUTH_SPEC[shape];

function shiftRing(ring: Ring, dx: number, dy: number): Ring {
	return ring.map(([x, y]) => [x + dx, y + dy] as [number, number]);
}

/** Point-by-point interpolation between two faces — the morph. */
export function lerpFace(a: Face, b: Face, t: number): Face {
	if (t <= 0) return a;
	if (t >= 1) return b;
	const mix = (p: [number, number], q: [number, number]): [number, number] => [
		p[0] + (q[0] - p[0]) * t,
		p[1] + (q[1] - p[1]) * t,
	];
	return [a[0].map((p, i) => mix(p, b[0][i] ?? p)), a[1].map((p, i) => mix(p, b[1][i] ?? p))];
}

/**
 * Spring-eased blend factor for a morph. The slight overshoot past 1 near
 * t≈0.8 is what makes an expression land with life instead of stopping dead.
 */
export function springStep(t: number, spring = 7): number {
	if (t >= 1) return 1;
	if (t <= 0) return 0;
	const k = 3 + spring * 1.6;
	return 1 - Math.exp(-k * t) * Math.cos(t * Math.PI * 1.35);
}

export function toPath(ring: Ring): string {
	return `${ring.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(2)} ${p[1].toFixed(2)}`).join("")}Z`;
}

/* ---------------------------------------------------------------- the face */

const bounds = (rings: Face): { x0: number; y0: number; x1: number; y1: number } => {
	let x0 = Number.POSITIVE_INFINITY;
	let y0 = Number.POSITIVE_INFINITY;
	let x1 = Number.NEGATIVE_INFINITY;
	let y1 = Number.NEGATIVE_INFINITY;
	for (const ring of rings) {
		for (const [x, y] of ring) {
			if (x < x0) x0 = x;
			if (y < y0) y0 = y;
			if (x > x1) x1 = x;
			if (y > y1) y1 = y;
		}
	}
	return { x0, y0, x1, y1 };
};

/**
 * The dark panel the face is painted on. It is a rounded rect around the
 * eyes' live bounding box rather than a fixed shape, so the panel grows with
 * a wide-eyed look and narrows with a squint — one less thing switching
 * states between moods, and it keeps the glowing face self-contained
 * instead of floating lights on a bare ball.
 */
export function visorPath(rings: Face, pad = 9): string {
	const b = bounds(rings);
	const x = b.x0 - pad;
	const y = b.y0 - pad;
	const w = b.x1 - b.x0 + pad * 2;
	const h = b.y1 - b.y0 + pad * 2;
	const r = Math.min(h / 2, 26);
	const k = r * 0.5523;
	const f = (n: number): string => n.toFixed(2);
	return (
		`M${f(x + r)} ${f(y)}` +
		`L${f(x + w - r)} ${f(y)}` +
		`C${f(x + w - r + k)} ${f(y)} ${f(x + w)} ${f(y + r - k)} ${f(x + w)} ${f(y + r)}` +
		`L${f(x + w)} ${f(y + h - r)}` +
		`C${f(x + w)} ${f(y + h - r + k)} ${f(x + w - r + k)} ${f(y + h)} ${f(x + w - r)} ${f(y + h)}` +
		`L${f(x + r)} ${f(y + h)}` +
		`C${f(x + r - k)} ${f(y + h)} ${f(x)} ${f(y + h - r + k)} ${f(x)} ${f(y + h - r)}` +
		`L${f(x)} ${f(y + r)}` +
		`C${f(x)} ${f(y + r - k)} ${f(x + r - k)} ${f(y)} ${f(x + r)} ${f(y)}Z`
	);
}

/* --------------------------------------------------------------- the mouth */

/**
 * Where the mouth sits. Derived from the eye pair, so the mouth tracks the
 * face for free: centred under the pair, tilted with the eye line, pushed
 * clear of whichever eye is taller.
 */
export function mouthFrame(rings: Face, spec: number[]): { x: number; y: number; angle: number } {
	const c0 = ringCentre(rings[0]);
	const c1 = ringCentre(rings[1]);
	const theta = Math.atan2(c1[1] - c0[1], c1[0] - c0[0]);
	let halfHeight = 0;
	for (const ring of rings) {
		const b = bounds([ring, ring]);
		halfHeight = Math.max(halfHeight, (b.y1 - b.y0) / 2);
	}
	const drop = halfHeight + spec[2];
	return {
		x: (c0[0] + c1[0]) / 2 - Math.sin(theta) * drop,
		y: (c0[1] + c1[1]) / 2 + Math.cos(theta) * drop,
		angle: theta + (spec[3] * Math.PI) / 180,
	};
}

/** A quadratic arc rotated into the eye line — the entire mouth vocabulary. */
export function mouthPath(frame: { x: number; y: number; angle: number }, spec: number[]): string {
	const ca = Math.cos(frame.angle);
	const sa = Math.sin(frame.angle);
	const at = (lx: number, ly: number): [number, number] => [frame.x + lx * ca - ly * sa, frame.y + lx * sa + ly * ca];
	const a = at(-spec[0], 0);
	const c = at(0, spec[1]);
	const b = at(spec[0], 0);
	return `M${a[0].toFixed(2)} ${a[1].toFixed(2)} Q${c[0].toFixed(2)} ${c[1].toFixed(2)} ${b[0].toFixed(2)} ${b[1].toFixed(2)}`;
}

/** Mouth thickness scales with how far the mouth has curved open. */
export const mouthStroke = (spec: number[]): number => MOUTH_STROKE * (1 + Math.abs(spec[1]) * 0.045);

/* ------------------------------------------------------------ sphere maths */

/** Horizontal gaze deflection → the cosine foreshortening of the sphere at
 *  that longitude. 1 head-on, shrinking toward the limb. */
export function gazeYaw(gx: number): number {
	const longitude = Math.asin(Math.max(-1, Math.min(1, gx / SPHERE_R)));
	return Math.cos(longitude);
}

/** Apply a yaw about the sphere's vertical axis: points slide horizontally
 *  and compress, which is how a face on a ball behaves at the edges. */
export function applyYaw(ring: Ring, yaw: number): Ring {
	return ring.map(([x, y]) => [SPHERE_C + (x - SPHERE_C) * yaw, y] as [number, number]);
}
