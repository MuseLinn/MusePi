import { punkAvatarUri } from "@musepi/client-core";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { AgentSignals } from "../lib/agent-signals";
import {
	type CompanionInteraction,
	type CompanionState,
	randomCompanionInteraction,
	type SpriteMood,
} from "../lib/companion";
import type { CompanionEffectTier } from "../lib/companion-effects";
import { type OrbState, ThinkingOrb } from "../vendor/thinking-orbs";
import { AoraAvatar } from "./AoraAvatar";
import { BuiltinCompanionArt, CompanionArtBox, type GazeVec, useCompanionDecor } from "./CompanionArt";

/**
 * Agent-avatar presets (companion-style switcher): the chat avatar is a
 * thinking-orb by default, but users can swap in alternative SVG
 * definitions — each preset renders its own state-aware animation.
 * Selection persists as musepi-gui-avatar (localStorage) and broadcasts
 * omp-avatar-changed so every mounted avatar re-renders live.
 */
export const AVATAR_STORAGE_KEY = "musepi-gui-avatar";

export function avatarPresetId(): string {
	try {
		return localStorage.getItem(AVATAR_STORAGE_KEY) ?? "orbs";
	} catch {
		return "orbs";
	}
}

export interface AvatarPresetDef {
	id: string;
	labelKey: string;
	render(state: OrbState, size: number, seed?: string): ReactNode;
	/** Presets that render from the shared `AgentSignals` contract (richer than
	 *  OrbState) declare this. When the call site supplies signals, this wins
	 *  over `render`; `render` stays the OrbState fallback for previews and
	 *  legacy call sites. */
	renderSignals?(signals: AgentSignals, size: number, seed?: string): ReactNode;
}

/** Hexagon glyph: slow ring rotation while working, gentle breathing
 *  when idle. The six states share the geometry; the animation differs. */
function HexAvatar({ state, size }: { state: OrbState; size: number }): ReactNode {
	const anim =
		state === "working" || state === "solving"
			? "gui-avatar-hex--spin"
			: state === "listening"
				? "gui-avatar-hex--breathe"
				: "";
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 64 64"
			className={`gui-avatar-hex${anim ? ` ${anim}` : ""}`}
			role="img"
		>
			<polygon
				points="32,6 55,19 55,45 32,58 9,45 9,19"
				fill="none"
				stroke="var(--accent, currentColor)"
				strokeWidth="3"
				strokeLinejoin="round"
			/>
			<circle cx="32" cy="32" r="7" fill="var(--accent, currentColor)" opacity="0.85" />
		</svg>
	);
}

/** Spark/star glyph: pulsing star while working, still when idle. */
function SparkAvatar({ state, size }: { state: OrbState; size: number }): ReactNode {
	const anim = state === "working" || state === "searching" || state === "composing" ? "gui-avatar-spark--pulse" : "";
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 64 64"
			className={`gui-avatar-spark${anim ? ` ${anim}` : ""}`}
			role="img"
		>
			<path
				d="M32 6 C34 22 38 28 48 32 C38 36 34 42 32 58 C30 42 26 36 16 32 C26 28 30 22 32 6 Z"
				fill="var(--accent, currentColor)"
				opacity="0.9"
			/>
			<circle
				cx="32"
				cy="32"
				r="14"
				fill="none"
				stroke="var(--accent, currentColor)"
				strokeWidth="2"
				opacity="0.5"
			/>
		</svg>
	);
}

/** Pixel-punk face (sweeterio/pixelpunks port): deterministic per seed.
 *  Seed resolution order: explicit `seed` prop (identity-bound: swarm
 *  member, git user) → user-chosen face (设置 → 常规, persisted) → a
 *  per-install random face. So the main agent avatar shows the face the
 *  user picked, while identity-bound faces stay stable regardless. State
 *  is ignored (static face; the surrounding state chrome stays on the
 *  host). */
export const PUNK_SEED_KEY = "musepi-gui-avatar-punk-seed";

/** The user-chosen face seed (null when never customized — falls back to a
 *  stable per-install random face). */
export function userPunkSeed(): string | null {
	try {
		return localStorage.getItem(PUNK_SEED_KEY);
	} catch {
		return null;
	}
}

/** Persist a chosen face seed and broadcast so mounted avatars re-render. */
export function setPunkSeed(seed: string): void {
	try {
		localStorage.setItem(PUNK_SEED_KEY, seed);
	} catch {
		// storage unavailable — face stays random this session
	}
	if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("omp-avatar-changed"));
}

export function randomPunkSeed(): string {
	return `punk-${Math.random().toString(36).slice(2, 10)}`;
}

