import { type ReactNode, useEffect, useRef, useState } from "react";
import type { AgentSignals } from "../lib/agent-signals";
import type { OrbState } from "../vendor/thinking-orbs";
import { AVATAR_STORAGE_KEY, avatarPreset, ORB_TO_SIGNALS } from "./avatar-presets";

/**
 * Agent avatar — a thinking-orb by default whose animation reflects the
 * agent's current state (idle → working, searching, composing…).
 * Alternative presets (hex, spark) swap in via 设置 → 常规 → Agent 头像
 * (companion-style switcher, persisted musepi-gui-avatar); all presets receive
 * the same OrbState so the animation still tracks the agent. Presets that
 * declare `renderSignals` (Aora) instead receive the shared `AgentSignals`
 * contract when the call site supplies it; OrbState stays the fallback for
 * previews and legacy call sites.
 * Theme-aware via data-theme. Sizes: 20 (toolbar), 32, or 64 (chat avatar).
 *
 * While idle (`listening`) the orb leisurely cycles through a few pleasant
 * effects (wave → globe → morph) every few seconds, crossfaded — a subtle
 * "waiting for you" pulse instead of a frozen waveform. Working/composing
 * states stay pinned to their distinct animation.
 */
const IDLE_CYCLE: OrbState[] = ["listening", "searching", "shaping"];
const CYCLE_MS = 4000;
/** How long a click reaction holds before the live mood shows through again
 *  (the desktop pet's own reaction uses the same 1.5s). */
const AVATAR_POKE_HOLD_MS = 1500;

export function AgentAvatar({
	state = "working",
	size = 20,
	seed,
	signals,
}: {
	state?: OrbState;
	size?: 20 | 32 | 64;
	/** Identity-bound avatar seed (session id, agent id, model…) — punk
	 *  preset renders a deterministic face per seed. */
	seed?: string;
	/** The shared presence contract. Presets that declare `renderSignals`
	 *  (Aora) render from this instead of the compact OrbState. */
	signals?: AgentSignals;
}): ReactNode {
	const [presetId, setPresetId] = useState(() => {
		try {
			return localStorage.getItem(AVATAR_STORAGE_KEY) ?? "orbs";
		} catch {
			return "orbs";
		}
	});
	// Live preset switch (设置 → 常规): every mounted avatar re-renders.
	useEffect(() => {
		const on = (): void => {
			try {
				setPresetId(localStorage.getItem(AVATAR_STORAGE_KEY) ?? "orbs");
			} catch {
				// storage unavailable
			}
		};
		window.addEventListener("omp-avatar-changed", on);
		window.addEventListener("storage", on);
		return () => {
			window.removeEventListener("omp-avatar-changed", on);
			window.removeEventListener("storage", on);
		};
	}, []);
	// Hover/poke are transient gestures, not session facts: they live in local
	// state for the hold window and then fall back to the live signals. Aora's
	// engine reads them as interaction signals (hover → emphasis + curious,
	// poke → surprised); other presets ignore them.
	const [hovered, setHovered] = useState(false);
	const [poked, setPoked] = useState(false);
	const pokeTimer = useRef<number | null>(null);
	useEffect(
		() => () => {
			if (pokeTimer.current !== null) window.clearTimeout(pokeTimer.current);
		},
		[],
	);
	const poke = (): void => {
		setPoked(true);
		if (pokeTimer.current !== null) window.clearTimeout(pokeTimer.current);
		pokeTimer.current = window.setTimeout(() => setPoked(false), AVATAR_POKE_HOLD_MS);
	};
	const [cycleIndex, setCycleIndex] = useState(0);
	let motionOff = false;
	try {
		motionOff = localStorage.getItem("musepi-gui-motion") === "off";
	} catch {
		// storage unavailable — keep cycling on
	}
	// Signal/state-bound presets opt out of the idle cycle: the pet's mood
	// binding (THINKING_ORB_TO_SPRITE_MOOD in avatar-presets.tsx) and Aora's
	// signal projection are authoritative — a scripted cycle would fake work
	// states (searching/shaping) while the session is simply idle.
	const cycling = state === "listening" && !motionOff && presetId !== "pet" && presetId !== "aora";
	useEffect(() => {
		if (!cycling) return;
		let id = window.setInterval(() => setCycleIndex(i => (i + 1) % IDLE_CYCLE.length), CYCLE_MS);
		// Cosmetic idle animation: skip ticks while the tab is hidden.
		const onVis = (): void => {
			window.clearInterval(id);
			if (document.visibilityState === "visible")
				id = window.setInterval(() => setCycleIndex(i => (i + 1) % IDLE_CYCLE.length), CYCLE_MS);
		};
		document.addEventListener("visibilitychange", onVis);
		return () => {
			window.clearInterval(id);
			document.removeEventListener("visibilitychange", onVis);
		};
	}, [cycling]);
	const preset = avatarPreset(presetId);
	const active = cycling ? IDLE_CYCLE[cycleIndex % IDLE_CYCLE.length] : state;
	// Signal-driven presets (Aora) render the richer contract when the call
	// site has it; every other preset, and every legacy call site, keeps the
	// compact OrbState path.
	const draw = (s: OrbState): ReactNode => {
		if (!preset.renderSignals) return preset.render(s, size, seed);
		// No live signals (toolbar, previews) still renders honestly: the compact
		// orb state is the base, the gesture is layered on top.
		const base = signals ?? ORB_TO_SIGNALS[s];
		const merged: AgentSignals = poked
			? { ...base, interaction: "poke" }
			: hovered
				? { ...base, interaction: "hover" }
				: base;
		return preset.renderSignals(merged, size, seed);
	};
	return (
		<span
			className="gui-agent-avatar"
			role="img"
			aria-label={`agent ${state}`}
			onPointerEnter={() => setHovered(true)}
			onPointerLeave={() => setHovered(false)}
			// Only presets with a signal renderer (Aora) take the poke here; the
			// pet preset owns its own click reaction inside its art box.
			onClick={preset.renderSignals ? poke : undefined}
		>
			{cycling && presetId === "orbs" ? (
				<span className="gui-agent-avatar-cycle">
					{IDLE_CYCLE.map(s => (
						<span
							key={s}
							className={`gui-agent-avatar-frame${s === active ? " gui-agent-avatar-frame--active" : ""}`}
						>
							{draw(s)}
						</span>
					))}
				</span>
			) : (
				draw(active)
			)}
		</span>
	);
}
