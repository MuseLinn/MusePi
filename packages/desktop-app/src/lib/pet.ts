/**
 * Agent companion (伙伴) prefs + descriptors — BitFun "Agent 伙伴" parity.
 *
 * Three settings (all renderer-local, localStorage — same pattern as the
 * sound/motion prefs):
 *   - musepi-gui-pet        "0" | "1"            master switch (default on)
 *   - musepi-gui-pet-mode   "input" | "desktop"  where the pet lives
 *   - musepi-gui-pet-id     pet id (builtin or imported petdex id)
 *   - musepi-gui-petdex     JSON list of imported petdex packages
 *
 * A pet is drawn in one of two modes: `vector` (the builtin SVG companion
 * drawn in PetSprite.tsx, or a single-frame SVG package) or `sprite` (a
 * Petdex package — 8×9 frame grid or named-state atlas). The mode is derived
 * from the resolved descriptor, never stored as its own pref: the selected
 * id already implies it.
 */

import type { OrbState } from "../vendor/thinking-orbs";

export type PetMood = "rest" | "working" | "waiting" | "analyzing" | "error";
/** Petdex-only moods — spritesheet rows 1/2 (hover/dragging) that the
 *  floating desktop pet switches to while the pointer is over it or while
 * it is being dragged. The builtin SVG has no such rows. */
export type PetdexMood = PetMood | "hover" | "dragging";

/**
 * The 31-state session vocabulary — the axis the BUILTIN pet renders.
 *
 * Why a second axis, and why this big (2026-09-20): seven moods cannot say
 * anything a session actually does. `working` covered "running a tool",
 * "streaming an answer", "uploading a file" and "thinking" as one face, so
 * the pet looked identical through four completely different waits. Blob
 * Studio's AGENT MORPHS runs 40 states and OpenMausBot's `MascotState` runs
 * 41 — both converged on that granularity because a session's *texture* is
 * what makes a companion feel like it is paying attention.
 *
 * The six groups:
 *   A core         the turn loop (idle → listening → thinking → working →
 *                  searching → writing)
 *   B transfer     bytes on the wire (sending / receiving / uploading /
 *                  loading) — the states that read as "it is connected"
 *   C progress     open-ended waits with no end in sight (progress / orbit /
 *                  radar / thinking-dots / humming)
 *   D notify/input something needs the user (notifying / alerting / dictating)
 *   E emotion      RESULT-shaped, never ambient — see below
 *   F lifecycle    window/body states (spawning / powering-down / bouncing /
 *                  dragging / drowsy)
 *
 * ── The emotions are deliberately last ────────────────────────────────────
 * OpenMausBot resolves emotion from a bot's ROLE (its `roleFaces` persona:
 * code→WORKING, research→SEARCHING, design→PLAYFUL), i.e. as an identity
 * that shows only when the bot is otherwise idle. We have ONE agent with no
 * persona slot — role-matching would be a permanent, arbitrary face. So our
 * emotions are wired the other way round: they fire on a RESULT (a turn
 * completed, a search came back rich) and decay back to `idle`. Emotion as
 * reaction, not as personality — that is the version a single-agent session
 * can actually justify.
 *
 * `PetMood` is NOT replaced: the petdex spritesheets have exactly 7 rows and
 * the CSS material classes are keyed on them. {@link STATE_MOOD} collapses
 * any state onto that legacy axis, so every sheet host keeps working.
 */
export const PET_STATES = [
	// A — the turn loop
	"idle",
	"listening",
	"thinking",
	"working",
	"searching",
	"writing",
	// B — transfer
	"sending",
	"receiving",
	"uploading",
	"loading",
	// C — progress
	"progress",
	"orbit",
	"radar",
	"thinking-dots",
	"humming",
	// D — notification / input
	"notifying",
	"alerting",
	"dictating",
	// E — emotion (result-shaped)
	"excited",
	"happy",
	"celebrate",
	"confused",
	"curious",
	"proud",
	"shy",
	"playful",
	// F — lifecycle
	"spawning",
	"powering-down",
	"bouncing",
	"dragging",
	"drowsy",
] as const;
export type PetState = (typeof PET_STATES)[number];