export function PunkAvatar({ size, seed }: { size: number; seed?: string }): ReactNode {
	// Re-resolve the seed when the user shuffles/edits the face in settings
	// (设置 → 常规 broadcasts omp-avatar-changed; storage covers cross-tab).
	// Without this, useMemo([seed]) keeps the old face after 换一个/Apply —
	// the preview and chat avatar would visibly ignore the control.
	const [bump, setBump] = useState(0);
	useEffect(() => {
		const on = (): void => setBump(b => b + 1);
		window.addEventListener("omp-avatar-changed", on);
		window.addEventListener("storage", on);
		return () => {
			window.removeEventListener("omp-avatar-changed", on);
			window.removeEventListener("storage", on);
		};
	}, []);
	const stableSeed = useMemo(() => {
		void bump; // dependency: force re-resolution on broadcast
		if (seed) return seed;
		const chosen = userPunkSeed();
		if (chosen) return chosen;
		// Persist the first random face WITHOUT broadcasting (would loop the
		// listener); the bump re-resolves it on the next event anyway.
		const fresh = randomPunkSeed();
		try {
			localStorage.setItem(PUNK_SEED_KEY, fresh);
		} catch {
			// storage unavailable — face falls back to the fixed default
		}
		return userPunkSeed() ?? "punk";
	}, [seed, bump]);
	return <img src={punkAvatarUri(stableSeed)} width={size} height={size} alt="" className="gui-avatar-punk" />;
}

/** Orb state → mascot mood (the builtin orb-bot's faces). Mirrors the
 *  floating pet's state binding instead of the old random idle cycle:
 *  composing spins as working, searching/solving/shaping squint as
 *  analyzing, approvals pin the waiting face. */
const THINKING_ORB_TO_SPRITE_MOOD: Record<OrbState, SpriteMood> = {
	listening: "rest",
	working: "working",
	searching: "analyzing",
	solving: "analyzing",
	composing: "working",
	shaping: "analyzing",
	waiting: "waiting",
};

/**
 * OrbState → the 31-state axis. This is the mapping that finally answers
 * "does the session AVATAR get the morph richness too?" — yes, and it gets it
 * from the same table the desktop pet does.
 *
 * The win over the mood mapping above is not more states for their own sake:
 * `searching` and `solving` were both "analyzing" (one face, one motion) and
 * `composing` and `working` were both "working". On the state axis they split,
 * so the avatar can finally tell "reading the codebase" from "reasoning about
 * it" and "writing the answer" from "running a tool".
 */
const THINKING_ORB_TO_COMPANION_STATE: Record<OrbState, CompanionState> = {
	listening: "listening",
	working: "working",
	searching: "searching",
	solving: "thinking",
	composing: "writing",
	shaping: "progress",
	waiting: "notifying",
};

/**
 * Effect tier by render size. The avatar ships at 20 / 32 / 64px and the
 * pet's own vocabulary does not survive all three: at 20px the eyes are a few
 * pixels and confetti ribbons are sub-pixel smears, so only the badge (a
 * colour and a position) is worth drawing. See companion-effects.tsx TIER_KEEP.
 */
const tierForSize = (size: number): CompanionEffectTier => (size >= 64 ? "full" : size >= 32 ? "compact" : "micro");

/** How long an avatar click reaction holds before the live mood shows
 *  through again. A touch longer than the desktop pet's hold
 *  (INTERACTION_HOLD_MS): the avatar is small, its faces read slowly. */
const AVATAR_REACTION_HOLD_MS = 1500;

/** Pet avatar (orb-bot): the desktop mascot rendered in the avatar slot.
 *  Eyes track the cursor — one window-level pointermove writes the gaze
 *  ref per mounted avatar (the engine reads it per frame; no React
 *  re-render). Normalized to ±1 over a 150px reach and clamped: beyond
 *  that the eyes stay pinned toward the pointer, "watching you" across
 *  the room. 120px was too tight — the avatar's own box is up to 64px, so
 *  the full-deflection band covered barely one box-width of cursor travel
 *  and the eyes looked pinned almost immediately; 150px keeps the follow
 *  reading as tracking across the panel without going sluggish.
 *
 *  Click-to-react (2026-09-20, blobstudio-grade richness request): poking
 *  the avatar plays a random reaction from the FULL interaction set —
 *  never the same one twice in a row — and resolves back to the live
 *  agent mood on its own clock. Transient by contract: a reaction is a
 *  gesture, never a session state, so it lives in local state only and
 *  is never written to the store.
 *
 *  The box size comes from CSS (`.gui-avatar-pet`, font-size driven) —
 *  NOT from an inline width. An inline size here outranks the transcript's
 *  40px gutter column, so the 64px chat avatar would overflow the very
 *  column the layout reserved for it; the avatar slot is exactly the case
 *  where the stylesheet, not the call site, knows the right number. */
