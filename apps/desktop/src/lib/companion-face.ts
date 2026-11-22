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
 * inside a FACE_BOX-unit square. That square *is* the silhouette: the ball on
 * screen is drawn at exactly SPHERE_C ± SPHERE_R and the face paints onto it
 * at scale 1, so there is no separate anchor scale to keep in sync. Eyes are
 * rings of points on that sphere, so a gaze deflection slides them across it
 * and compresses them at the limb — the detail that separates "a face on a
 * sticker" from "a face on a body".
 *
 * ── Why rings and not paths ───────────────────────────────────────────────
 * An expression is a pair of closed point rings. Two expressions interpolate
 * point-by-point, so the face *morphs* between moods instead of cutting — and
 * a morph is what reads as alive. Every ring therefore carries a fixed point
 * count (RING_POINTS) and a matching winding direction.
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

/** How far a full-deflection gaze moves the eyes, in face units.
 *
 *  Tuned up from 13.2/8.4 (2026-09-20, user report "有眼动但是幅度不够明显"):
 *  the eye ring is ~26 units wide on a 240-unit face box, so ±13 units read
 *  as a small nudge rather than a look. The sphere's own yaw foreshortening
 *  (gazeYaw) keeps the motion volumetric instead of sliding a decal, so the
 *  larger travel still reads as the face turning on a ball. Y travel is kept
 *  at ~0.67 of X: a horizontal sweep is the readable axis, and an equal
 *  vertical budget makes the eyes drift off the shell's lit band. */
export const GAZE_TRAVEL = { x: 20.5, y: 13.5 } as const;

/** Points per eye ring. Fixed so any two expressions interpolate. */
export const RING_POINTS = 48;

export type Ring = Array<[number, number]>;
export type Face = [Ring, Ring];

/** The 7-mood axis the rest of the app speaks (SpriteMood). */
export const COMPANION_MOODS = ["rest", "hover", "dragging", "working", "waiting", "analyzing", "error"] as const;
export type CompanionMood = (typeof COMPANION_MOODS)[number];

/**
 * User-initiated reactions — a SECOND axis, deliberately not folded into
 * `CompanionMood`.
 *
 * `CompanionMood` answers "what is the agent doing" (session store → composer →
 * desktop pet), so its seven values are a session contract. A poke is not a
 * session state: it must never be written to the store, must resolve on its
 * own clock, and must fall back to whatever the agent is actually doing. So
 * reactions live here as a transient override layered ON TOP of the mood.
 *
 * Each one is a real re-read of the pet's personality rather than a colour
 * change: `startled` is the "you touched me" gape, `delighted` the pleased
 * squint after a good poke, `curious` the head-tilt someone gets when they
 * notice the cursor, `dozing` the slow blink of a creature that is about to
 * drop off. See INTERACTION_DIRECTION for how each is played.
 *
 * 2026-09-20: the set grew from 5 to 14 — the chat avatar's reaction
 * surface opened up (click the message avatar to cycle a random reaction),
 * and a five-word vocabulary was too thin next to what the engine can
 * already play (blobstudio-grade richness, user request). The desktop pet
 * keeps using the original five; the rest are avatar-side reactions, all
 * running through the same two tables below. */
export const COMPANION_INTERACTIONS = [
	"startled",
	"delighted",
	"curious",
	"dozing",
	"peek",
	"starstruck",
	"thinking",
	"greeting",
	"celebrate",
	"confused",
	"shy",
	"excited",
	"suspicious",
	"dizzy",
] as const;
export type CompanionInteraction = (typeof COMPANION_INTERACTIONS)[number];

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
 * One row per eye shape, 48 points per ring, authored as a closed loop and
 * normalised so the pair looks straight ahead (see `faceFor`).
 *
 * Each ring is exactly 48 points, clockwise, starting at the top, so any
 * shape lerps into any other. `half` is the lowered lid. `happy` is a
 * symmetric crescent (the right ring is the left ring translated). `sad` is
 * the eye shape the session table's sad state holds.
 */
