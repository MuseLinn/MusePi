/**
 * Agent companion (伙伴) preferences and descriptors.
 *
 * Three settings (all renderer-local, localStorage — same pattern as the
 * sound/motion prefs):
 *   - musepi-gui-pet        "0" | "1"            master switch (default on)
 *   - musepi-gui-pet-mode   "input" | "desktop"  where the pet lives
 *   - musepi-gui-pet-id     pet id (builtin or imported petdex id)
 *   - musepi-gui-petdex     JSON list of imported petdex packages
 *
 * A pet is drawn in one of two modes: `vector` (the builtin SVG companion
 * drawn in CompanionArt.tsx, or a single-frame SVG package) or `sprite` (a
 * Petdex package — 8×9 frame grid or named-state atlas). The mode is derived
 * from the resolved descriptor, never stored as its own pref: the selected
 * id already implies it.
 */

import type { SessionPresence } from "@musepi/pi-wire";
import type { OrbState } from "../vendor/thinking-orbs";
import { type AgentSignals, activityVerbForTool, DROWSY_AFTER_MS } from "./agent-signals";

export { type AgentSignals, DROWSY_AFTER_MS } from "./agent-signals";

export type CompanionMood = "rest" | "working" | "waiting" | "analyzing" | "error";
/** Petdex-only moods — spritesheet rows 1/2 (hover/dragging) that the
 *  floating desktop pet switches to while the pointer is over it or while
 * it is being dragged. The builtin SVG has no such rows. */
export type SpriteMood = CompanionMood | "hover" | "dragging";

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
 * `CompanionMood` is NOT replaced: the petdex spritesheets have exactly 7 rows and
 * the CSS material classes are keyed on them. {@link COMPANION_STATE_TO_SPRITE_MOOD} collapses
 * any state onto that legacy axis, so every sheet host keeps working.
 */
