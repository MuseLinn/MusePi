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

/** The 7-mood axis the rest of the app speaks (PetdexMood). */
export const PET_MOODS = ["rest", "hover", "dragging", "working", "waiting", "analyzing", "error"] as const;
export type PetMood = (typeof PET_MOODS)[number];

/**
 * User-initiated reactions — a SECOND axis, deliberately not folded into
 * `PetMood`.
 *
 * `PetMood` answers "what is the agent doing" (session store → composer →
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
export const PET_INTERACTIONS = [
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
export type PetInteraction = (typeof PET_INTERACTIONS)[number];

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
 * These are measured rings, not eyeballed ones: capsule eyes, flat lidded
 * bars, V-angled sad arcs, dazed pinpricks. The point count is fixed at 48 so
 * any shape interpolates with any other.
 */
const ENCODED_EYES: Record<EyeShape, [string, string]> = {
	open: [
		"85.32,99.30 88.34,99.43 91.24,100.27 93.86,101.78 96.04,103.87 97.66,106.43 98.69,109.27 99.30,112.24 99.74,115.23 100.19,118.23 100.70,121.22 101.24,124.20 101.80,127.18 102.38,130.15 102.99,133.12 103.62,136.08 104.29,139.03 104.99,141.98 105.67,144.93 105.90,147.95 105.19,150.88 103.55,153.41 101.21,155.32 98.44,156.50 95.45,156.97 92.43,156.76 89.52,155.94 86.83,154.55 84.50,152.62 82.69,150.21 81.55,147.41 80.84,144.47 80.16,141.51 79.50,138.56 78.87,135.59 78.26,132.63 77.68,129.65 77.12,126.67 76.58,123.69 76.07,120.71 75.58,117.72 75.11,114.72 74.74,111.72 74.88,108.70 75.78,105.81 77.40,103.27 79.65,101.25 82.36,99.91",
		"146.41,87.38 149.42,87.64 152.25,88.70 154.71,90.45 156.64,92.77 157.91,95.52 158.71,98.44 159.39,101.39 160.06,104.35 160.70,107.31 161.33,110.27 161.92,113.24 162.50,116.22 163.05,119.20 163.57,122.18 164.08,125.17 164.57,128.16 164.98,131.16 164.94,134.18 164.16,137.10 162.74,139.77 160.79,142.09 158.41,143.96 155.70,145.28 152.75,145.97 149.73,145.91 146.85,145.03 144.37,143.30 142.63,140.84 141.75,137.95 141.26,134.96 140.79,131.97 140.29,128.98 139.77,125.99 139.22,123.01 138.65,120.04 138.05,117.07 137.43,114.10 136.78,111.14 136.12,108.19 135.43,105.23 134.77,102.28 134.65,99.26 135.25,96.29 136.52,93.55 138.37,91.16 140.71,89.25 143.44,87.95",
	],
	closed: [
		"68.76,106.40 71.35,106.71 73.94,107.01 76.54,107.32 79.13,107.64 81.72,107.98 84.30,108.33 86.89,108.70 89.47,109.07 92.05,109.46 94.63,109.86 97.21,110.28 99.79,110.70 102.36,111.14 104.93,111.59 107.51,111.99 110.07,112.51 112.41,113.63 114.17,115.54 115.10,117.96 114.99,120.55 113.89,122.90 111.99,124.67 109.58,125.63 106.98,125.65 104.42,125.17 101.85,124.71 99.27,124.26 96.70,123.83 94.12,123.40 91.54,123.00 88.96,122.60 86.38,122.21 83.80,121.84 81.21,121.47 78.62,121.13 76.04,120.79 73.44,120.48 70.85,120.18 68.26,119.88 65.66,119.57 63.20,118.76 61.41,116.90 60.67,114.42 60.92,111.83 62.00,109.46 63.80,107.60 66.16,106.52",
		"133.25,117.32 135.75,117.78 138.22,118.41 140.70,119.00 143.17,119.60 145.64,120.21 148.11,120.84 150.57,121.47 153.04,122.12 155.50,122.78 157.95,123.45 160.40,124.14 162.85,124.83 165.30,125.54 167.74,126.27 170.17,127.01 172.61,127.74 174.91,128.81 176.60,130.69 177.54,133.05 177.73,135.58 177.11,138.03 175.63,140.08 173.40,141.26 170.88,141.20 168.44,140.48 166.00,139.73 163.56,139.00 161.12,138.29 158.67,137.59 156.22,136.91 153.76,136.24 151.30,135.59 148.84,134.95 146.37,134.33 143.90,133.71 141.43,133.10 138.96,132.49 136.48,131.88 134.01,131.28 131.54,130.68 129.20,129.69 127.38,127.93 126.35,125.62 126.19,123.09 126.91,120.66 128.48,118.68 130.73,117.53",
	],
	happy: [
		"94.46,77.38 98.87,78.08 103.02,79.73 106.69,82.26 109.65,85.59 111.73,89.53 112.83,93.86 112.81,98.32 111.87,102.68 110.65,106.98 109.40,111.28 108.15,115.57 106.90,119.86 105.63,124.15 104.35,128.44 103.06,132.72 101.76,136.99 100.47,141.27 99.17,145.55 97.76,149.79 95.55,153.66 92.18,156.57 88.13,158.42 83.75,159.29 79.29,159.27 74.89,158.49 70.68,157.00 66.81,154.78 63.51,151.78 61.12,148.02 60.02,143.71 60.58,139.30 61.95,135.04 63.28,130.77 64.59,126.50 65.90,122.22 67.19,117.94 68.46,113.66 69.73,109.37 70.99,105.08 72.24,100.79 73.48,96.49 74.68,92.18 76.21,87.99 78.64,84.25 81.87,81.17 85.73,78.94 90.01,77.66",
		"161.90,85.01 166.11,85.33 169.94,87.09 172.90,90.10 174.77,93.89 175.58,98.04 175.47,102.28 174.92,106.48 174.26,110.67 173.50,114.85 172.62,118.99 171.62,123.12 170.51,127.21 169.28,131.27 167.93,135.29 166.43,139.26 164.78,143.17 162.97,147.00 160.97,150.74 158.56,154.22 155.64,157.29 152.33,159.94 148.71,162.15 144.84,163.89 140.78,165.08 136.57,165.54 132.40,164.90 129.02,162.46 128.04,158.41 129.19,154.36 131.11,150.58 132.95,146.76 134.64,142.86 136.19,138.91 137.60,134.92 138.88,130.87 140.03,126.79 141.06,122.68 141.97,118.53 142.77,114.37 143.41,110.17 144.00,105.97 144.83,101.82 146.17,97.80 148.20,94.08 150.87,90.79 154.08,88.03 157.79,86.00",
	],
	half: [
		"106.25,119.17 108.65,119.53 110.77,120.71 112.35,122.55 113.26,124.81 113.40,127.23 112.64,129.53 111.01,131.32 108.82,132.36 106.42,132.81 104.01,133.18 101.60,133.56 99.19,133.93 96.77,134.29 94.36,134.65 91.95,135.00 89.53,135.34 87.11,135.68 84.70,136.00 82.28,136.31 79.85,136.60 77.43,136.87 75.00,137.11 72.57,137.33 70.14,137.52 67.76,137.12 65.75,135.76 64.27,133.83 63.35,131.58 63.08,129.16 63.67,126.81 65.27,125.01 67.56,124.24 69.99,124.04 72.42,123.80 74.85,123.54 77.27,123.27 79.69,122.99 82.12,122.69 84.54,122.38 86.95,122.06 89.37,121.73 91.79,121.38 94.20,121.03 96.61,120.67 99.02,120.29 101.43,119.90 103.84,119.51",
		"173.65,104.68 176.15,105.53 178.01,107.40 178.95,109.87 178.96,112.52 178.07,115.02 176.31,116.99 173.94,118.17 171.36,118.84 168.78,119.49 166.21,120.16 163.63,120.82 161.05,121.47 158.46,122.11 155.88,122.74 153.29,123.37 150.70,123.99 148.11,124.60 145.52,125.20 142.92,125.78 140.32,126.35 137.72,126.90 135.11,127.43 132.50,127.94 129.85,127.96 127.40,126.98 125.51,125.13 124.41,122.72 124.29,120.07 125.26,117.62 127.15,115.77 129.58,114.71 132.19,114.18 134.80,113.64 137.40,113.08 140.00,112.51 142.60,111.93 145.19,111.34 147.79,110.74 150.38,110.13 152.97,109.52 155.55,108.89 158.14,108.25 160.72,107.60 163.30,106.95 165.88,106.28 168.45,105.60 171.01,104.87",
	],
	wide: [
		"81.55,85.30 85.93,86.72 89.58,89.54 92.28,93.28 94.02,97.56 94.88,102.10 95.60,106.67 96.43,111.22 97.38,115.76 98.43,120.26 99.60,124.74 100.88,129.19 102.27,133.60 103.76,137.98 105.37,142.32 107.09,146.62 108.94,150.86 110.84,155.08 112.38,159.44 112.84,164.03 111.94,168.55 109.52,172.47 105.76,175.11 101.28,176.16 96.68,175.80 92.31,174.31 88.35,171.93 84.91,168.83 82.09,165.17 79.94,161.08 78.06,156.85 76.28,152.58 74.61,148.26 73.04,143.91 71.59,139.51 70.25,135.08 69.01,130.62 67.88,126.13 66.87,121.62 65.97,117.08 65.17,112.52 64.52,107.94 64.40,103.32 65.17,98.76 66.81,94.44 69.33,90.57 72.76,87.49 76.96,85.60",
		"143.25,67.63 148.08,67.85 152.70,69.26 156.81,71.81 160.14,75.32 162.42,79.59 163.97,84.18 165.36,88.83 166.75,93.47 168.14,98.12 169.54,102.76 170.92,107.41 172.31,112.06 173.68,116.71 175.05,121.36 176.45,126.01 177.83,130.66 179.14,135.33 179.83,140.11 179.23,144.91 177.41,149.39 174.49,153.24 170.70,156.26 166.32,158.30 161.58,159.28 156.74,159.11 152.11,157.73 147.99,155.20 144.68,151.68 142.49,147.36 141.04,142.74 139.68,138.08 138.31,133.43 136.94,128.78 135.56,124.13 134.19,119.48 132.80,114.83 131.41,110.18 130.02,105.54 128.61,100.89 127.21,96.25 125.81,91.61 125.13,86.82 125.70,82.02 127.46,77.51 130.34,73.62 134.11,70.59 138.50,68.57",
	],
	squint: [
		"103.93,92.16 106.50,92.81 108.71,94.26 110.38,96.33 111.37,98.78 111.67,101.42 111.34,104.05 110.36,106.51 108.87,108.72 107.17,110.76 105.45,112.79 103.76,114.84 102.09,116.91 100.44,119.00 98.81,121.11 97.22,123.23 95.65,125.38 94.10,127.55 92.59,129.73 91.12,131.95 89.67,134.18 88.23,136.42 86.48,138.41 84.17,139.69 81.54,139.95 79.03,139.11 76.97,137.45 75.45,135.28 74.46,132.81 74.01,130.19 74.10,127.54 74.75,124.97 75.93,122.59 77.35,120.34 78.85,118.14 80.35,115.94 81.87,113.76 83.42,111.60 84.99,109.46 86.60,107.33 88.22,105.23 89.88,103.15 91.55,101.08 93.26,99.04 94.98,97.01 96.75,95.03 98.85,93.40 101.29,92.38",
		"144.04,101.82 146.78,102.50 149.21,103.97 151.13,106.04 152.40,108.58 153.21,111.30 153.94,114.05 154.68,116.79 155.43,119.53 156.18,122.27 156.95,125.01 157.71,127.75 158.48,130.48 159.26,133.22 160.04,135.95 160.84,138.68 161.64,141.41 162.41,144.14 162.79,146.95 162.38,149.75 161.15,152.30 159.25,154.40 156.86,155.92 154.15,156.77 151.32,156.87 148.58,156.18 146.14,154.74 144.19,152.69 142.88,150.17 142.02,147.46 141.24,144.73 140.46,142.00 139.68,139.26 138.90,136.53 138.13,133.79 137.36,131.06 136.60,128.32 135.85,125.58 135.09,122.84 134.34,120.10 133.60,117.35 132.86,114.61 132.54,111.80 132.99,109.00 134.23,106.45 136.13,104.35 138.51,102.81 141.21,101.94",
	],
	tense: [
		"85.72,97.59 88.75,97.82 91.56,98.97 93.96,100.83 95.83,103.23 97.10,106.00 97.88,108.95 98.38,111.95 98.81,114.97 99.32,117.98 99.89,120.97 100.50,123.96 101.14,126.94 101.83,129.91 102.56,132.87 103.33,135.82 104.16,138.76 105.04,141.68 105.90,144.60 106.42,147.60 106.16,150.63 105.02,153.44 102.99,155.69 100.28,157.05 97.26,157.43 94.25,157.00 91.43,155.88 88.90,154.17 86.77,152.00 85.12,149.45 83.97,146.62 83.08,143.71 82.27,140.77 81.47,137.83 80.71,134.87 79.99,131.91 79.31,128.94 78.67,125.96 78.08,122.97 77.52,119.97 77.00,116.96 76.52,113.95 76.11,110.93 76.11,107.89 76.80,104.92 78.18,102.21 80.21,99.95 82.78,98.34",
		"145.19,87.02 148.31,87.40 151.22,88.58 153.73,90.47 155.71,92.91 156.99,95.79 157.79,98.83 158.50,101.90 159.20,104.97 159.89,108.05 160.59,111.12 161.29,114.19 161.98,117.27 162.67,120.34 163.35,123.42 164.06,126.49 164.75,129.56 165.40,132.65 165.61,135.78 164.99,138.86 163.57,141.66 161.47,144.01 158.89,145.79 155.96,146.94 152.85,147.39 149.72,147.06 146.79,145.93 144.26,144.07 142.31,141.61 141.11,138.70 140.38,135.64 139.69,132.56 139.01,129.49 138.32,126.41 137.63,123.34 136.94,120.26 136.25,117.19 135.55,114.12 134.86,111.04 134.16,107.97 133.45,104.90 132.76,101.83 132.57,98.69 133.16,95.60 134.53,92.78 136.58,90.39 139.15,88.58 142.07,87.43",
	],
	sad: [
		"89.04,84.19 91.90,84.90 94.29,86.63 95.99,89.04 97.01,91.82 97.61,94.72 98.07,97.65 98.57,100.57 99.13,103.49 99.74,106.39 100.41,109.28 101.12,112.16 101.89,115.02 102.70,117.87 103.56,120.71 104.45,123.54 105.39,126.35 106.36,129.15 107.36,131.94 108.12,134.81 108.22,137.76 107.44,140.61 105.69,142.98 103.10,144.37 100.16,144.51 97.34,143.64 94.84,142.05 92.77,139.94 91.15,137.46 89.93,134.76 88.93,131.97 87.99,129.15 87.07,126.33 86.20,123.50 85.37,120.65 84.60,117.79 83.87,114.92 83.18,112.03 82.54,109.13 81.96,106.23 81.42,103.31 80.93,100.39 80.49,97.46 80.40,94.50 80.91,91.58 82.00,88.83 83.73,86.43 86.15,84.75",
		"158.23,105.62 161.16,106.09 163.89,107.26 166.26,109.05 168.10,111.38 169.25,114.12 169.58,117.07 169.11,120.00 167.85,122.69 166.04,125.05 164.10,127.31 162.15,129.56 160.19,131.81 158.23,134.05 156.27,136.28 154.29,138.51 152.31,140.74 150.33,142.95 148.33,145.17 146.35,147.39 144.35,149.60 142.31,151.77 139.95,153.56 137.15,154.55 134.19,154.70 131.28,154.11 128.57,152.89 126.18,151.13 124.25,148.87 122.96,146.19 122.52,143.26 123.00,140.34 124.46,137.75 126.43,135.52 128.44,133.32 130.44,131.12 132.43,128.91 134.42,126.69 136.40,124.47 138.37,122.24 140.34,120.00 142.30,117.76 144.26,115.52 146.21,113.27 148.15,111.01 150.13,108.78 152.51,107.01 155.28,105.93",
	],
	bored: [
		"66.85,105.11 69.52,105.12 72.15,105.65 74.78,106.16 77.41,106.68 80.05,107.19 82.68,107.71 85.31,108.23 87.94,108.75 90.57,109.27 93.20,109.80 95.83,110.33 98.47,110.86 101.10,111.39 103.73,111.92 106.35,112.46 108.98,113.00 111.61,113.54 114.06,114.59 115.91,116.51 116.85,119.00 116.77,121.67 115.76,124.14 113.89,126.04 111.41,127.00 108.73,126.97 106.11,126.42 103.49,125.86 100.86,125.32 98.23,124.79 95.60,124.26 92.97,123.73 90.34,123.21 87.70,122.69 85.07,122.18 82.43,121.68 79.80,121.17 77.17,120.65 74.53,120.14 71.90,119.61 69.27,119.08 66.64,118.54 64.18,117.52 62.34,115.60 61.42,113.10 61.47,110.43 62.48,107.96 64.37,106.08",
		"133.01,118.42 135.32,118.52 137.59,119.01 139.86,119.50 142.13,119.99 144.40,120.48 146.67,120.98 148.94,121.48 151.21,121.98 153.48,122.48 155.75,122.99 158.01,123.50 160.28,124.01 162.55,124.53 164.81,125.04 167.08,125.56 169.35,126.06 171.53,126.82 173.11,128.49 173.86,130.68 173.94,133.00 173.48,135.27 172.49,137.37 170.90,139.04 168.74,139.83 166.45,139.54 164.20,138.95 161.93,138.43 159.67,137.91 157.40,137.40 155.13,136.89 152.86,136.39 150.59,135.89 148.32,135.40 146.05,134.91 143.78,134.42 141.51,133.93 139.24,133.44 136.97,132.94 134.70,132.43 132.43,131.91 130.31,131.00 128.67,129.37 127.73,127.26 127.49,124.96 127.94,122.68 129.06,120.66 130.82,119.17",
	],
	dizzy: [
		"94.14,85.28 97.31,85.41 100.34,86.31 103.04,87.97 105.18,90.31 106.61,93.13 107.27,96.23 107.07,99.40 106.37,102.49 105.61,105.58 104.85,108.66 104.11,111.75 103.38,114.84 102.66,117.94 101.95,121.04 101.26,124.13 100.57,127.24 99.91,130.34 99.27,133.45 98.59,136.56 97.55,139.55 95.79,142.19 93.41,144.28 90.56,145.66 87.45,146.23 84.29,145.99 81.28,144.98 78.62,143.27 76.46,140.95 74.96,138.16 74.23,135.08 74.25,131.91 74.75,128.77 75.45,125.67 76.15,122.57 76.83,119.47 77.52,116.37 78.23,113.27 78.94,110.18 79.67,107.08 80.41,103.99 81.16,100.91 81.93,97.83 82.70,94.74 83.85,91.79 85.70,89.22 88.15,87.22 91.03,85.89",
		"152.74,98.60 155.82,99.03 158.65,100.31 161.07,102.26 162.97,104.72 164.24,107.56 164.80,110.62 164.68,113.73 164.20,116.81 163.65,119.88 163.08,122.94 162.46,126.00 161.81,129.05 161.13,132.09 160.41,135.12 159.66,138.15 158.88,141.17 158.08,144.18 157.25,147.19 156.33,150.17 155.08,153.01 153.25,155.53 150.90,157.56 148.13,158.98 145.09,159.64 141.99,159.46 139.07,158.41 136.58,156.55 134.74,154.04 133.70,151.11 133.48,148.01 134.00,144.94 134.84,141.94 135.69,138.94 136.51,135.93 137.29,132.92 138.04,129.89 138.76,126.86 139.44,123.82 140.09,120.77 140.70,117.71 141.29,114.65 141.84,111.58 142.35,108.50 143.19,105.51 144.75,102.82 146.96,100.63 149.69,99.15",
	],
	cross: [
		"84.40,104.31 87.63,104.89 90.72,106.01 93.61,107.58 96.26,109.53 98.65,111.79 100.77,114.31 102.61,117.03 104.18,119.93 105.47,122.95 106.48,126.09 107.20,129.30 107.62,132.56 107.76,135.85 107.58,139.13 107.08,142.38 106.24,145.56 105.01,148.62 103.39,151.48 101.37,154.07 98.98,156.32 96.22,158.12 93.19,159.38 89.97,160.03 86.68,160.05 83.44,159.46 80.35,158.35 77.46,156.78 74.81,154.83 72.43,152.56 70.31,150.05 68.46,147.32 66.89,144.43 65.60,141.40 64.60,138.27 63.88,135.06 63.45,131.80 63.32,128.51 63.49,125.23 63.99,121.97 64.84,118.80 66.06,115.74 67.68,112.88 69.70,110.29 72.10,108.04 74.85,106.24 77.89,104.98 81.11,104.33",
		"154.30,84.60 157.99,84.84 161.62,85.56 165.12,86.73 168.45,88.34 171.54,90.36 174.35,92.77 176.81,95.52 178.88,98.58 180.53,101.89 181.73,105.38 182.47,109.01 182.73,112.69 182.51,116.38 181.81,120.01 180.63,123.51 179.02,126.84 176.98,129.92 174.56,132.71 171.79,135.16 168.73,137.23 165.43,138.89 161.93,140.09 158.31,140.82 154.62,141.06 150.93,140.82 147.31,140.10 143.80,138.93 140.48,137.32 137.38,135.30 134.58,132.89 132.12,130.14 130.04,127.08 128.40,123.77 127.19,120.27 126.46,116.65 126.20,112.97 126.42,109.28 127.12,105.65 128.29,102.14 129.91,98.82 131.95,95.74 134.37,92.95 137.13,90.50 140.19,88.43 143.50,86.77 146.99,85.57 150.62,84.84",
	],
	star: [
		"98.56,107.16 100.58,107.49 102.49,108.24 104.22,109.34 105.73,110.73 106.96,112.37 107.89,114.20 108.56,116.14 109.06,118.13 109.49,120.14 109.90,122.15 110.30,124.16 110.68,126.18 111.03,128.20 111.35,130.23 111.62,132.27 111.73,134.31 111.56,136.36 111.07,138.35 110.26,140.23 109.12,141.94 107.68,143.40 105.97,144.52 104.05,145.23 102.01,145.48 99.98,145.24 98.06,144.53 96.34,143.42 94.88,141.97 93.73,140.28 92.87,138.42 92.34,136.44 92.02,134.41 91.70,132.38 91.36,130.36 90.99,128.33 90.62,126.32 90.22,124.30 89.81,122.29 89.37,120.28 89.09,118.25 89.15,116.20 89.56,114.19 90.33,112.29 91.43,110.57 92.86,109.10 94.58,107.98 96.52,107.32",
		"136.42,99.73 138.15,100.29 139.62,101.36 140.84,102.71 141.86,104.22 142.70,105.83 143.38,107.52 143.93,109.26 144.39,111.03 144.80,112.80 145.19,114.58 145.55,116.37 145.89,118.16 146.21,119.95 146.49,121.75 146.74,123.56 146.96,125.37 147.10,127.19 147.11,129.01 146.95,130.82 146.60,132.61 146.01,134.33 145.15,135.93 143.89,137.24 142.19,137.84 140.43,137.45 138.96,136.38 137.82,134.97 136.95,133.37 136.29,131.67 135.82,129.91 135.47,128.12 135.20,126.32 134.96,124.51 134.70,122.71 134.40,120.91 134.07,119.12 133.72,117.33 133.34,115.54 132.94,113.77 132.52,111.99 132.17,110.20 131.95,108.40 131.95,106.57 132.17,104.77 132.62,103.00 133.39,101.35 134.67,100.08",
	],
};

