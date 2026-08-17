/**
 * Agent companion (伙伴) prefs + descriptors — BitFun "Agent 伙伴" parity.
 *
 * Three settings (all renderer-local, localStorage — same pattern as the
 * sound/motion prefs):
 *   - omp-gui-pet        "0" | "1"            master switch (default on)
 *   - omp-gui-pet-mode   "input" | "desktop"  where the pet lives
 *   - omp-gui-pet-id     pet id (builtin or imported petdex id)
 *   - omp-gui-petdex     JSON list of imported petdex packages
 *
 * A pet is either a builtin SVG companion (drawn in PetSprite.tsx) or an
 * imported Petdex package (pet.json + spritesheet, 8×9 frame grid).
 */

export type PetMood = "rest" | "working" | "waiting" | "analyzing" | "error";
/** Petdex-only moods — spritesheet rows 1/2 (hover/dragging) that the
 *  floating desktop pet switches to while the pointer is over it or while
 *  it is being dragged (BitFun parity). The builtin SVG has no such rows. */
export type PetdexMood = PetMood | "hover" | "dragging";
export type PetDisplayMode = "input" | "desktop";

/**
 * Activity payload pushed from the main window to the floating pet:
 * mood (sprite state), bubble (notification blurb), state (live task
 * summary for the panel), approval (pending tool approval to answer),
 * scale (size slider). Each field is optional — pushes are partial.
 */
export interface PetActivity {
	mood?: PetMood;
	bubble?: { kind: "completed" | "error" | "question" | "subtask"; text: string; requestId?: string } | null;
	state?: {
		working: boolean;
		streaming: boolean;
		toolName: string | null;
		lastMessage: string | null;
		/** Tree label of the active session (null when none). */
		sessionTitle: string | null;
	};
	approval?: { requestId: string; tool: string } | null;
	/** Recent sessions (label + timestamp) for the pet panel list. */
	recentSessions?: { id: string; label: string; timestamp: number }[];
	/** Unread completion count (pet badge). */
	unreadCount?: number;
	scale?: number;
	/** Main-window locale (the pet window cannot read its localStorage —
	 *  carried so the panel strings match the main UI language). */
	locale?: string;
}

export const PET_MOODS: readonly PetMood[] = ["rest", "working", "waiting", "analyzing", "error"];

export const PET_DISPLAY_MODES: readonly PetDisplayMode[] = ["input", "desktop"];

export const BUILTIN_PET_ID = "musepi";

/**
 * Builtin presets — spritesheets vendored from BitFun (MIT, Copyright 2026
 * CWing) public/agent-companion-pets, downscaled to 768×936 (8×9 grid,
 * 96×104 frames). Ids/descriptions match the upstream pet.json metadata;
 * loaded by relative path from dist/pets/.
 */