const ENCODED_EYES: Record<EyeShape, [string, string]> = {
	open: [
		"89.78,89.51 93.31,89.84 96.71,90.88 99.81,92.62 102.47,94.96 104.60,97.80 106.09,101.03 106.87,104.49 107.00,108.04 107.00,111.60 106.99,115.16 106.99,118.72 106.98,122.27 106.97,125.83 106.97,129.39 106.96,132.95 106.96,136.51 106.93,140.06 106.23,143.55 104.82,146.81 102.78,149.71 100.17,152.12 97.12,153.93 93.76,155.07 90.23,155.49 86.69,155.16 83.30,154.11 80.20,152.38 77.54,150.04 75.41,147.20 73.92,143.97 73.14,140.51 73.00,136.96 73.00,133.40 73.00,129.84 73.00,126.28 73.00,122.72 73.00,119.17 73.00,115.61 73.00,112.05 73.00,108.49 73.08,104.94 73.78,101.45 75.19,98.20 77.23,95.29 79.84,92.88 82.89,91.07 86.25,89.93",
		"149.78,89.51 153.31,89.84 156.71,90.88 159.81,92.62 162.47,94.96 164.60,97.80 166.09,101.03 166.87,104.49 167.00,108.04 167.00,111.60 166.99,115.16 166.99,118.72 166.98,122.27 166.97,125.83 166.97,129.39 166.96,132.95 166.96,136.51 166.93,140.06 166.23,143.55 164.82,146.81 162.78,149.71 160.17,152.12 157.12,153.93 153.76,155.07 150.23,155.49 146.69,155.16 143.30,154.11 140.20,152.38 137.54,150.04 135.41,147.20 133.92,143.97 133.14,140.51 133.00,136.96 133.00,133.40 133.00,129.84 133.00,126.28 133.00,122.72 133.00,119.17 133.00,115.61 133.00,112.05 133.00,108.49 133.08,104.94 133.78,101.45 135.19,98.20 137.23,95.29 139.84,92.88 142.89,91.07 146.25,89.93",
	],
	closed: [
		"90.24,118.00 92.20,118.00 94.17,118.00 96.13,118.00 98.09,118.00 100.06,118.00 102.02,118.00 103.99,118.00 105.95,118.00 107.89,118.22 109.57,119.21 110.67,120.82 110.99,122.74 110.47,124.62 109.20,126.10 107.43,126.90 105.47,127.00 103.51,127.00 101.54,127.00 99.58,127.00 97.62,127.00 95.65,127.00 93.69,127.00 91.73,127.00 89.76,127.00 87.80,126.99 85.83,126.99 83.87,126.99 81.91,126.99 79.94,126.99 77.98,126.99 76.01,126.99 74.05,126.99 72.11,126.78 70.43,125.79 69.33,124.19 69.01,122.26 69.53,120.39 70.80,118.91 72.57,118.10 74.53,118.00 76.49,118.00 78.46,118.00 80.42,118.00 82.38,118.00 84.35,118.00 86.31,118.00 88.28,118.00",
		"150.24,118.00 152.20,118.00 154.17,118.00 156.13,118.00 158.09,118.00 160.06,118.00 162.02,118.00 163.99,118.00 165.95,118.00 167.89,118.22 169.57,119.21 170.67,120.82 170.99,122.74 170.47,124.62 169.20,126.10 167.43,126.90 165.47,127.00 163.51,127.00 161.54,127.00 159.58,127.00 157.62,127.00 155.65,127.00 153.69,127.00 151.73,127.00 149.76,127.00 147.80,126.99 145.83,126.99 143.87,126.99 141.91,126.99 139.94,126.99 137.98,126.99 136.01,126.99 134.05,126.99 132.11,126.78 130.43,125.79 129.33,124.19 129.01,122.26 129.53,120.39 130.80,118.91 132.57,118.10 134.53,118.00 136.49,118.00 138.46,118.00 140.42,118.00 142.38,118.00 144.35,118.00 146.31,118.00 148.28,118.00",
	],
	happy: [
		"77.47,113.48 79.08,115.24 80.62,117.09 82.28,118.83 84.08,120.41 86.08,121.74 88.30,122.65 90.68,122.84 92.98,122.20 95.07,121.02 96.96,119.54 98.68,117.86 100.26,116.06 101.78,114.20 103.70,112.79 106.02,112.29 108.36,112.79 110.27,114.22 111.43,116.29 111.63,118.66 110.86,120.90 109.44,122.84 107.89,124.67 106.25,126.43 104.50,128.08 102.65,129.60 100.68,130.98 98.59,132.16 96.39,133.11 94.09,133.80 91.72,134.19 89.32,134.26 86.93,134.01 84.60,133.45 82.35,132.61 80.21,131.52 78.19,130.22 76.29,128.76 74.50,127.16 72.81,125.45 71.22,123.65 69.72,121.77 68.59,119.68 68.36,117.31 69.13,115.06 70.74,113.32 72.93,112.39 75.32,112.43",
		"137.47,113.48 139.08,115.24 140.62,117.09 142.28,118.83 144.08,120.41 146.08,121.74 148.30,122.65 150.68,122.84 152.98,122.20 155.07,121.02 156.96,119.54 158.68,117.86 160.26,116.06 161.78,114.20 163.70,112.79 166.02,112.29 168.36,112.79 170.27,114.22 171.43,116.29 171.63,118.66 170.86,120.90 169.44,122.84 167.89,124.67 166.25,126.43 164.50,128.08 162.65,129.60 160.68,130.98 158.59,132.16 156.39,133.11 154.09,133.80 151.72,134.19 149.32,134.26 146.93,134.01 144.60,133.45 142.35,132.61 140.21,131.52 138.19,130.22 136.29,128.76 134.50,127.16 132.81,125.45 131.22,123.65 129.72,121.77 128.59,119.68 128.36,117.31 129.13,115.06 130.74,113.32 132.93,112.39 135.32,112.43",
	],
	half: [
		"90.13,104.26 92.67,104.26 95.20,104.27 97.72,104.55 100.13,105.32 102.35,106.54 104.29,108.17 105.88,110.15 107.05,112.39 107.77,114.82 108.00,117.35 108.00,119.89 108.00,122.42 108.00,124.96 107.79,127.49 107.21,129.96 106.28,132.32 105.03,134.52 103.46,136.52 101.63,138.27 99.56,139.73 97.30,140.88 94.90,141.70 92.41,142.16 89.87,142.26 87.34,142.13 84.85,141.63 82.46,140.78 80.22,139.60 78.18,138.10 76.37,136.33 74.83,134.31 73.61,132.09 72.72,129.71 72.18,127.24 72.00,124.71 72.00,122.17 72.00,119.63 72.00,117.09 72.28,114.58 73.04,112.16 74.26,109.94 75.89,107.99 77.86,106.40 80.10,105.22 82.53,104.50 85.05,104.26 87.59,104.26",
		"150.13,104.26 152.67,104.26 155.20,104.27 157.72,104.55 160.13,105.32 162.35,106.54 164.29,108.17 165.88,110.15 167.05,112.39 167.77,114.82 168.00,117.35 168.00,119.89 168.00,122.42 168.00,124.96 167.79,127.49 167.21,129.96 166.28,132.32 165.03,134.52 163.46,136.52 161.63,138.27 159.56,139.73 157.30,140.88 154.90,141.70 152.41,142.16 149.87,142.26 147.34,142.13 144.85,141.63 142.46,140.78 140.22,139.60 138.18,138.10 136.37,136.33 134.83,134.31 133.61,132.09 132.72,129.71 132.18,127.24 132.00,124.71 132.00,122.17 132.00,119.63 132.00,117.09 132.28,114.58 133.04,112.16 134.26,109.94 135.89,107.99 137.86,106.40 140.10,105.22 142.53,104.50 145.05,104.26 147.59,104.26",
	],
	wide: [
		"89.65,82.51 93.86,82.91 97.88,84.22 101.51,86.39 104.57,89.30 106.91,92.83 108.40,96.78 108.99,100.97 109.00,105.20 109.00,109.44 108.99,113.68 108.98,117.91 108.98,122.15 108.97,126.38 108.97,130.62 108.96,134.86 108.96,139.09 108.95,143.33 108.56,147.54 107.21,151.54 105.00,155.14 102.06,158.17 98.52,160.48 94.55,161.94 90.36,162.49 86.15,162.09 82.13,160.78 78.51,158.61 75.44,155.70 73.10,152.17 71.61,148.22 71.03,144.03 71.01,139.80 71.01,135.56 71.01,131.32 71.01,127.09 71.01,122.85 71.01,118.62 71.01,114.38 71.01,110.14 71.01,105.91 71.01,101.67 71.45,97.47 72.81,93.46 75.01,89.86 77.95,86.83 81.50,84.52 85.46,83.06",
		"149.65,82.51 153.86,82.91 157.88,84.22 161.51,86.39 164.57,89.30 166.91,92.83 168.40,96.78 168.99,100.97 169.00,105.20 169.00,109.44 168.99,113.68 168.98,117.91 168.98,122.15 168.97,126.38 168.97,130.62 168.96,134.86 168.96,139.09 168.95,143.33 168.56,147.54 167.21,151.54 165.00,155.14 162.06,158.17 158.52,160.48 154.55,161.94 150.36,162.49 146.15,162.09 142.13,160.78 138.51,158.61 135.44,155.70 133.10,152.17 131.61,148.22 131.03,144.03 131.01,139.80 131.01,135.56 131.01,131.32 131.01,127.09 131.01,122.85 131.01,118.62 131.01,114.38 131.01,110.14 131.01,105.91 131.01,101.67 131.45,97.47 132.81,93.46 135.01,89.86 137.95,86.83 141.50,84.52 145.46,83.06",
	],
	squint: [
		"89.93,104.86 92.09,104.87 94.22,105.09 96.28,105.73 98.17,106.76 99.82,108.13 101.18,109.80 102.18,111.70 102.80,113.76 103.00,115.91 103.00,118.06 103.00,120.21 103.00,122.37 103.00,124.52 103.00,126.68 102.96,128.83 102.63,130.95 101.94,132.99 100.93,134.89 99.62,136.60 98.05,138.07 96.26,139.26 94.29,140.13 92.21,140.67 90.07,140.86 87.92,140.70 85.83,140.18 83.86,139.32 82.05,138.15 80.47,136.70 79.14,135.01 78.11,133.12 77.41,131.09 77.05,128.96 77.00,126.81 77.00,124.66 77.00,122.50 77.00,120.35 77.00,118.20 77.00,116.04 77.18,113.90 77.77,111.83 78.75,109.92 80.08,108.23 81.72,106.84 83.60,105.79 85.64,105.12 87.78,104.87",
		"149.93,104.86 152.09,104.87 154.22,105.09 156.28,105.73 158.17,106.76 159.82,108.13 161.18,109.80 162.18,111.70 162.80,113.76 163.00,115.91 163.00,118.06 163.00,120.21 163.00,122.37 163.00,124.52 163.00,126.68 162.96,128.83 162.63,130.95 161.94,132.99 160.93,134.89 159.62,136.60 158.05,138.07 156.26,139.26 154.29,140.13 152.21,140.67 150.07,140.86 147.92,140.70 145.83,140.18 143.86,139.32 142.05,138.15 140.47,136.70 139.14,135.01 138.11,133.12 137.41,131.09 137.05,128.96 137.00,126.81 137.00,124.66 137.00,122.50 137.00,120.35 137.00,118.20 137.00,116.04 137.18,113.90 137.77,111.83 138.75,109.92 140.08,108.23 141.72,106.84 143.60,105.79 145.64,105.12 147.78,104.87",
	],
	tense: [
		"89.80,95.51 92.80,95.76 95.70,96.56 98.40,97.88 100.79,99.70 102.81,101.92 104.38,104.49 105.43,107.30 105.96,110.26 106.00,113.27 105.99,116.28 105.99,119.29 105.98,122.30 105.97,125.31 105.97,128.32 105.96,131.33 105.96,134.34 105.54,137.32 104.54,140.15 103.05,142.76 101.08,145.03 98.73,146.90 96.07,148.30 93.19,149.17 90.20,149.49 87.21,149.24 84.31,148.44 81.61,147.12 79.22,145.30 77.20,143.08 75.63,140.51 74.58,137.70 74.05,134.74 74.00,131.73 74.00,128.72 74.00,125.71 74.00,122.70 74.00,119.69 74.00,116.68 74.00,113.67 74.04,110.66 74.47,107.68 75.47,104.85 76.96,102.24 78.93,99.97 81.28,98.10 83.94,96.70 86.82,95.83",
		"149.80,95.51 152.80,95.76 155.70,96.56 158.40,97.88 160.79,99.70 162.81,101.92 164.38,104.49 165.43,107.30 165.96,110.26 166.00,113.27 165.99,116.28 165.99,119.29 165.98,122.30 165.97,125.31 165.97,128.32 165.96,131.33 165.96,134.34 165.54,137.32 164.54,140.15 163.05,142.76 161.08,145.03 158.73,146.90 156.07,148.30 153.19,149.17 150.20,149.49 147.21,149.24 144.31,148.44 141.61,147.12 139.22,145.30 137.20,143.08 135.63,140.51 134.58,137.70 134.05,134.74 134.00,131.73 134.00,128.72 134.00,125.71 134.00,122.70 134.00,119.69 134.00,116.68 134.00,113.67 134.04,110.66 134.47,107.68 135.47,104.85 136.96,102.24 138.93,99.97 141.28,98.10 143.94,96.70 146.82,95.83",
	],
	sad: [
		"89.88,97.98 92.59,98.67 95.12,99.84 97.40,101.46 99.32,103.48 100.86,105.81 101.91,108.40 102.62,111.10 103.29,113.82 103.96,116.53 104.63,119.25 105.30,121.96 105.97,124.68 106.64,127.39 107.27,130.11 107.40,132.90 107.01,135.67 106.11,138.31 104.75,140.74 102.95,142.88 100.79,144.64 98.34,145.99 95.68,146.84 92.91,147.19 90.12,147.02 87.42,146.33 84.88,145.16 82.61,143.54 80.68,141.52 79.15,139.19 78.09,136.60 77.39,133.90 76.71,131.19 76.03,128.47 75.36,125.76 74.68,123.05 74.00,120.33 73.33,117.62 72.74,114.89 72.61,112.10 72.99,109.33 73.90,106.69 75.26,104.26 77.06,102.12 79.22,100.36 81.67,99.02 84.33,98.17 87.10,97.81",
		"149.99,98.00 152.78,97.81 155.55,98.14 158.21,98.96 160.67,100.28 162.85,102.03 164.67,104.15 166.06,106.57 166.98,109.21 167.39,111.97 167.28,114.76 166.71,117.49 166.03,120.20 165.34,122.91 164.66,125.62 163.98,128.34 163.30,131.05 162.61,133.76 161.93,136.47 160.92,139.07 159.41,141.42 157.49,143.45 155.24,145.10 152.71,146.29 150.01,147.00 147.23,147.19 144.46,146.86 141.79,146.04 139.33,144.72 137.15,142.97 135.33,140.85 133.95,138.43 133.03,135.79 132.61,133.03 132.72,130.24 133.30,127.51 133.97,124.80 134.65,122.08 135.32,119.37 136.00,116.66 136.68,113.94 137.35,111.23 138.06,108.52 139.09,105.93 140.60,103.58 142.51,101.55 144.77,99.90 147.29,98.71",
	],
	bored: [
		"89.98,112.71 92.16,112.71 94.33,112.71 96.51,112.71 98.69,112.71 100.87,112.71 103.04,112.78 105.14,113.35 107.00,114.47 108.50,116.04 109.51,117.96 109.97,120.08 110.00,122.26 109.85,124.43 109.25,126.52 108.21,128.43 106.78,130.06 105.03,131.36 103.04,132.24 100.91,132.67 98.74,132.71 96.56,132.71 94.38,132.71 92.20,132.71 90.02,132.71 87.84,132.71 85.67,132.71 83.49,132.71 81.31,132.71 79.13,132.67 77.00,132.25 75.01,131.38 73.26,130.10 71.82,128.46 70.77,126.56 70.16,124.48 70.00,122.31 70.02,120.13 70.47,118.00 71.48,116.08 72.96,114.50 74.82,113.37 76.91,112.79 79.09,112.71 81.26,112.71 83.44,112.71 85.62,112.71 87.80,112.71",
		"149.98,112.71 152.16,112.71 154.33,112.71 156.51,112.71 158.69,112.71 160.87,112.71 163.04,112.78 165.14,113.35 167.00,114.47 168.50,116.04 169.51,117.96 169.97,120.08 170.00,122.26 169.85,124.43 169.25,126.52 168.21,128.43 166.78,130.06 165.03,131.36 163.04,132.24 160.91,132.67 158.74,132.71 156.56,132.71 154.38,132.71 152.20,132.71 150.02,132.71 147.84,132.71 145.67,132.71 143.49,132.71 141.31,132.71 139.13,132.67 137.00,132.25 135.01,131.38 133.26,130.10 131.82,128.46 130.77,126.56 130.16,124.48 130.00,122.31 130.02,120.13 130.47,118.00 131.48,116.08 132.96,114.50 134.82,113.37 136.91,112.79 139.09,112.71 141.26,112.71 143.44,112.71 145.62,112.71 147.80,112.71",
	],
	dizzy: [
		"89.81,103.11 92.02,103.25 94.18,103.71 96.25,104.48 98.19,105.54 99.95,106.88 101.49,108.46 102.79,110.26 103.80,112.22 104.51,114.32 104.90,116.49 105.00,118.70 104.98,120.91 104.97,123.13 104.95,125.34 104.60,127.52 103.94,129.63 102.97,131.62 101.72,133.44 100.22,135.06 98.50,136.45 96.59,137.57 94.54,138.39 92.39,138.91 90.19,139.09 87.98,138.95 85.82,138.49 83.75,137.72 81.81,136.66 80.06,135.32 78.51,133.74 77.22,131.94 76.21,129.98 75.50,127.88 75.10,125.71 75.00,123.50 75.00,121.29 75.00,119.07 75.05,116.86 75.40,114.68 76.07,112.57 77.03,110.58 78.28,108.76 79.78,107.14 81.50,105.75 83.41,104.63 85.46,103.81 87.61,103.29",
		"149.91,104.90 152.24,105.07 154.53,105.57 156.72,106.39 158.77,107.53 160.63,108.95 162.26,110.63 163.63,112.52 164.70,114.61 165.46,116.82 165.89,119.12 166.00,121.46 165.98,123.81 165.97,126.15 165.91,128.49 165.51,130.80 164.78,133.02 163.73,135.11 162.38,137.03 160.76,138.72 158.92,140.17 156.89,141.33 154.71,142.18 152.43,142.71 150.09,142.90 147.76,142.73 145.47,142.23 143.28,141.41 141.24,140.27 139.38,138.85 137.74,137.17 136.37,135.28 135.30,133.19 134.54,130.98 134.11,128.68 134.00,126.34 134.00,123.99 134.00,121.65 134.09,119.31 134.49,117.00 135.22,114.78 136.28,112.69 137.63,110.77 139.24,109.08 141.08,107.63 143.11,106.47 145.29,105.62 147.57,105.09",
	],
	cross: [
		"89.99,113.00 92.56,111.02 95.14,109.05 97.72,107.07 100.34,105.18 103.42,105.58 105.75,107.85 107.51,110.49 106.44,113.42 104.14,115.71 101.85,118.01 99.54,120.30 99.50,122.49 101.48,125.06 103.45,127.64 105.43,130.22 107.32,132.84 106.92,135.92 104.65,138.25 102.01,140.01 99.08,138.94 96.79,136.64 94.49,134.35 92.20,132.04 90.01,132.00 87.44,133.98 84.86,135.95 82.28,137.93 79.66,139.82 76.58,139.42 74.25,137.15 72.49,134.51 73.56,131.58 75.86,129.29 78.15,126.99 80.46,124.70 80.50,122.51 78.52,119.94 76.55,117.36 74.57,114.78 72.68,112.16 73.08,109.08 75.35,106.75 77.99,104.99 80.92,106.06 83.21,108.36 85.51,110.65 87.80,112.96",
		"149.99,113.00 152.56,111.02 155.14,109.05 157.72,107.07 160.34,105.18 163.42,105.58 165.75,107.85 167.51,110.49 166.44,113.42 164.14,115.71 161.85,118.01 159.54,120.30 159.50,122.49 161.48,125.06 163.45,127.64 165.43,130.22 167.32,132.84 166.92,135.92 164.65,138.25 162.01,140.01 159.08,138.94 156.79,136.64 154.49,134.35 152.20,132.04 150.01,132.00 147.44,133.98 144.86,135.95 142.28,137.93 139.66,139.82 136.58,139.42 134.25,137.15 132.49,134.51 133.56,131.58 135.86,129.29 138.15,126.99 140.46,124.70 140.50,122.51 138.52,119.94 136.55,117.36 134.57,114.78 132.68,112.16 133.08,109.08 135.35,106.75 137.99,104.99 140.92,106.06 143.21,108.36 145.51,110.65 147.80,112.96",
	],
	star: [
		"90.00,102.50 90.90,104.94 91.79,107.38 92.69,109.81 93.58,112.25 94.48,114.69 95.37,117.13 97.81,118.02 100.25,118.92 102.69,119.81 105.12,120.71 107.56,121.60 110.00,122.50 107.56,123.40 105.12,124.29 102.69,125.19 100.25,126.08 97.81,126.98 95.37,127.87 94.48,130.31 93.58,132.75 92.69,135.19 91.79,137.62 90.90,140.06 90.00,142.50 89.10,140.06 88.21,137.62 87.31,135.19 86.42,132.75 85.52,130.31 84.63,127.87 82.19,126.98 79.75,126.08 77.31,125.19 74.88,124.29 72.44,123.40 70.00,122.50 72.44,121.60 74.88,120.71 77.31,119.81 79.75,118.92 82.19,118.02 84.63,117.13 85.52,114.69 86.42,112.25 87.31,109.81 88.21,107.38 89.10,104.94",
		"150.00,102.50 150.90,104.94 151.79,107.38 152.69,109.81 153.58,112.25 154.48,114.69 155.37,117.13 157.81,118.02 160.25,118.92 162.69,119.81 165.12,120.71 167.56,121.60 170.00,122.50 167.56,123.40 165.12,124.29 162.69,125.19 160.25,126.08 157.81,126.98 155.37,127.87 154.48,130.31 153.58,132.75 152.69,135.19 151.79,137.62 150.90,140.06 150.00,142.50 149.10,140.06 148.21,137.62 147.31,135.19 146.42,132.75 145.52,130.31 144.63,127.87 142.19,126.98 139.75,126.08 137.31,125.19 134.88,124.29 132.44,123.40 130.00,122.50 132.44,121.60 134.88,120.71 137.31,119.81 139.75,118.92 142.19,118.02 144.63,117.13 145.52,114.69 146.42,112.25 147.31,109.81 148.21,107.38 149.10,104.94",
	],
};