/** Collapse a 31-state reading onto the legacy 7-mood axis (spritesheet rows
 *  and the CSS material classes). Loud states win over quiet ones: every
 *  transfer and progress state is a flavour of working/analyzing, every
 *  emotion is a flavour of rest (a spritesheet has no "proud" row to play). */
export const STATE_MOOD: Record<PetState, PetdexMood> = {
	idle: "rest",
	listening: "rest",
	thinking: "analyzing",
	working: "working",
	searching: "analyzing",
	writing: "working",
	sending: "working",
	receiving: "analyzing",
	uploading: "working",
	loading: "analyzing",
	progress: "analyzing",
	orbit: "analyzing",
	radar: "analyzing",
	"thinking-dots": "analyzing",
	humming: "rest",
	notifying: "waiting",
	alerting: "error",
	dictating: "working",
	excited: "working",
	happy: "rest",
	celebrate: "rest",
	confused: "error",
	curious: "rest",
	proud: "rest",
	shy: "rest",
	playful: "rest",
	spawning: "rest",
	"powering-down": "rest",
	bouncing: "rest",
	dragging: "dragging",
	drowsy: "rest",
};

/** Legacy-mood lookup with a `rest` fallback — for callers holding a string
 *  that may be either axis (activity payloads, old persisted values). */
export function moodOfState(state: string | null | undefined): PetdexMood {
	return (state && STATE_MOOD[state as PetState]) || "rest";
}
/** Re-exported so callers wire reactions without reaching into pet-face
 *  (the data lives there; this barrel is what components import). */
export type { PetInteraction } from "./pet-face";
export { INTERACTION_HOLD_MS, PET_INTERACTIONS, randomPetInteraction } from "./pet-face";
export type PetDisplayMode = "input" | "desktop";

/** How the companion is drawn. Derived from the selection's shape — see
 *  {@link modeForPackage} and {@link petForId}; never a stored pref. */
export type PetMode = "vector" | "sprite";

/**
 * Authoritative session card pushed from the main window — one entry per
 * session that deserves a bubble: working sessions (live status line) and
 * unread finished ones (completion/error, the ✓/❗ acknowledge target).
 * The bubbles window renders THESE instead of synthesizing completion
 * bubbles from per-event `bubble` pushes, so background sessions (whose
 * events never reach the main window's stream) notify exactly like the
 * active one.
 */
export interface PetSessionCard {
	sessionId: string;
	/** Stable revision of the activity represented by this card. Dismissal
	 *  and notification memory reset when a new turn changes this value. */
	activityKey?: string;
	/** Session title (tree label fallback) — the card's bold first row. */
	title: string;
	/** working → hover shows 回复/停止; done/error → ✓ (常驻, unread) / ❗. */
	phase: "working" | "done" | "error";
	/** Second row: live status for working (正在使用 X…), 已完成/出错了. */
	statusText: string;
	/** Latest assistant text preview for finished sessions (may be absent
	 *  for background sessions the main window never streamed). */
	replyPreview?: string | null;
}

/**
 * Activity payload pushed from the main window to the floating pet:
 * mood (sprite state), bubble (notification blurb), state (live task
 * summary for the panel), approval (pending tool approval to answer),
 * scale (size slider). Each field is optional — pushes are partial.
 */