const MOUTH_SPEC: Record<EyeShape, number[]> = {
	open: [13, 1, 20, 0],
	closed: [16, -3, 22, 0],
	happy: [15, 5, 10, 0],
	half: [16, -3, 22, 0],
	wide: [23, 12, 13, 0],
	squint: [15, 5, 20, 0],
	tense: [17, 8, 20, 0],
	sad: [16, -4, 18, 0],
	bored: [16, -2, 22, 0],
	dizzy: [14, 1, 20, 0],
	cross: [11, 4, 18, 0],
	star: [12, 5, 20, 0],
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

/**
 * How each of the 31 session states plays the eye vocabulary — the state
 * axis's face table (see pet.ts PET_STATES).
 *
 * This is NOT 25 more faces. The vocabulary is still the 12 eye shapes; what
 * changes per state is which shape it holds, what it drifts to, how often it
 * blinks and where it rests its gaze. That is the whole expressive budget,
 * and it is why 31 states cost 31 rows of data instead of 31 drawings.
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
export const STATE_DIRECTION: Record<string, MoodDirection> = {
	// ── A. the turn loop
	idle: { eyes: "open", drift: "happy", blinkMs: 5200, look: 0.18 },
	listening: { eyes: "open", drift: "wide", blinkMs: 4200, look: 0.1 },
	thinking: { eyes: "half", drift: "dizzy", blinkMs: 0, look: 0.4 },
	working: { eyes: "tense", blinkMs: 0, look: 0.34 },
	searching: { eyes: "squint", drift: "half", blinkMs: 0, look: 0.55 },
	writing: { eyes: "half", drift: "tense", blinkMs: 3000, look: -0.2 },
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
	notifying: { eyes: "wide", drift: "open", blinkMs: 2400, look: 0.3 },
	alerting: { eyes: "cross", blinkMs: 0, look: 0 },
	dictating: { eyes: "open", drift: "half", blinkMs: 2000, look: -0.15 },
	// ── E. emotion
	excited: { eyes: "wide", drift: "star", blinkMs: 1600, look: 0.35 },
	happy: { eyes: "happy", drift: "squint", blinkMs: 3000, look: 0.22 },
	celebrate: { eyes: "star", drift: "happy", blinkMs: 2400, look: 0.25 },
	confused: { eyes: "cross", drift: "squint", blinkMs: 2800, look: -0.35 },
	curious: { eyes: "half", drift: "open", blinkMs: 4600, look: 0.55 },
	proud: { eyes: "happy", drift: "squint", blinkMs: 3600, look: -0.1 },
	shy: { eyes: "squint", drift: "closed", blinkMs: 2600, look: -0.18 },
	playful: { eyes: "happy", drift: "star", blinkMs: 2200, look: 0.3 },
	// ── F. lifecycle
	spawning: { eyes: "wide", drift: "open", blinkMs: 1800, look: 0 },
	"powering-down": { eyes: "closed", blinkMs: 0, look: 0 },
	bouncing: { eyes: "happy", drift: "star", blinkMs: 2000, look: 0.2 },
	dragging: { eyes: "wide", drift: "dizzy", blinkMs: 2400, look: -0.3 },
	drowsy: { eyes: "half", drift: "bored", blinkMs: 9000, look: -0.3 },
};

export const stateDirection = (state: string): MoodDirection => STATE_DIRECTION[state] ?? MOOD_DIRECTION.rest;

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
 *   confused    the "?": cross eyes with a wobbly sway and a small
 *              leftward glance.
 *   shy         the aww: squint drifting closed, making itself small and
 *              looking away.
 *   excited     the anticipation: wide eyes darting toward star, quick
 *              little hops.
 *   suspicious  the narrowed stare: tense eyes, no blink, a slow lean —
 *              it is watching you sideways.
 *   dizzy       the woozy sway: dizzy rings rolling with the motion.
 */
const INTERACTION_DIRECTION: Record<PetInteraction, MoodDirection> = {
	startled: { eyes: "wide", blinkMs: 0, look: 0 },
	delighted: { eyes: "happy", drift: "squint", blinkMs: 3000, look: 0.22 },
	curious: { eyes: "half", drift: "open", blinkMs: 4600, look: 0.55 },
	dozing: { eyes: "half", drift: "bored", blinkMs: 9000, look: -0.3 },
	peek: { eyes: "open", drift: "squint", blinkMs: 1800, look: -0.6 },
	starstruck: { eyes: "star", drift: "star", blinkMs: 0, look: 0.12 },
	thinking: { eyes: "half", drift: "tense", blinkMs: 0, look: 0.5 },
	greeting: { eyes: "happy", drift: "open", blinkMs: 3200, look: 0.18 },
	celebrate: { eyes: "star", drift: "happy", blinkMs: 2400, look: 0.25 },
	confused: { eyes: "cross", drift: "squint", blinkMs: 2800, look: -0.35 },
	shy: { eyes: "squint", drift: "closed", blinkMs: 2600, look: -0.18 },
	excited: { eyes: "wide", drift: "star", blinkMs: 1600, look: 0.35 },
	suspicious: { eyes: "tense", drift: "squint", blinkMs: 0, look: -0.55 },
	dizzy: { eyes: "dizzy", drift: "dizzy", blinkMs: 3000, look: -0.2 },
};

export const interactionDirection = (it: string): MoodDirection =>
	INTERACTION_DIRECTION[it as PetInteraction] ?? MOOD_DIRECTION.rest;

/** How long a reaction holds before the pet falls back to its mood (ms).
 *  Not exported per-interaction as a map — the caller (which owns the
 *  gesture) knows better than this table whether a poke should linger. */
export const INTERACTION_HOLD_MS = 1100;

/** Pick a random interaction for a click reaction — never the same one
 *  twice in a row (a repeated surprise is not a surprise; the avatar,
 *  composer pet and floating pet all share this). `last` is the caller's
 *  previous pick (null on mount); `exclude` removes states a poke should
 *  never play (the floating pet's `dozing` is scheduler-owned). */
export function randomPetInteraction(
	last: PetInteraction | null,
	exclude: readonly PetInteraction[] = [],
): PetInteraction {
	const pool = PET_INTERACTIONS.filter(x => !exclude.includes(x));
	const pick = pool[Math.floor(Math.random() * pool.length)] ?? PET_INTERACTIONS[0];
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