const MOUTH_SPEC: Record<EyeShape, number[]> = {
	open: [16.0, 3.6, 21.0, 0.0],
	closed: [14.0, -1.0, 16.0, 0.0],
	happy: [22.0, 8.5, 40.0, 0.0],
	half: [12.0, 0.8, 24.0, 0.0],
	wide: [20.0, 10.0, 16.0, 0.0],
	squint: [13.0, 3.0, 20.0, 0.0],
	tense: [11.0, 0.6, 20.0, 0.0],
	sad: [15.0, -5.5, 18.0, 0.0],
	bored: [12.0, -1.2, 22.0, 0.0],
	dizzy: [12.0, 1.0, 20.0, 0.0],
	cross: [13.0, -2.0, 18.0, 0.0],
	star: [16.0, 6.0, 22.0, 0.0],
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

const MOOD_DIRECTION: Record<CompanionMood, MoodDirection> = {
	rest: { eyes: "open", drift: "happy", blinkMs: 5200, look: 0.18 },
	hover: { eyes: "squint", drift: "happy", blinkMs: 3800, look: 0 },
	dragging: { eyes: "wide", drift: "dizzy", blinkMs: 2400, look: -0.3 },
	working: { eyes: "tense", blinkMs: 0, look: 0.34 },
	waiting: { eyes: "half", drift: "bored", blinkMs: 6400, look: -0.14 },
	analyzing: { eyes: "half", drift: "dizzy", blinkMs: 0, look: 0.4 },
	error: { eyes: "cross", blinkMs: 0, look: 0 },
};

export const moodDirection = (mood: string): MoodDirection =>
	MOOD_DIRECTION[mood as CompanionMood] ?? MOOD_DIRECTION.rest;

/**
 * How each of the 39 session states plays the eye vocabulary — the state
 * axis's face table (see companion.ts COMPANION_STATES).
 *
 * This is not 39 drawings. The vocabulary is still the 12 eye shapes; what
 * changes per state is which shape it holds, what it drifts to, how often it
 * blinks and where it rests its gaze. That is the whole expressive budget,
 * and it is why 39 states cost 39 rows of data instead of 39 drawings.
 *
 * Two rules held throughout:
 *  - **States that need concentration do not blink.** `blinkMs: 0` on every
 *    reading/working/scanning state — a blink is what a face does when it has
 *    a spare moment, and a pet that blinks while it is mid-tool reads as
 *    bored, not busy.
 *  - **The drift is where the personality lives.** A state that only ever
 *    holds one shape is a texture; the drift is what keeps it finding new
 *    poses to rest in while the state runs for minutes.
 *
 * `thinking-dots` and `powering-down` wear `closed` because their content is
 * not a face at all — the effects layer replaces it (three dots / a collapse).
 */
export const COMPANION_STATE_DIRECTION: Record<string, MoodDirection> = {
	// ── A. the turn loop
	idle: { eyes: "open", drift: "happy", blinkMs: 5200, look: 0.18 },
	listening: { eyes: "open", drift: "wide", blinkMs: 4200, look: 0.1 },
	// half is the lowered lid, held — a blink would open it.
	thinking: { eyes: "half", drift: "dizzy", blinkMs: 0, look: 0.4 },
	working: { eyes: "tense", blinkMs: 0, look: 0.34 },
	searching: { eyes: "squint", drift: "half", blinkMs: 0, look: 0.55 },
	reading: { eyes: "half", drift: "tense", blinkMs: 0, look: 0.35 },
	writing: { eyes: "half", drift: "tense", blinkMs: 3000, look: -0.2 },
	// Open eyes and a medium sway — a different face from writing's lowered lid.
	composing: { eyes: "open", drift: "half", blinkMs: 3400, look: 0.08 },
	// ── B. transfer
	sending: { eyes: "open", drift: "star", blinkMs: 3200, look: 0.1 },
	receiving: { eyes: "open", drift: "wide", blinkMs: 3200, look: -0.1 },
	uploading: { eyes: "tense", drift: "open", blinkMs: 2600, look: -0.35 },
	loading: { eyes: "half", drift: "bored", blinkMs: 6400, look: 0 },
	// ── C. progress
	progress: { eyes: "half", drift: "bored", blinkMs: 5200, look: -0.1 },
	orbit: { eyes: "happy", drift: "star", blinkMs: 4800, look: 0.2 },
	radar: { eyes: "squint", drift: "half", blinkMs: 0, look: 0.5 },
	"thinking-dots": { eyes: "closed", blinkMs: 0, look: 0 },
	humming: { eyes: "happy", drift: "closed", blinkMs: 5600, look: 0.15 },
	// ── D. notification / input
	// half + the waiting lean. Idle stays on open, so the two cannot collapse.
	waiting: { eyes: "half", drift: "bored", blinkMs: 6400, look: -0.14 },
	notifying: { eyes: "wide", drift: "open", blinkMs: 2400, look: 0.3 },
	// cross is this state's alone.
	alerting: { eyes: "cross", blinkMs: 0, look: 0 },
	dictating: { eyes: "open", drift: "half", blinkMs: 2000, look: -0.15 },
	refusing: { eyes: "sad", drift: "squint", blinkMs: 3600, look: -0.22 },
	// ── E. emotion
	excited: { eyes: "wide", drift: "star", blinkMs: 1600, look: 0.35 },
	// Symmetric crescent. Celebrate arrives on star and rests here.
	happy: { eyes: "happy", drift: "squint", blinkMs: 3000, look: 0.22 },
	celebrate: { eyes: "star", drift: "happy", blinkMs: 2400, look: 0.25 },
	confused: { eyes: "squint", drift: "dizzy", blinkMs: 2800, look: -0.35 },
	sad: { eyes: "sad", blinkMs: 4800, look: -0.2 },
	curious: { eyes: "half", drift: "open", blinkMs: 4600, look: 0.55 },
	proud: { eyes: "happy", drift: "squint", blinkMs: 3600, look: -0.1 },
	shy: { eyes: "squint", drift: "closed", blinkMs: 2600, look: -0.18 },
	playful: { eyes: "happy", drift: "star", blinkMs: 2200, look: 0.3 },
	// ── F. lifecycle
	spawning: { eyes: "wide", drift: "open", blinkMs: 1800, look: 0 },
	"powering-down": { eyes: "closed", blinkMs: 0, look: 0 },
	bouncing: { eyes: "happy", drift: "star", blinkMs: 2000, look: 0.2 },
	dragging: { eyes: "wide", drift: "dizzy", blinkMs: 2400, look: -0.3 },
	bored: { eyes: "half", drift: "bored", blinkMs: 7600, look: -0.12 },
	drowsy: { eyes: "half", drift: "bored", blinkMs: 9000, look: -0.3 },
	sleeping: { eyes: "half", drift: "closed", blinkMs: 0, look: 0 },
	waking: { eyes: "wide", drift: "open", blinkMs: 1800, look: 0.12 },
};

export const companionStateDirection = (state: string): MoodDirection =>
	COMPANION_STATE_DIRECTION[state] ?? MOOD_DIRECTION.rest;

/**
 * How long a state takes to ease over to its drift face — the "how often it
 * finds a new resting pose" clock. Busy states change pose faster (they are
 * actively working through something); ambient and drowsy states stretch it
 * out, because a slow drift is what reads as calm. Everything not listed
 * falls back to DEFAULT_DRIFT_MS.
 */
export const DEFAULT_DRIFT_MS = 3400;
export const STATE_DRIFT_MS: Record<string, number> = {
	idle: 4200,
	listening: 3600,
	thinking: 3000,
	working: 2400,
	writing: 2000,
	searching: 1800,
	reading: 4200,
	composing: 2800,
	waiting: 5400,
	refusing: 3600,
	bored: 7000,
	sleeping: 9000,
	waking: 1400,
	orbit: 5200,
	radar: 2000,
	humming: 5200,
	"thinking-dots": 5200,
	drowsy: 8000,
	progress: 5200,
};
export const driftMsForState = (state: string): number => STATE_DRIFT_MS[state] ?? DEFAULT_DRIFT_MS;

/**
 * How each user-initiated reaction plays. Same vocabulary as a mood, so the
 * engine needs no second code path — only a second lookup.
 *
 *   startled   the gape: eyes fly wide, gaze snaps to centre, no blink (a
 *              blink mid-startle reads as a wink). Short — it is the flinch,
 *              not the reaction.
 *   delighted  the pleased squint after a good poke, with a happy drift and
 *              a warm look toward the hand that did it.
 *   curious    the head-tilt: half-lidded and drawn toward the cursor, held
 *              long enough to read as "hm?" rather than a glance.
 *   dozing     pre-sleep: half eyes drifting to bored, a very long cadence
 *              so a blink lands rarely and heavily.
 *   peek        caught looking: awake eyes, a fast blink, gaze parked off to
 *              one side — the pet pretending it was not watching you.
 *   starstruck  the awe face: star eyes, held (no blink), nearly centred —
 *              it cannot look away from whatever it just saw.
 *   thinking    the "hm": half-lidded, drifting tense, gaze parked up and
 *              away, no blink — focused, not sleepy.
 *   greeting    the hello: a happy face with an open drift and a springy
 *              bounce to match.
 *   celebrate   the win: star eyes over a happy drift, the biggest bounce
 *              in the set.
 *   confused    the "?": squint drifting toward dizzy, a wobbly sway and a
 *              small leftward glance. Cross stays on the alerting state.
 *   shy         the aww: squint drifting closed, making itself small and
 *              looking away.
 *   excited     the anticipation: wide eyes darting toward star, quick
 *              little hops.
 *   suspicious  the narrowed stare: tense eyes, no blink, a slow lean —
 *              it is watching you sideways.
 *   dizzy       the woozy sway: dizzy rings rolling with the motion.
 */
const INTERACTION_DIRECTION: Record<CompanionInteraction, MoodDirection> = {
	startled: { eyes: "wide", blinkMs: 0, look: 0 },
	delighted: { eyes: "happy", drift: "squint", blinkMs: 3000, look: 0.22 },
	curious: { eyes: "half", drift: "open", blinkMs: 4600, look: 0.55 },
	dozing: { eyes: "half", drift: "bored", blinkMs: 9000, look: -0.3 },
	peek: { eyes: "open", drift: "squint", blinkMs: 1800, look: -0.6 },
	starstruck: { eyes: "star", drift: "star", blinkMs: 0, look: 0.12 },
	thinking: { eyes: "half", drift: "tense", blinkMs: 0, look: 0.5 },
	greeting: { eyes: "happy", drift: "open", blinkMs: 3200, look: 0.18 },
	celebrate: { eyes: "star", drift: "happy", blinkMs: 2400, look: 0.25 },
	confused: { eyes: "squint", drift: "dizzy", blinkMs: 2800, look: -0.35 },
	shy: { eyes: "squint", drift: "closed", blinkMs: 2600, look: -0.18 },
	excited: { eyes: "wide", drift: "star", blinkMs: 1600, look: 0.35 },
	suspicious: { eyes: "tense", drift: "squint", blinkMs: 0, look: -0.55 },
	dizzy: { eyes: "dizzy", drift: "dizzy", blinkMs: 3000, look: -0.2 },
};

export const interactionDirection = (it: string): MoodDirection =>
	INTERACTION_DIRECTION[it as CompanionInteraction] ?? MOOD_DIRECTION.rest;

/** How long a reaction holds before the pet falls back to its mood (ms).
 *  Not exported per-interaction as a map — the caller (which owns the
 *  gesture) knows better than this table whether a poke should linger. */
export const INTERACTION_HOLD_MS = 1100;

/** Pick a random interaction for a click reaction — never the same one
 *  twice in a row (a repeated surprise is not a surprise; the avatar,
 *  composer pet and floating pet all share this). `last` is the caller's
 *  previous pick (null on mount); `exclude` removes states a poke should
 *  never play (the floating pet's `dozing` is scheduler-owned). */
export function randomCompanionInteraction(
	last: CompanionInteraction | null,
	exclude: readonly CompanionInteraction[] = [],
): CompanionInteraction {
	const pool = COMPANION_INTERACTIONS.filter(x => !exclude.includes(x));
	const pick = pool[Math.floor(Math.random() * pool.length)] ?? COMPANION_INTERACTIONS[0];
	return pick === last ? (pool[(pool.indexOf(pick) + 1) % pool.length] ?? pick) : pick;
}

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