export interface PetActivity {
	/** Authoritative session cards (working + unread finished) — the
	 *  bubbles window renders these as the session-scoped stack, replacing
	 *  per-event session bubbles. Pushed with state/recent pushes. */
	sessions?: PetSessionCard[];
	mood?: PetMood;
	/** The 31-state reading (see PET_STATES). Pushed alongside `mood`: the
	 *  mood still picks the spritesheet row, the state drives the builtin's
	 *  face / motion / effects. Optional, so a pet window on an older build
	 *  (or a partial push) keeps working off `mood` alone.
	 *
	 *  `petState`, not `state`: `state` is already the session's live task
	 *  summary (working / toolName / lastMessage…) and overloading one field
	 *  with two shapes is how an IPC payload starts lying. */
	petState?: PetState;
	bubble?: {
		kind: "completed" | "error" | "question" | "subtask";
		text: string;
		requestId?: string;
		/** Session the notification belongs to — lets the bubble
		 *  click open that session directly (and mark it read). */
		sessionId?: string;
	} | null;
	/** Sessions that became read in the main window (opened) — the bubble
	 *  window dismisses their completion/error bubbles (read-闭环). */
	dismissSessions?: string[];
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
	/** Bubbles-window collapse state, mirrored by the main process. The
	 *  pet window's one control advances expanded → stacked → count →
	 *  stacked. It shows the item count only in count mode and never marks
	 *  sessions read; that action lives in the expanded list. */
	bubbles?: { mode: "expanded" | "stacked" | "hidden"; count: number };
	scale?: number;
	/** Main-window locale (the pet window cannot read its localStorage —
	 *  carried so the panel strings match the main UI language). */
	locale?: string;
	/** Resolved light/dark scheme of the main window. Pushed on change
	 *  (the pet window mirrors it as data-theme — see pet-main.tsx);
	 *  cross-window storage events don't fire reliably under file://. */
	theme?: "light" | "dark";
	/** Resolved --accent color (CSS value, e.g. oklch) of the main window —
	 *  the pet window re-derives its themed shell/ring palette from it
	 *  (pet-palette.ts). Pushed alongside `theme`. */
	accent?: string;
	/** Active pet descriptor (builtin id or a full petdex package — the
	 *  petdex registry lives in the main window's localStorage, which the
	 *  pet window cannot read under file://). Pushed on change and whenever
	 *  the pet window re-requests state, so imported theme packages render
	 *  in the floating pet too. Carries the derived `mode`, so the pet window
	 *  does not re-resolve the package shape. */
	pet?: PetDescriptor;
}

export const PET_MOODS: readonly PetMood[] = ["rest", "working", "waiting", "analyzing", "error"];

export const PET_DISPLAY_MODES: readonly PetDisplayMode[] = ["input", "desktop"];

export const BUILTIN_PET_ID = "musepi";

/** Builtin vector note-bot id (PetSprite's hand-drawn SVG mascot). The
 *  "musepi" id belongs to the AI-generated spritesheet preset below, so the
 *  vector companion carries its own id to stay selectable. */
export const BUILTIN_SVG_ID = "musepi-note-bot";

/** Builtin spritesheet presets — the MusePi sheet (AI-designed smooth art,
 * 2026-09-16) first, then sheets vendored from BitFun (MIT, Copyright 2026
 * CWing) public/agent-companion-pets, downscaled to 768×936 (8×9 grid,
 * 96×104 frames). Ids/descriptions match the upstream pet.json metadata;
 * loaded by relative path from dist/pets/. `smooth` opts a sheet out of the
 * pixel-art `image-rendering: pixelated` treatment (musepi.webp is smooth
 * vector-style art and must downscale bilinearly).
 *
 * The default companion is NOT in this list — it is the hand-drawn sphere
 * ({@link BUILTIN_SVG_ID}, drawn by PetSprite's builtin branch), which has
 * no spritesheet.
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
	/** Render with smooth (bilinear) downscaling instead of pixelated. */
	smooth?: boolean;
}[] = [
	{
		id: "musepi",
		displayName: "MusePi",
		description: "builtin pet description",
		spritesheetPath: "./pets/musepi.webp",
		width: 2048,
		height: 2304,
		// rest 6 (breathe ping-pong + blink), hover/dragging/error/waiting/
		// working/analyzing 4 (ping-pong); rows 3/4 map to no mood.
		rows: [6, 4, 4, 0, 0, 4, 4, 4, 4],
		contentH: 201,
		smooth: true,
	},
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
		id: "jiyi",
		displayName: "Jiyi",
		description:
			"A round white chibi bear with dark chocolate outlines, pink cheeks, tiny limbs, curled ears, and a small pink bear pouch.",
		spritesheetPath: "./pets/jiyi.webp",
		width: 768,
		height: 936,
		contentH: 100,
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
		id: "usagi",
		displayName: "Usagi",
		description: "A tiny cream rabbit companion based on the provided Usagi reference.",
		spritesheetPath: "./pets/usagi.webp",
		width: 768,
		height: 936,
		contentH: 102,
	},
	{
		id: "han-li-yujian-feixing",
		displayName: "Han Li",
		description: "A calm, cautious Q-version of Han Li in a dark-cyan Daoist robe, quietly riding his sword.",
		spritesheetPath: "./pets/han-li-yujian-feixing.webp",
		width: 1536,
		height: 1872,
		// Imported package scan (192×208 frames); rows 3/4 map to no mood.
		rows: [6, 8, 8, 4, 5, 8, 6, 6, 6],
		contentH: 199,
	},
	{
		id: "doraemon",
		displayName: "Doraemon",
		description: "A compact blue robot-cat pet inspired by Doraemon.",
		spritesheetPath: "./pets/doraemon.webp",
		width: 1536,
		height: 1872,
		// Imported package scan (192×208 frames); rows 3/4 map to no mood.
		rows: [6, 8, 8, 4, 5, 8, 6, 6, 6],
		contentH: 199,
	},
	{
		id: "noir-webling",
		displayName: "Noir Webling",
		description: "A tiny monochrome spider detective in a fedora and trench coat.",
		spritesheetPath: "./pets/noir-webling.webp",
		width: 1536,
		height: 1872,
		// Imported package scan (192×208 frames); rows 3/4 map to no mood.
		rows: [6, 8, 8, 4, 5, 8, 6, 6, 6],
		contentH: 199,
	},
	{
		id: "feixue",
		displayName: "Feixue",
		description: "A white-haired, red-eyed character from Wuthering Waves, made into a pixel desktop pet.",
		spritesheetPath: "./pets/feixue.webp",
		width: 1536,
		height: 1872,
		// Imported package scan (192×208 frames); rows 3/4 map to no mood.
		rows: [6, 8, 8, 4, 5, 8, 6, 6, 6],
		contentH: 199,
	},
];