export const BUILTIN_PETDEX: readonly {
	id: string;
	displayName: string;
	description: string;
	spritesheetPath: string;
	width: number;
	height: number;
	rows?: readonly number[];
	/** Rest-row (row 0) opaque content height, measured from the vendored
	 *  sheets — normalizes visual size across pets with different frame
	 *  sizes (Doraemon imports are 192×208 vs builtin 96×104). */
	contentH: number;
}[] = [
	{
		id: "boxcat",
		displayName: "Boxcat",
		description: "A tiny cat tucked inside a cardboard box for cozy coding sessions.",
		spritesheetPath: "./pets/boxcat.webp",
		width: 768,
		height: 936,
		contentH: 92,
	},
	{
		id: "capy",
		displayName: "Capy",
		description: "An original emotionally stable capybara with a tiny orange on its head.",
		spritesheetPath: "./pets/capy.webp",
		width: 768,
		height: 936,
		contentH: 102,
	},
	{
		id: "elaina",
		displayName: "Elaina",
		description:
			"A cute pixel-art Codex pet inspired by Elaina, the tiny traveling witch with a bright hat and gentle broom-side charm.",
		spritesheetPath: "./pets/elaina-2.webp",
		width: 768,
		height: 936,
		contentH: 101,
	},
	{
		id: "gugugaga",
		displayName: "咕咕嘎嘎",
		description: "A cheerful chibi girl in a black penguin suit with a simple silver collar pendant.",
		spritesheetPath: "./pets/gugugaga.webp",
		width: 768,
		height: 936,
		contentH: 101,
	},
	{
		id: "hachiware",
		displayName: "Hachiware",
		description:
			"A tiny Hachiware-inspired desktop pet with white and blue cat markings, bright eyes, and cheerful expressions.",
		spritesheetPath: "./pets/hachiware.webp",
		width: 768,
		height: 936,
		contentH: 101,
	},
	{
		id: "ikun",
		displayName: "IKUN",
		description: "A hoodie chick with hot path stage energy.",
		spritesheetPath: "./pets/ikun.webp",
		width: 768,
		height: 936,
		contentH: 94,
	},
	{
		id: "jiyi",
		displayName: "吉伊",
		description:
			"A round white chibi bear with dark chocolate outlines, pink cheeks, tiny limbs, curled ears, and a small pink bear pouch.",
		spritesheetPath: "./pets/jiyi.webp",
		width: 768,
		height: 936,
		contentH: 100,
	},
	{
		id: "panda-pix",
		displayName: "Panda",
		description: "Codux bundled pet atlas.",
		spritesheetPath: "./pets/panda-pix.webp",
		width: 768,
		height: 936,
		// The only preset whose rows are fully drawn (8/8 everywhere) —
		// others follow PETDEX_ROW_FRAMES_DEFAULT (6-frame calm rows).
		rows: [8, 8, 8, 8, 8, 8, 8, 8, 8],
		contentH: 104,
	},
	{
		id: "usagi",
		displayName: "Usagi",
		description: "A tiny cream rabbit companion based on the provided Usagi reference.",
		spritesheetPath: "./pets/usagi.webp",
		width: 768,
		height: 936,
		contentH: 102,
	},
];

/** Petdex spritesheet frame grid (petdex.dev / Codux pet atlas convention). */
export const PETDEX_COLUMNS = 8;
export const PETDEX_ROWS = 9;

/** Spritesheet row per mood — same mapping BitFun/OpenPets use
 *  (rest=0, hover=1, dragging=2, error=5, waiting=6, working=7, analyzing=8). */
export const PETDEX_MOOD_ROW: Record<PetdexMood, number> = {
	rest: 0,
	hover: 1,
	dragging: 2,
	working: 7,
	waiting: 6,
	analyzing: 8,
	error: 5,
};

/** Per-mood animation timings (BitFun parity): the frame cycle runs at a
 *  mood-dependent speed, paired with one transform animation (breathe /
 *  work bob / hover lift / drag wiggle). Keyed by mood, used by PetdexSprite. */
export const PETDEX_MOOD_ANIM: Record<PetdexMood, { cycleMs: number; transform: string; transformMs: number }> = {
	rest: { cycleMs: 2400, transform: "breathe", transformMs: 6400 },
	hover: { cycleMs: 1440, transform: "hover", transformMs: 1900 },
	dragging: { cycleMs: 960, transform: "dragging", transformMs: 480 },
	working: { cycleMs: 1160, transform: "work", transformMs: 560 },
	waiting: { cycleMs: 1800, transform: "breathe", transformMs: 6000 },
	analyzing: { cycleMs: 1600, transform: "breathe", transformMs: 5200 },
	error: { cycleMs: 1800, transform: "breathe", transformMs: 6000 },
};

/** Valid (non-blank) frames per spritesheet row. BitFun sheets draw calm
 *  rows (rest/waiting/working/analyzing) with 6 frames + 2 transparent
 *  padding columns, hover/dragging/error with all 8. Cycling the padding
 *  renders an EMPTY frame once per loop — the desktop pet visibly blanks
 *  every cycle (the "flicker"); the frame cycle must stop at the last
 *  valid column. Rows 3/4 map to no mood (kept 8 as a safe default). */
export const PETDEX_ROW_FRAMES_DEFAULT: readonly number[] = [6, 8, 8, 8, 8, 8, 6, 6, 6];