export const COMPANION_STATES = [
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
export type CompanionState = (typeof COMPANION_STATES)[number];

/** Collapse a 31-state reading onto the legacy 7-mood axis (spritesheet rows
 *  and the CSS material classes). Loud states win over quiet ones: every
 *  transfer and progress state is a flavour of working/analyzing, every
 *  emotion is a flavour of rest (a spritesheet has no "proud" row to play). */
export const COMPANION_STATE_TO_SPRITE_MOOD: Record<CompanionState, SpriteMood> = {
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
export function spriteMoodOfState(state: string | null | undefined): SpriteMood {
	return (state && COMPANION_STATE_TO_SPRITE_MOOD[state as CompanionState]) || "rest";
}
/** Re-exported so callers wire reactions without reaching into pet-face
 *  (the data lives there; this barrel is what components import). */
export type { CompanionInteraction } from "./companion-face";
export { COMPANION_INTERACTIONS, INTERACTION_HOLD_MS, randomCompanionInteraction } from "./companion-face";
export type CompanionPlacement = "input" | "desktop";

/** How the companion is drawn. Derived from the selection's shape — see
 *  {@link artFormatForPackage} and {@link companionArtForId}; never a stored pref. */
export type CompanionArtFormat = "vector" | "sprite";

/**
 * Authoritative session card pushed from the main window — one entry per
 * session that deserves a bubble: working sessions (live status line) and
 * unread finished ones (completion/error, the ✓/❗ acknowledge target).
 * The bubbles window renders THESE instead of synthesizing completion
 * bubbles from per-event `bubble` pushes, so background sessions (whose
 * events never reach the main window's stream) notify exactly like the
 * active one.
 */
export interface CompanionSessionCard {
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
	/** Per-session mood, used by the desktop pet's aggregate reading. The
	 *  active session uses its full AgentSignals; background sessions only
	 *  have the session.list facts, so they degrade to working/rest/error. */
	mood?: CompanionMood;
	/** Per-session built-in companion state. Optional for the same reason:
	 *  background sessions do not stream their tool/streaming detail. */
	companionState?: CompanionState;
	/** Why this session wants the user, when it does. */
	attention?: "approval" | "question";
}

const COMPANION_MOOD_PRIORITY: Record<CompanionMood, number> = {
	waiting: 4,
	analyzing: 3,
	working: 2,
	error: 1,
	rest: 0,
};

// Mirrors COMPANION_MOOD_PRIORITY so the rich state and the sprite mood never
// tell different stories: waiting > analyzing > working > error > rest.
const COMPANION_STATE_PRIORITY: readonly CompanionState[] = [
	"notifying",
	"thinking",
	"searching",
	"writing",
	"working",
	"alerting",
	"confused",
	"curious",
	"celebrate",
	"idle",
];

/** Collapse a rich companion state onto the legacy mood axis used by the
 *  floating pet's sprite/aggregate reading. */
export function companionMoodOfState(state: CompanionState): CompanionMood {
	const mood = COMPANION_STATE_TO_SPRITE_MOOD[state];
	return mood === "hover" || mood === "dragging" ? "working" : mood;
}

/** A session blocked on the user outranks a thinking session, which
 *  outranks ordinary work. */
export function aggregateCompanionMood(
	cards: readonly CompanionSessionCard[],
	fallback: CompanionMood = "rest",
): CompanionMood {
	let best = fallback;
	for (const card of cards) {
		if (card.mood && COMPANION_MOOD_PRIORITY[card.mood] > COMPANION_MOOD_PRIORITY[best]) best = card.mood;
	}
	return best;
}

/** Attention first, then live work, then the result/idle states. */
export function aggregateCompanionState(
	cards: readonly CompanionSessionCard[],
	fallback: CompanionState = "idle",
): CompanionState {
	const states = new Set(cards.map(card => card.companionState).filter((state): state is CompanionState => !!state));
	for (const state of COMPANION_STATE_PRIORITY) {
		if (states.has(state)) return state;
	}
	return fallback;
}

/**
 * Activity payload pushed from the main window to the floating pet:
 * mood (sprite state), bubble (notification blurb), state (live task
 * summary for the panel), approval (pending tool approval to answer),
 * scale (size slider). Each field is optional — pushes are partial.
 */
export interface CompanionActivity {
	/** Authoritative session cards (working + unread finished) — the
	 *  bubbles window renders these as the session-scoped stack, replacing
	 *  per-event session bubbles. Pushed with state/recent pushes. */
	sessions?: CompanionSessionCard[];
	mood?: CompanionMood;
	/** The 31-state reading (see COMPANION_STATES). Pushed alongside `mood`: the
	 *  mood still picks the spritesheet row, the state drives the builtin's
	 *  face / motion / effects. Optional, so a pet window on an older build
	 *  (or a partial push) keeps working off `mood` alone.
	 *
	 *  `companionState`, not `state`: `state` is already the session's live task
	 *  summary (working / toolName / lastMessage…) and overloading one field
	 *  with two shapes is how an IPC payload starts lying. */
	companionState?: CompanionState;
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
	 *  (companion-palette.ts). Pushed alongside `theme`. */
	accent?: string;
	/** Active pet descriptor (builtin id or a full petdex package — the
	 *  petdex registry lives in the main window's localStorage, which the
	 *  pet window cannot read under file://). Pushed on change and whenever
	 *  the pet window re-requests state, so imported theme packages render
	 *  in the floating pet too. Carries the derived `mode`, so the pet window
	 *  does not re-resolve the package shape. */
	pet?: CompanionArtDescriptor;
}

export const COMPANION_MOODS: readonly CompanionMood[] = ["rest", "working", "waiting", "analyzing", "error"];

export const COMPANION_PLACEMENTS: readonly CompanionPlacement[] = ["input", "desktop"];

export const BUILTIN_SPRITE_ART_ID = "musepi";

/** Builtin vector note-bot id (CompanionArt's hand-drawn SVG mascot). The
 *  "musepi" id belongs to the AI-generated spritesheet preset below, so the
 *  vector companion carries its own id to stay selectable. */
export const BUILTIN_VECTOR_ART_ID = "musepi-note-bot";

/** Builtin spritesheet presets — the MusePi sheet (AI-designed smooth art,
 * 2026-09-16) first, then sheets vendored from an MIT-licensed companion-pet
 * pack (Copyright 2026 CWing), downscaled to 768×936 (8×9 grid,
 * 96×104 frames). Ids/descriptions match the upstream pet.json metadata;
 * loaded by relative path from dist/pets/. `smooth` opts a sheet out of the
 * pixel-art `image-rendering: pixelated` treatment (musepi.webp is smooth
 * vector-style art and must downscale bilinearly).
 *
 * The default companion is NOT in this list — it is the hand-drawn sphere
 * ({@link BUILTIN_VECTOR_ART_ID}, drawn by CompanionArt's builtin branch), which has
 * no spritesheet.
 */
export const BUILTIN_SPRITE_PRESETS: readonly {
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
export const SPRITE_COLUMNS = 8;
const PETDEX_ROWS = 9;

/** Spritesheet row per mood
 *  (rest=0, hover=1, dragging=2, error=5, waiting=6, working=7, analyzing=8). */
const SPRITE_MOOD_ROW: Record<SpriteMood, number> = {
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
 *  work bob / hover lift / drag wiggle). Keyed by mood, used by SpriteSheetArt. */
export const SPRITE_MOOD_ANIM: Record<SpriteMood, { cycleMs: number; transform: string; transformMs: number }> = {
	rest: { cycleMs: 2400, transform: "breathe", transformMs: 6400 },
	hover: { cycleMs: 1440, transform: "hover", transformMs: 1900 },
	dragging: { cycleMs: 960, transform: "dragging", transformMs: 480 },
	working: { cycleMs: 1160, transform: "work", transformMs: 560 },
	waiting: { cycleMs: 1800, transform: "breathe", transformMs: 6000 },
	analyzing: { cycleMs: 1600, transform: "breathe", transformMs: 5200 },
	error: { cycleMs: 1800, transform: "breathe", transformMs: 6000 },
};

/** Valid (non-blank) frames per spritesheet row. Vendored sheets draw calm
 *  rows (rest/waiting/working/analyzing) with 6 frames + 2 transparent
 *  padding columns, hover/dragging/error with all 8. Cycling the padding
 *  renders an EMPTY frame once per loop — the desktop pet visibly blanks
 *  every cycle (the "flicker"); the frame cycle must stop at the last
 *  valid column. Rows 3/4 map to no mood (kept 8 as a safe default). */
const SPRITE_ROW_FRAMES_DEFAULT: readonly number[] = [6, 8, 8, 8, 8, 8, 6, 6, 6];

export interface SpriteAtlasGeometry {
	frameWidth: number;
	frameHeight: number;
	rows: number;
	columns: number;
}

export interface SpriteAtlasState {
	row: number;
	frames: number;
	fps: number;
	loop?: boolean;
}

export interface SpriteBubbleTheme {
	background: string;
	foreground: string;
	border: string;
}

/** Imported Petdex, explicit-state atlas, or a user-dropped single SVG. */
export interface SpritePackage {
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
	atlas?: SpriteAtlasGeometry;
	states?: Readonly<Record<string, SpriteAtlasState>>;
	theme?: { bubble?: Partial<SpriteBubbleTheme> };
	/** Rest-row (row 0) opaque content height, scanned at import — the
	 *  renderer normalizes every pet to SPRITE_CONTENT_TARGET_H so imported
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
export type CompanionArtDescriptor =
	| { mode: "vector"; kind: "builtin"; id: string }
	| { mode: "vector"; kind: "petdex"; pkg: SpritePackage }
	| { mode: "sprite"; kind: "petdex"; pkg: SpritePackage };

/** The mode a package's shape implies. Single-frame SVG packages are vector
 *  art; every frame format (`sheet` default and `atlas`) plays rows. */
export function artFormatForPackage(pkg: Pick<SpritePackage, "format">): CompanionArtFormat {
	return pkg.format === "svg" ? "vector" : "sprite";
}

/** A renderable descriptor from a `petActivity` push.
 *
 *  The union above is a compile-time contract, but a push crosses a window
 *  boundary where nothing enforces it: an older or partial payload arrives as
 *  `{ kind, id }` or as a package without its derived `mode`. `CompanionArt`
 *  dispatches on `mode` alone and its packaged branch dereferences `pkg`, so
 *  one such push blanks the pet window (React drops the tree on the render
 *  error). Rebuild `mode` from the payload's own shape; null means the push
 *  cannot describe art and the receiver keeps its local reading. */
export function companionArtFromPush(value: unknown): CompanionArtDescriptor | null {
	if (typeof value !== "object" || value === null) return null;
	const wire = value as { kind?: unknown; id?: unknown; pkg?: Partial<SpritePackage> | null };
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
		return { mode: artFormatForPackage(pkg), kind: "petdex", pkg: pkg as SpritePackage };
	}
	return null;
}

export interface SpriteAnimationDescriptor {
	frameW: number;
	frameH: number;
	columns: number;
	rowCount: number;
	row: number;
	valid: number;
	cycleMs: number;
	loop: boolean;
}

export type SpriteAnimationSource = Pick<SpritePackage, "width" | "height" | "format" | "rows" | "atlas" | "states">;

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
export function resolveSpriteAnimation(
	source: SpriteAnimationSource,
	mood: SpriteMood,
	action?: string | null,
	direction: "left" | "right" = "left",
): SpriteAnimationDescriptor {
	if (source.format === "svg") {
		return {
			frameW: source.width,
			frameH: source.height,
			columns: 1,
			rowCount: 1,
			row: 0,
			valid: 1,
			cycleMs: SPRITE_MOOD_ANIM[mood].cycleMs,
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
	const row = SPRITE_MOOD_ROW[mood];
	return {
		frameW: source.width / SPRITE_COLUMNS,
		frameH: source.height / PETDEX_ROWS,
		columns: SPRITE_COLUMNS,
		rowCount: PETDEX_ROWS,
		row,
		valid: Math.min(SPRITE_COLUMNS, Math.max(1, (source.rows ?? SPRITE_ROW_FRAMES_DEFAULT)[row] ?? SPRITE_COLUMNS)),
		cycleMs: SPRITE_MOOD_ANIM[mood].cycleMs,
		loop: true,
	};
}

export function spriteAmbientActions(pkg: SpritePackage): string[] {
	if (pkg.format !== "atlas" || !pkg.states) return [];
	return ["idle_random_1", "idle_random_2"].filter(name => pkg.states![name]);
}

export function spriteCustomActions(pkg: SpritePackage): string[] {
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
export function spriteBubbleTheme(pkg: Pick<SpritePackage, "theme">): SpriteBubbleTheme | null {
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

export function companionEnabled(): boolean {
	try {
		return localStorage.getItem("musepi-gui-pet") !== "0";
	} catch {
		return true;
	}
}

export function companionPlacement(): CompanionPlacement {
	try {
		return localStorage.getItem("musepi-gui-pet-mode") === "desktop" ? "desktop" : "input";
	} catch {
		return "input";
	}
}

/** Default active pet — the builtin spherical brand pet (the hand-drawn
 *  vector sphere with its face and headphones). Every spritesheet preset
 *  stays selectable; an explicit stored pick always wins. */
export const DEFAULT_COMPANION_ART_ID = BUILTIN_VECTOR_ART_ID;

/** Sprite-mode default when that mode has no remembered pick. */
export const DEFAULT_SPRITE_ART_ID = BUILTIN_SPRITE_PRESETS[0]!.id;

function defaultPetIdForMode(mode: CompanionArtFormat): string {
	return mode === "vector" ? BUILTIN_VECTOR_ART_ID : DEFAULT_SPRITE_ART_ID;
}

/** Last pick per mode. `musepi-gui-pet-id` stays the single active selection;
 *  these keys only keep the other side alive across a mode switch. A mode is
 *  never stored on its own — the id implies it. */
const COMPANION_ART_ID_BY_FORMAT_KEY: Record<CompanionArtFormat, string> = {
	vector: "musepi-gui-pet-vector-id",
	sprite: "musepi-gui-pet-sprite-id",
};

export function companionArtId(): string {
	try {
		return localStorage.getItem("musepi-gui-pet-id") ?? DEFAULT_COMPANION_ART_ID;
	} catch {
		return DEFAULT_COMPANION_ART_ID;
	}
}

export function setCompanionArtId(id: string): void {
	try {
		localStorage.setItem("musepi-gui-pet-id", id);
		localStorage.setItem(COMPANION_ART_ID_BY_FORMAT_KEY[companionArtForId(id).mode], id);
	} catch {
		// storage unavailable
	}
}

/** Mode an id resolves to, or null when the id no longer names anything (a
 *  stale pick left behind by a deleted package). */
function modeOfKnownId(id: string): CompanionArtFormat | null {
	const pet = companionArtForId(id);
	const known = pet.kind === "builtin" ? pet.id === id : pet.pkg.id === id;
	return known ? pet.mode : null;
}

/** Selection a mode would activate: its remembered pick, else the current
 *  pick when it already belongs there, else the mode's default. Stored ids
 *  from before modes existed resolve through the same {@link companionArtForId}
 *  derivation, so old data needs no migration write. */
export function companionArtIdForFormat(mode: CompanionArtFormat): string {
	const remembered = readStoredCompanionArtId(COMPANION_ART_ID_BY_FORMAT_KEY[mode]);
	if (remembered && modeOfKnownId(remembered) === mode) return remembered;
	const current = companionArtId();
	if (modeOfKnownId(current) === mode) return current;
	return defaultPetIdForMode(mode);
}

/** Switch drawing mode, restoring that mode's last selection. The mode being
 *  left keeps its pick for the next switch back. */
export function setCompanionArtFormat(mode: CompanionArtFormat): void {
	const current = companionArtId();
	const currentMode = modeOfKnownId(current);
	if (currentMode === mode) return;
	if (currentMode) {
		try {
			localStorage.setItem(COMPANION_ART_ID_BY_FORMAT_KEY[currentMode], current);
		} catch {
			// storage unavailable
		}
	}
	setCompanionArtId(companionArtIdForFormat(mode));
}

function readStoredCompanionArtId(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

export function loadSpritePackages(): SpritePackage[] {
	try {
		const raw = localStorage.getItem("musepi-gui-petdex");
		if (!raw) return [];
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed)
			? parsed.filter(
					(p): p is SpritePackage =>
						typeof p === "object" &&
						p !== null &&
						typeof (p as SpritePackage).id === "string" &&
						typeof (p as SpritePackage).spritesheet === "string",
				)
			: [];
	} catch {
		return [];
	}
}

export function saveSpritePackages(pets: SpritePackage[]): void {
	try {
		localStorage.setItem("musepi-gui-petdex", JSON.stringify(pets));
	} catch {
		// storage quota exceeded — the import UI surfaces this
	}
}

/** Resolve any pet id to a renderable descriptor with its drawing mode
 *  (preset grid previews, unknown ids → the builtin sphere fallback). */
export function companionArtForId(id: string): CompanionArtDescriptor {
	// The vector sphere is rendered by CompanionArt directly (no sheet).
	if (id === BUILTIN_VECTOR_ART_ID) return { mode: "vector", kind: "builtin", id: BUILTIN_VECTOR_ART_ID };
	const pkg = loadSpritePackages().find(p => p.id === id);
	if (pkg) return { mode: artFormatForPackage(pkg), kind: "petdex", pkg };
	const builtin = BUILTIN_SPRITE_PRESETS.find(p => p.id === id);
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
				rows: builtin.rows ?? SPRITE_ROW_FRAMES_DEFAULT,
				contentH: builtin.contentH,
				smooth: builtin.smooth,
				importedAt: 0,
			},
		};
	}
	return { mode: "vector", kind: "builtin", id: DEFAULT_COMPANION_ART_ID };
}

/** Resolve the active pet: imported petdex, builtin preset, or the builtin
 *  sphere fallback. */
export function activeCompanionArt(): CompanionArtDescriptor {
	return companionArtForId(companionArtId());
}

/** Map a session snapshot to the pet mood (ChatView passes these down). */
export function companionMoodFromSession(opts: {
	working: boolean;
	streaming: boolean;
	hasApprovals: boolean;
}): CompanionMood {
	if (opts.hasApprovals) return "waiting";
	if (opts.working) return opts.streaming ? "working" : "analyzing";
	return "rest";
}

/**
 * Resolve the shared presence contract to ONE companion state — a strict
 * priority chain, highest first. The order is the design: a failure outranks
 * everything (an agent blocked on an error is not "working"), live work
 * outranks notifications (what is happening now beats what happened
 * elsewhere), and the result emotions sit near the end because they are gated
 * on an actual result — never on nothing happening (see COMPANION_STATES).
 *
 * `phase`/`activity` win over the legacy boolean fields when both are present;
 * callers that still send only `working/streaming/approvals` keep the original
 * reading.
 */
export function companionStateFromSignals(s: AgentSignals = {}): CompanionState {
	if (s.dragging || s.interaction === "drag") return "dragging";
	if (s.spawning || s.presence === "starting") return "spawning";
	if (s.presence === "closing") return "powering-down";
	if (s.toolFailed || s.outcome?.kind === "failure" || s.phase === "error") return "alerting";
	if (s.ambiguous || s.interaction === "deny" || s.outcome?.kind === "refused") return "confused";
	if (s.presence === "hidden") return "drowsy";
	if (s.interaction === "bounce") return "bouncing";
	if (s.interaction === "hum") return "humming";
	// A pending approval is the loudest "you are needed" there is — the agent
	// is not working, it is WAITING, and the badge is the whole message.
	if ((s.approvals ?? 0) > 0 || (s.unread ?? 0) > 0) return "notifying";
	if ((s.questions ?? 0) > 0 || s.awaitingInput || s.phase === "awaiting-user") return "curious";
	if (s.streaming || s.phase === "streaming") return "writing";
	if (s.phase === "thinking") return "thinking";
	if (s.working || s.phase === "tool") {
		switch (s.activity) {
			case "searching":
			case "browsing":
			case "reading":
				return "searching";
			case "writing":
			case "coding":
			case "generating":
				return "writing";
			case "sending":
				return "sending";
			case "waiting":
				return "notifying";
			default:
				return "working";
		}
	}
	if (s.sending) return "sending";
	if (s.receiving) return "receiving";
	if (s.goal?.enabled && s.goal.total > 0 && s.goal.done >= s.goal.total) return "proud";
	if (s.phase === "done" || s.justFinished || s.outcome?.kind === "success") return "celebrate";
	if ((s.idleMs ?? 0) >= DROWSY_AFTER_MS) return "drowsy";
	return "idle";
}

/** Project the daemon's public presence contract onto the built-in
 *  companion's state vocabulary. Used for sessions the GUI does not stream. */
export function companionStateFromPresence(presence: SessionPresence): CompanionState {
	switch (presence.phase) {
		case "awaiting-approval":
			return "notifying";
		case "awaiting-input":
			return "curious";
		case "error":
			return "alerting";
		case "paused":
			return "idle";
		case "compacting":
			return "progress";
		case "tool":
			return presence.activeTool
				? companionStateFromSignals({ phase: "tool", activity: activityVerbForTool(presence.activeTool) })
				: "working";
		case "streaming":
			return "writing";
		case "thinking":
			return "thinking";
		case "starting":
		case "finalizing":
			return "working";
		default:
			return presence.working ? "working" : "idle";
	}
}

/** Map a session snapshot to the thinking-orb state — the single source the
 *  header and the chat view derive the agent avatar's animation from (the
 *  two previously duplicated the ternary and missed the approvals state,
 *  so the avatar spun on while the agent was actually blocked on a tool
 *  approval). Pending approvals pin the `waiting` state (the "paused for
 *  you" wave). */
export function thinkingOrbStateFromSession(
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
export const SPRITE_CONTENT_TARGET_H = 100;

/** User-facing pet size slider range (percent) + storage key. */
export const COMPANION_SCALE_KEY = "musepi-gui-pet-scale";
export const COMPANION_SCALE_MIN = 60;
export const COMPANION_SCALE_MAX = 150;

/** Pet size multiplier from the settings slider (60–150%, default 100). */
export function companionScale(): number {
	const raw = Number(localStorage.getItem(COMPANION_SCALE_KEY));
	if (!Number.isFinite(raw) || raw <= 0) return 1;
	return Math.min(COMPANION_SCALE_MAX, Math.max(COMPANION_SCALE_MIN, raw)) / 100;
}

export function setCompanionScale(pct: number): void {
	localStorage.setItem(
		COMPANION_SCALE_KEY,
		String(Math.min(COMPANION_SCALE_MAX, Math.max(COMPANION_SCALE_MIN, Math.round(pct)))),
	);
}

/** One-time migration for packages stored before the contentH scan existed:
 *  decode the spritesheet, measure the rest-row content height, persist,
 *  and notify so open windows re-render. Runs on mount of any window that
 *  uses useCompanionArt (main + pet). Idempotent — skips packages that have it. */
export function migrateSpritePackageContent(): void {
	const pets = loadSpritePackages();
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
								? measureSpriteAtlas(im, p.atlas).contentH
								: measureSpriteSheet(im).contentH;
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
			saveSpritePackages(pets);
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
export function measureSpriteSheet(img: HTMLImageElement): { rows: number[]; contentH: number } {
	return measureGrid(img, SPRITE_COLUMNS, PETDEX_ROWS, SPRITE_ROW_FRAMES_DEFAULT);
}

/** Atlas packages use declared frames; only visual-size normalization needs
 *  an alpha measurement. */
export function measureSpriteAtlas(img: HTMLImageElement, atlas: SpriteAtlasGeometry): { contentH: number } {
	const { contentH } = measureGrid(img, atlas.columns, atlas.rows, []);
	return { contentH };
}