/** Petdex spritesheet frame grid (petdex.dev / Codux pet atlas convention). */
export const PETDEX_COLUMNS = 8;
const PETDEX_ROWS = 9;

/** Spritesheet row per mood — same mapping BitFun/OpenPets use
 *  (rest=0, hover=1, dragging=2, error=5, waiting=6, working=7, analyzing=8). */
const PETDEX_MOOD_ROW: Record<PetdexMood, number> = {
	rest: 0,
	hover: 1,
	dragging: 2,
	working: 7,
	waiting: 6,
	analyzing: 8,
	error: 5,
};

/** Per-mood animation timings: the frame cycle runs at a
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
const PETDEX_ROW_FRAMES_DEFAULT: readonly number[] = [6, 8, 8, 8, 8, 8, 6, 6, 6];

export interface PetAtlasGeometry {
	frameWidth: number;
	frameHeight: number;
	rows: number;
	columns: number;
}

export interface PetAtlasState {
	row: number;
	frames: number;
	fps: number;
	loop?: boolean;
}

export interface PetBubbleTheme {
	background: string;
	foreground: string;
	border: string;
}

/** Imported Petdex, explicit-state atlas, or a user-dropped single SVG. */
export interface PetdexPackage {
	id: string;
	displayName: string;
	/** Data URL of the spritesheet (kept in localStorage — small webps fit). */
	spritesheet: string;
	/** Natural spritesheet pixel size, resolved at import time. */
	width: number;
	height: number;
	/** `sheet` (default) is the 8×9 Petdex grid. `atlas` uses the manifest's
	 *  geometry and named states. `svg` is one static vector frame. */
	format?: "sheet" | "atlas" | "svg";
	/** Valid (non-blank) frames per legacy Petdex row, scanned at import. */
	rows?: readonly number[];
	atlas?: PetAtlasGeometry;
	states?: Readonly<Record<string, PetAtlasState>>;
	theme?: { bubble?: Partial<PetBubbleTheme> };
	/** Rest-row (row 0) opaque content height, scanned at import — the
	 *  renderer normalizes every pet to PET_CONTENT_TARGET_H so imported
	 *  sheets with larger frames (192×208 vs builtin 96×104) render the
	 *  same visual size. Absent for old packages → no normalization. */
	contentH?: number;
	/** pet.json description, when the package carries one. */
	description?: string;
	/** Smooth (bilinear) rendering instead of pixel-art pixelated. */
	smooth?: boolean;
	importedAt: number;
}

/** A resolved companion: its drawing mode plus the payload that mode draws.
 *  `vector` is the builtin sphere or a single-frame SVG package; `sprite` is
 *  always a frame grid. Callers dispatch on `mode` — `format` stays package
 *  metadata and is not an alternative dispatch key. */