/** Imported Petdex package (from a petdex.dev zip). */
export interface PetdexPackage {
	id: string;
	displayName: string;
	/** Data URL of the spritesheet (kept in localStorage — small webps fit). */
	spritesheet: string;
	/** Natural spritesheet pixel size, resolved at import time. */
	width: number;
	height: number;
	/** Valid (non-blank) frames per row, scanned at import — the frame
	 *  cycle must not step into transparent padding columns. Absent for
	 *  packages stored before the scan existed → PETDEX_ROW_FRAMES_DEFAULT. */
	rows?: readonly number[];
	/** Rest-row (row 0) opaque content height, scanned at import — the
	 *  renderer normalizes every pet to PET_CONTENT_TARGET_H so imported
	 *  sheets with larger frames (192×208 vs builtin 96×104) render the
	 *  same visual size. Absent for old packages → no normalization. */
	contentH?: number;
	/** pet.json description, when the package carries one. */
	description?: string;
	importedAt: number;
}

export function petEnabled(): boolean {
	try {
		return localStorage.getItem("omp-gui-pet") !== "0";
	} catch {
		return true;
	}
}

export function petMode(): PetDisplayMode {
	try {
		return localStorage.getItem("omp-gui-pet-mode") === "desktop" ? "desktop" : "input";
	} catch {
		return "input";
	}
}

/** Default active pet — the chiikawa-style Usagi (BitFun vendored). */
export const DEFAULT_PET_ID = "usagi";

export function petId(): string {
	try {
		return localStorage.getItem("omp-gui-pet-id") ?? DEFAULT_PET_ID;
	} catch {
		return DEFAULT_PET_ID;
	}
}

export function setPetId(id: string): void {
	try {
		localStorage.setItem("omp-gui-pet-id", id);
	} catch {
		// storage unavailable
	}
}

export function loadPetdex(): PetdexPackage[] {
	try {
		const raw = localStorage.getItem("omp-gui-petdex");
		if (!raw) return [];
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed)
			? parsed.filter(
					(p): p is PetdexPackage =>
						typeof p === "object" &&
						p !== null &&
						typeof (p as PetdexPackage).id === "string" &&
						typeof (p as PetdexPackage).spritesheet === "string",
				)
			: [];
	} catch {
		return [];
	}
}

export function savePetdex(pets: PetdexPackage[]): void {
	try {
		localStorage.setItem("omp-gui-petdex", JSON.stringify(pets));
	} catch {
		// storage quota exceeded — the import UI surfaces this
	}
}

/** Resolve any pet id to a renderable descriptor (preset grid previews,
 *  unknown ids → the note-bot SVG fallback). */
export function petForId(id: string): { kind: "builtin"; id: string } | { kind: "petdex"; pkg: PetdexPackage } {
	const pkg = loadPetdex().find(p => p.id === id);
	if (pkg) return { kind: "petdex", pkg };
	const builtin = BUILTIN_PETDEX.find(p => p.id === id);
	if (builtin) {
		return {
			kind: "petdex",
			pkg: {
				id: builtin.id,
				displayName: builtin.displayName,
				spritesheet: builtin.spritesheetPath,
				width: builtin.width,
				height: builtin.height,
				rows: builtin.rows ?? PETDEX_ROW_FRAMES_DEFAULT,
				contentH: builtin.contentH,
				importedAt: 0,
			},
		};
	}
	return { kind: "builtin", id: BUILTIN_PET_ID };
}

/** Resolve the active pet: imported petdex, builtin preset, or the
 *  note-bot SVG fallback. */
export function activePet(): { kind: "builtin"; id: string } | { kind: "petdex"; pkg: PetdexPackage } {
	return petForId(petId());
}

/** Map a session snapshot to the pet mood (ChatView passes these down). */
export function moodFromState(opts: { working: boolean; streaming: boolean; hasApprovals: boolean }): PetMood {
	if (opts.hasApprovals) return "waiting";
	if (opts.working) return opts.streaming ? "working" : "analyzing";
	return "rest";
}

/** Normalized pet body height (px) at scale 1 — every pet renders its
 *  rest-row content at this height regardless of the sheet's frame size,
 *  so imported pets (192×208 frames) match the builtins (96×104). */
export const PET_CONTENT_TARGET_H = 100;

