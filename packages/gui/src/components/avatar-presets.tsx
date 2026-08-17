import type { ReactNode } from "react";
import { type OrbState, ThinkingOrb } from "../vendor/thinking-orbs";

/**
 * Agent-avatar presets (pet-style switcher): the chat avatar is a
 * thinking-orb by default, but users can swap in alternative SVG
 * definitions — each preset renders its own state-aware animation.
 * Selection persists as omp-gui-avatar (localStorage) and broadcasts
 * omp-avatar-changed so every mounted avatar re-renders live.
 */
export const AVATAR_STORAGE_KEY = "omp-gui-avatar";

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
	render(state: OrbState, size: number): ReactNode;
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
			<circle cx="32" cy="32" r="14" fill="none" stroke="var(--accent, currentColor)" strokeWidth="2" opacity="0.5" />
		</svg>
	);
}

export const AVATAR_PRESETS: readonly AvatarPresetDef[] = [
	{
		id: "orbs",
		labelKey: "avatar orbs",
		render: (state, size) => <ThinkingOrb state={state} size={size as 20 | 32 | 64} theme="auto" />,
	},
	{ id: "hex", labelKey: "avatar hex", render: (state, size) => <HexAvatar state={state} size={size} /> },
	{ id: "spark", labelKey: "avatar spark", render: (state, size) => <SparkAvatar state={state} size={size} /> },
];

export function avatarPreset(id: string): AvatarPresetDef {
	return AVATAR_PRESETS.find(p => p.id === id) ?? AVATAR_PRESETS[0]!;
}