export type PetDescriptor =
	| { mode: "vector"; kind: "builtin"; id: string }
	| { mode: "vector"; kind: "petdex"; pkg: PetdexPackage }
	| { mode: "sprite"; kind: "petdex"; pkg: PetdexPackage };

/** The mode a package's shape implies. Single-frame SVG packages are vector
 *  art; every frame format (`sheet` default and `atlas`) plays rows. */
export function modeForPackage(pkg: Pick<PetdexPackage, "format">): PetMode {
	return pkg.format === "svg" ? "vector" : "sprite";
}

/** A renderable descriptor from a `petActivity` push.
 *
 *  The union above is a compile-time contract, but a push crosses a window
 *  boundary where nothing enforces it: an older or partial payload arrives as
 *  `{ kind, id }` or as a package without its derived `mode`. `PetSprite`
 *  dispatches on `mode` alone and its packaged branch dereferences `pkg`, so
 *  one such push blanks the pet window (React drops the tree on the render
 *  error). Rebuild `mode` from the payload's own shape; null means the push
 *  cannot describe art and the receiver keeps its local reading. */
export function descriptorFromPush(value: unknown): PetDescriptor | null {
	if (typeof value !== "object" || value === null) return null;
	const wire = value as { kind?: unknown; id?: unknown; pkg?: Partial<PetdexPackage> | null };
	if (wire.kind === "builtin" && typeof wire.id === "string") {
		return { mode: "vector", kind: "builtin", id: wire.id };
	}
	const pkg = wire.pkg;
	if (
		wire.kind === "petdex" &&
		typeof pkg === "object" &&
		pkg !== null &&
		typeof pkg.id === "string" &&
		typeof pkg.spritesheet === "string" &&
		typeof pkg.width === "number" &&
		typeof pkg.height === "number"
	) {
		return { mode: modeForPackage(pkg), kind: "petdex", pkg: pkg as PetdexPackage };
	}
	return null;
}

export interface PetAnimationDescriptor {
	frameW: number;
	frameH: number;
	columns: number;
	rowCount: number;
	row: number;
	valid: number;
	cycleMs: number;
	loop: boolean;
}

export type PetAnimationSource = Pick<PetdexPackage, "width" | "height" | "format" | "rows" | "atlas" | "states">;

const ATLAS_STANDARD_STATES = new Set([
	"idle",
	"running_left",
	"running_right",
	"working",
	"waiting",
	"failed",
	"idle_random_1",
	"idle_random_2",
]);

/** Convert either sheet contract into the renderer's single animation shape.
 *  An explicit atlas never falls through to the legacy nine-row scanner. */
export function resolvePetAnimation(
	source: PetAnimationSource,
	mood: PetdexMood,
	action?: string | null,
	direction: "left" | "right" = "left",
): PetAnimationDescriptor {
	if (source.format === "svg") {
		return {
			frameW: source.width,
			frameH: source.height,
			columns: 1,
			rowCount: 1,
			row: 0,
			valid: 1,
			cycleMs: PETDEX_MOOD_ANIM[mood].cycleMs,
			loop: true,
		};
	}
	if (source.format === "atlas" && source.atlas && source.states) {
		const { atlas, states } = source;
		const candidates = action
			? [action, "idle"]
			: mood === "dragging"
				? [direction === "right" ? "running_right" : "running_left", "running_left", "idle"]
				: mood === "working" || mood === "analyzing"
					? ["working", "idle"]
					: mood === "waiting"
						? ["waiting", "idle"]
						: mood === "error"
							? ["failed", "idle"]
							: ["idle"];
		const name = candidates.find(candidate => states[candidate]) ?? "idle";
		const state = states[name] ?? states.idle!;
		return {
			frameW: atlas.frameWidth,
			frameH: atlas.frameHeight,
			columns: atlas.columns,
			rowCount: atlas.rows,
			row: state.row,
			valid: state.frames,
			cycleMs: (state.frames / state.fps) * 1000,
			loop: state.loop ?? true,
		};
	}
	const row = PETDEX_MOOD_ROW[mood];
	return {
		frameW: source.width / PETDEX_COLUMNS,
		frameH: source.height / PETDEX_ROWS,
		columns: PETDEX_COLUMNS,
		rowCount: PETDEX_ROWS,
		row,
		valid: Math.min(PETDEX_COLUMNS, Math.max(1, (source.rows ?? PETDEX_ROW_FRAMES_DEFAULT)[row] ?? PETDEX_COLUMNS)),
		cycleMs: PETDEX_MOOD_ANIM[mood].cycleMs,
		loop: true,
	};
}