function CompanionAvatar({ state, size }: { state: OrbState; size: number }): ReactNode {
	const boxRef = useRef<HTMLSpanElement | null>(null);
	const gazeRef = useRef<GazeVec | null>(null);
	// Live decoration prefs — the avatar must match the floating pet and
	// the composer orb (gloss off / a wearable shows up here too).
	const decor = useCompanionDecor();
	// The transient click reaction (see the component doc above).
	const [reaction, setReaction] = useState<CompanionInteraction | null>(null);
	const lastReaction = useRef<CompanionInteraction | null>(null);
	const reactionTimer = useRef<number | null>(null);
	useEffect(
		() => () => {
			if (reactionTimer.current !== null) window.clearTimeout(reactionTimer.current);
		},
		[],
	);
	const poke = (): void => {
		const pick = randomCompanionInteraction(lastReaction.current);
		lastReaction.current = pick;
		setReaction(pick);
		if (reactionTimer.current !== null) window.clearTimeout(reactionTimer.current);
		reactionTimer.current = window.setTimeout(() => setReaction(null), AVATAR_REACTION_HOLD_MS);
	};
	useEffect(() => {
		const GAZE_RANGE_PX = 150;
		const onMove = (e: PointerEvent): void => {
			const el = boxRef.current;
			if (!el) return;
			const r = el.getBoundingClientRect();
			if (r.width <= 0) return;
			let gx = (e.clientX - (r.left + r.width / 2)) / GAZE_RANGE_PX;
			let gy = (e.clientY - (r.top + r.height / 2)) / GAZE_RANGE_PX;
			const len = Math.hypot(gx, gy);
			if (len > 1) {
				gx /= len;
				gy /= len;
			}
			gazeRef.current = { x: gx, y: gy, at: performance.now() };
		};
		window.addEventListener("pointermove", onMove);
		return () => window.removeEventListener("pointermove", onMove);
	}, []);
	return (
		<span
			ref={boxRef}
			className="gui-avatar-pet"
			style={{ "--gui-pet-size": `${size}px` } as CSSProperties}
			role="img"
			onClick={poke}
		>
			{/* CompanionArtBox, not a bare svg: `.gui-pet-svg` has no size rule of its own
			 * (gui-pet.css sizes `.gui-pet svg`, a descendant) — without the box
			 * the avatar svg resolves to nothing and the slot renders empty
			 * (2026-09-20 user: 「头像小球不显示了」). */}
			<CompanionArtBox size={size}>
				<BuiltinCompanionArt
					mood={THINKING_ORB_TO_SPRITE_MOOD[state]}
					state={THINKING_ORB_TO_COMPANION_STATE[state]}
					tier={tierForSize(size)}
					gazeRef={gazeRef}
					interaction={reaction}
					gloss={decor.gloss}
					accessory={decor.accessory}
				/>
			</CompanionArtBox>
		</span>
	);
}

/** OrbState → the shared signals contract, for call sites that only have the
 *  compact orb state (settings previews, older hosts). Aora renders from
 *  `renderSignals` whenever real signals are present; this fallback keeps the
 *  preset legible instead of faking states Aora cannot honestly receive. */
const ORB_TO_SIGNALS: Record<OrbState, AgentSignals> = {
	listening: { phase: "idle" },
	working: { phase: "tool", activity: "working" },
	searching: { phase: "tool", activity: "searching" },
	solving: { phase: "thinking" },
	composing: { phase: "streaming" },
	shaping: { phase: "tool", activity: "generating" },
	waiting: { approvals: 1 },
};

export const AVATAR_PRESETS: readonly AvatarPresetDef[] = [
	{
		id: "orbs",
		labelKey: "avatar orbs",
		render: (state, size) => <ThinkingOrb state={state} size={size as 20 | 32 | 64} theme="auto" />,
	},
	{
		id: "pet",
		labelKey: "avatar pet",
		render: (state, size) => <CompanionAvatar state={state} size={size} />,
	},
	{ id: "hex", labelKey: "avatar hex", render: (state, size) => <HexAvatar state={state} size={size} /> },
	{ id: "spark", labelKey: "avatar spark", render: (state, size) => <SparkAvatar state={state} size={size} /> },
	{ id: "punk", labelKey: "avatar punk", render: (_state, size, seed) => <PunkAvatar size={size} seed={seed} /> },
	{
		id: "aora",
		labelKey: "avatar aora",
		render: (state, size, seed) => <AoraAvatar signals={ORB_TO_SIGNALS[state]} size={size} seed={seed} />,
		renderSignals: (signals, size, seed) => <AoraAvatar signals={signals} size={size} seed={seed} />,
	},
];

export function avatarPreset(id: string): AvatarPresetDef {
	return AVATAR_PRESETS.find(p => p.id === id) ?? AVATAR_PRESETS[0]!;
}
