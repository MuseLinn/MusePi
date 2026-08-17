import { punkAvatarUri } from "@musepi/desktop-web";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { type OrbState, ThinkingOrb } from "../vendor/thinking-orbs";

/**
 * Agent-avatar presets (pet-style switcher): the chat avatar is a
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

export const AVATAR_PRESETS: readonly AvatarPresetDef[] = [
	{
		id: "orbs",
		labelKey: "avatar orbs",
		render: (state, size) => <ThinkingOrb state={state} size={size as 20 | 32 | 64} theme="auto" />,
	},
	{ id: "hex", labelKey: "avatar hex", render: (state, size) => <HexAvatar state={state} size={size} /> },
	{ id: "spark", labelKey: "avatar spark", render: (state, size) => <SparkAvatar state={state} size={size} /> },
	{ id: "punk", labelKey: "avatar punk", render: (_state, size, seed) => <PunkAvatar size={size} seed={seed} /> },
];

export function avatarPreset(id: string): AvatarPresetDef {
	return AVATAR_PRESETS.find(p => p.id === id) ?? AVATAR_PRESETS[0]!;
}