export function petAmbientActions(pkg: PetdexPackage): string[] {
	if (pkg.format !== "atlas" || !pkg.states) return [];
	return ["idle_random_1", "idle_random_2"].filter(name => pkg.states![name]);
}

export function petCustomActions(pkg: PetdexPackage): string[] {
	if (pkg.format !== "atlas" || !pkg.states) return [];
	return Object.keys(pkg.states).filter(name => !ATLAS_STANDARD_STATES.has(name));
}

function hexLuminance(hex: string): number {
	const channels = [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
	const linear = channels.map(value => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
	return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

/** Package colors are optional. Invalid or unreadable colors leave the
 *  application's glass bubble and semantic status colors untouched. */
export function petBubbleTheme(pkg: Pick<PetdexPackage, "theme">): PetBubbleTheme | null {
	const bubble = pkg.theme?.bubble;
	if (!bubble) return null;
	const { background, foreground, border } = bubble;
	if (![background, foreground, border].every(value => typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value))) {
		return null;
	}
	const bg = hexLuminance(background!);
	const fg = hexLuminance(foreground!);
	const contrast = (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05);
	return contrast >= 4.5 ? { background: background!, foreground: foreground!, border: border! } : null;
}

export function petEnabled(): boolean {
	try {
		return localStorage.getItem("musepi-gui-pet") !== "0";
	} catch {
		return true;
	}
}

export function petMode(): PetDisplayMode {
	try {
		return localStorage.getItem("musepi-gui-pet-mode") === "desktop" ? "desktop" : "input";
	} catch {
		return "input";
	}
}

/** Default active pet — the builtin spherical brand pet (the hand-drawn
 *  vector sphere with its face and headphones). Every spritesheet preset
 *  stays selectable; an explicit stored pick always wins. */
export const DEFAULT_PET_ID = BUILTIN_SVG_ID;

/** Sprite-mode default when that mode has no remembered pick. */
export const DEFAULT_SPRITE_PET_ID = BUILTIN_PETDEX[0]!.id;

function defaultPetIdForMode(mode: PetMode): string {
	return mode === "vector" ? BUILTIN_SVG_ID : DEFAULT_SPRITE_PET_ID;
}

/** Last pick per mode. `musepi-gui-pet-id` stays the single active selection;
 *  these keys only keep the other side alive across a mode switch. A mode is
 *  never stored on its own — the id implies it. */
const PET_ID_BY_MODE_KEY: Record<PetMode, string> = {
	vector: "musepi-gui-pet-vector-id",
	sprite: "musepi-gui-pet-sprite-id",
};

export function petId(): string {
	try {
		return localStorage.getItem("musepi-gui-pet-id") ?? DEFAULT_PET_ID;
	} catch {
		return DEFAULT_PET_ID;
	}
}

export function setPetId(id: string): void {
	try {
		localStorage.setItem("musepi-gui-pet-id", id);
		localStorage.setItem(PET_ID_BY_MODE_KEY[petForId(id).mode], id);
	} catch {
		// storage unavailable
	}
}

/** Mode an id resolves to, or null when the id no longer names anything (a
 *  stale pick left behind by a deleted package). */
function modeOfKnownId(id: string): PetMode | null {
	const pet = petForId(id);
	const known = pet.kind === "builtin" ? pet.id === id : pet.pkg.id === id;
	return known ? pet.mode : null;
}

/** Selection a mode would activate: its remembered pick, else the current
 *  pick when it already belongs there, else the mode's default. Stored ids
 *  from before modes existed resolve through the same {@link petForId}
 *  derivation, so old data needs no migration write. */
export function petIdForMode(mode: PetMode): string {
	const remembered = readStoredPetId(PET_ID_BY_MODE_KEY[mode]);
	if (remembered && modeOfKnownId(remembered) === mode) return remembered;
	const current = petId();
	if (modeOfKnownId(current) === mode) return current;
	return defaultPetIdForMode(mode);
}

/** Switch drawing mode, restoring that mode's last selection. The mode being
 *  left keeps its pick for the next switch back. */
export function setPetMode(mode: PetMode): void {
	const current = petId();
	const currentMode = modeOfKnownId(current);
	if (currentMode === mode) return;
	if (currentMode) {
		try {
			localStorage.setItem(PET_ID_BY_MODE_KEY[currentMode], current);
		} catch {
			// storage unavailable
		}
	}
	setPetId(petIdForMode(mode));
}

function readStoredPetId(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

export function loadPetdex(): PetdexPackage[] {
	try {
		const raw = localStorage.getItem("musepi-gui-petdex");
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
		localStorage.setItem("musepi-gui-petdex", JSON.stringify(pets));
	} catch {
		// storage quota exceeded — the import UI surfaces this
	}
}

/** Resolve any pet id to a renderable descriptor with its drawing mode
 *  (preset grid previews, unknown ids → the builtin sphere fallback). */
export function petForId(id: string): PetDescriptor {
	// The vector sphere is rendered by PetSprite directly (no sheet).
	if (id === BUILTIN_SVG_ID) return { mode: "vector", kind: "builtin", id: BUILTIN_SVG_ID };
	const pkg = loadPetdex().find(p => p.id === id);
	if (pkg) return { mode: modeForPackage(pkg), kind: "petdex", pkg };
	const builtin = BUILTIN_PETDEX.find(p => p.id === id);
	if (builtin) {
		return {
			mode: "sprite",
			kind: "petdex",
			pkg: {
				id: builtin.id,
				displayName: builtin.displayName,
				spritesheet: builtin.spritesheetPath,
				width: builtin.width,
				height: builtin.height,
				rows: builtin.rows ?? PETDEX_ROW_FRAMES_DEFAULT,
				contentH: builtin.contentH,
				smooth: builtin.smooth,
				importedAt: 0,
			},
		};
	}
	return { mode: "vector", kind: "builtin", id: DEFAULT_PET_ID };
}

/** Resolve the active pet: imported petdex, builtin preset, or the builtin
 *  sphere fallback. */
export function activePet(): PetDescriptor {
	return petForId(petId());
}

/** Map a session snapshot to the pet mood (ChatView passes these down). */
export function moodFromState(opts: { working: boolean; streaming: boolean; hasApprovals: boolean }): PetMood {
	if (opts.hasApprovals) return "waiting";
	if (opts.working) return opts.streaming ? "working" : "analyzing";
	return "rest";
}

/**
 * Signals a session exposes for state resolution. Every field is optional and
 * the resolver is ordered, so a caller wires only what it has — the composer
 * knows about streaming, the pet window knows about unread counts, and both
 * get a coherent reading without sharing a store shape.
 */
export interface PetSessionSignals {
	/** The floating pet is being dragged (interaction beats everything). */
	dragging?: boolean;
	/** First paint / window spawn. */
	spawning?: boolean;
	/** The last tool call failed and the user has to act — glyph "!". */
	toolFailed?: boolean;
	/** The instruction was ambiguous and needs clarifying — glyph "?".
	 *  Distinct from `toolFailed` on purpose: one needs a retry decision, the
	 *  other needs a rewrite, and the pet must not signal them identically. */
	ambiguous?: boolean;
	/** The agent is running a tool (not emitting text). */
	working?: boolean;
	/** The agent is streaming text. */
	streaming?: boolean;
	/** Unread completions sitting in other sessions. */
	unread?: number;
	/** Pending tool approvals — the agent is blocked on the user. */
	approvals?: number;
	/** The agent asked a question / offered options and is waiting. */
	awaitingInput?: boolean;
	/** A request is on the wire, no response yet. */
	sending?: boolean;
	/** A response is landing, first token not arrived yet. */
	receiving?: boolean;
	/** Milliseconds since the last activity — drives `drowsy`. */
	idleMs?: number;
	/** A turn just finished successfully — drives the result emotions. */
	justFinished?: boolean;
}

/** How long the session must be quiet before the pet starts dozing off. */
export const DROWSY_AFTER_MS = 90_000;

/**
 * Resolve session signals to ONE state — a strict priority chain, highest
 * first. The order is the design: a failure outranks everything (an agent
 * blocked on an error is not "working"), live work outranks notifications
 * (what is happening now beats what happened elsewhere), and the emotions sit
 * second-to-last because they are gated on an actual result — never on
 * nothing happening (see PET_STATES).
 */
export function stateFromSignals(s: PetSessionSignals = {}): PetState {
	if (s.dragging) return "dragging";
	if (s.spawning) return "spawning";
	if (s.toolFailed) return "alerting";
	if (s.ambiguous) return "confused";
	if (s.working) return s.streaming ? "writing" : "working";
	// A pending approval is the loudest "you are needed" there is — the agent
	// is not working, it is WAITING, and the badge is the whole message.
	if ((s.approvals ?? 0) > 0 || (s.unread ?? 0) > 0) return "notifying";
	if (s.awaitingInput) return "curious";
	if (s.sending) return "sending";
	if (s.receiving) return "receiving";
	if ((s.idleMs ?? 0) >= DROWSY_AFTER_MS) return "drowsy";
	if (s.justFinished) return "celebrate";
	return "idle";
}

/** Map a session snapshot to the thinking-orb state — the single source the
 *  header and the chat view derive the agent avatar's animation from (the
 *  two previously duplicated the ternary and missed the approvals state,
 *  so the avatar spun on while the agent was actually blocked on a tool
 *  approval). Pending approvals pin the `waiting` state (the "paused for
 *  you" wave). */
export function orbFromSession(
	snap: { working?: boolean; streaming?: boolean; approvals?: readonly unknown[] } | null | undefined,
): OrbState {
	return orbFromFlags({
		working: snap?.working === true,
		streaming: snap?.streaming === true,
		hasApprovals: (snap?.approvals?.length ?? 0) > 0,
	});
}

/** The same mapping from the three facts alone.
 *
 *  Exists so a surface that subscribes to a NARROW slice of the session (the
 *  header reads only these flags, not the transcript) can derive the orb
 *  without holding the whole snapshot — passing a fabricated array just to
 *  reach the length check would be worse. */
function orbFromFlags(signal: { working: boolean; streaming: boolean; hasApprovals: boolean }): OrbState {
	if (signal.hasApprovals) return "waiting";
	if (signal.working) return signal.streaming ? "composing" : "working";
	return "listening";
}

/** Normalized pet body height (px) at scale 1 — every pet renders its
 *  rest-row content at this height regardless of the sheet's frame size,
 *  so imported pets (192×208 frames) match the builtins (96×104). */
export const PET_CONTENT_TARGET_H = 100;

/** User-facing pet size slider range (percent) + storage key. */
export const PET_SCALE_KEY = "musepi-gui-pet-scale";
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
					const contentH =
						p.format === "svg"
							? im.naturalHeight
							: p.format === "atlas" && p.atlas
								? measurePetAtlas(im, p.atlas).contentH
								: measurePetdex(im).contentH;
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

/** Scan a decoded grid for legacy valid-frame counts and the rest-row
 *  content height shared by both import formats. */
function measureGrid(
	img: HTMLImageElement,
	columns: number,
	rowCount: number,
	fallbackRows: readonly number[],
): { rows: number[]; contentH: number } {
	const width = img.naturalWidth;
	const height = img.naturalHeight;
	const fw = Math.floor(width / columns);
	const fh = Math.floor(height / rowCount);
	const fallback = { rows: [...fallbackRows], contentH: fh };
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
	// Thin partial frames count as content; near-empty noise cells do not.
	const threshold = Math.max(1, Math.floor(fw * fh * 0.0025));
	let restTop = fh;
	let restBottom = 0;
	for (let r = 0; r < rowCount; r++) {
		let valid = 0;
		for (let c = 0; c < columns; c++) {
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

/** Legacy Petdex packages derive frame counts from alpha. */
export function measurePetdex(img: HTMLImageElement): { rows: number[]; contentH: number } {
	return measureGrid(img, PETDEX_COLUMNS, PETDEX_ROWS, PETDEX_ROW_FRAMES_DEFAULT);
}

/** Atlas packages use declared frames; only visual-size normalization needs
 *  an alpha measurement. */
export function measurePetAtlas(img: HTMLImageElement, atlas: PetAtlasGeometry): { contentH: number } {
	const { contentH } = measureGrid(img, atlas.columns, atlas.rows, []);
	return { contentH };
}