/** User-facing pet size slider range (percent) + storage key. */
export const PET_SCALE_KEY = "omp-gui-pet-scale";
export const PET_SCALE_MIN = 60;
export const PET_SCALE_MAX = 150;

/** Pet size multiplier from the settings slider (60–150%, default 100). */
export function petScale(): number {
	const raw = Number(localStorage.getItem(PET_SCALE_KEY));
	if (!Number.isFinite(raw) || raw <= 0) return 1;
	return Math.min(PET_SCALE_MAX, Math.max(PET_SCALE_MIN, raw)) / 100;
}

export function setPetScale(pct: number): void {
	localStorage.setItem(PET_SCALE_KEY, String(Math.min(PET_SCALE_MAX, Math.max(PET_SCALE_MIN, Math.round(pct)))));
}

/** One-time migration for packages stored before the contentH scan existed:
 *  decode the spritesheet, measure the rest-row content height, persist,
 *  and notify so open windows re-render. Runs on mount of any window that
 *  uses usePet (main + pet). Idempotent — skips packages that have it. */
export function migratePetdexContent(): void {
	const pets = loadPetdex();
	const stale = pets.filter(p => !p.contentH);
	if (stale.length === 0) return;
	let changed = false;
	void (async (): Promise<void> => {
		for (const p of stale) {
			try {
				const im = new Image();
				const { promise, resolve } = Promise.withResolvers<void>();
				im.onload = () => resolve();
				im.onerror = () => resolve();
				im.src = p.spritesheet;
				await promise;
				if (im.naturalWidth && im.naturalHeight) {
					const { contentH } = measurePetdex(im);
					if (contentH > 0) {
						p.contentH = contentH;
						changed = true;
					}
				}
			} catch {
				// keep the package as-is (undecodable sheet)
			}
		}
		if (changed) {
			savePetdex(pets);
			window.dispatchEvent(new CustomEvent("omp-pet-changed"));
		}
	})();
}

/** Scan a decoded spritesheet once for both the per-row valid frame counts
 *  (cells with >1% opaque pixels — sheets pad unused columns with
 *  transparent cells and the cycle must stop before them) and the rest-row
 *  (row 0) opaque content height used for size normalization. Used at
 *  import time — builtins carry known values. */
export function measurePetdex(img: HTMLImageElement): { rows: number[]; contentH: number } {
	const width = img.naturalWidth;
	const height = img.naturalHeight;
	const fw = Math.floor(width / PETDEX_COLUMNS);
	const fh = Math.floor(height / PETDEX_ROWS);
	const fallback = { rows: [...PETDEX_ROW_FRAMES_DEFAULT], contentH: fh };
	if (!fw || !fh) return fallback;
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d", { willReadFrequently: true });
	if (!ctx) return fallback;
	ctx.drawImage(img, 0, 0);
	let data: Uint8ClampedArray;
	try {
		data = ctx.getImageData(0, 0, width, height).data;
	} catch {
		return fallback;
	}
	const rows: number[] = [];
	const threshold = Math.max(1, Math.floor(fw * fh * 0.01));
	// Rest-row content bounds: row 0 across its valid columns (the row is
	//  where the pet rests — the size the eye judges first).
	let restTop = fh;
	let restBottom = 0;
	for (let r = 0; r < PETDEX_ROWS; r++) {
		let valid = 0;
		for (let c = 0; c < PETDEX_COLUMNS; c++) {
			let opaque = 0;
			let top = fh;
			let bottom = 0;
			for (let y = r * fh; y < (r + 1) * fh; y++) {
				for (let x = c * fw; x < (c + 1) * fw; x++) {
					if (data[(y * width + x) * 4 + 3] > 0) {
						opaque++;
						if (y - r * fh < top) top = y - r * fh;
						if (y - r * fh > bottom) bottom = y - r * fh;
					}
				}
			}
			if (opaque >= threshold) {
				valid++;
				if (r === 0) {
					if (top < restTop) restTop = top;
					if (bottom > restBottom) restBottom = bottom;
				}
			}
		}
		rows.push(valid);
	}
	const contentH = restBottom > restTop ? restBottom - restTop + 1 : fh;
	return { rows, contentH };
}
