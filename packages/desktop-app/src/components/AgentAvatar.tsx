import { type ReactNode, useEffect, useState } from "react";
import type { AgentSignals } from "../lib/agent-signals";
import type { OrbState } from "../vendor/thinking-orbs";
import { AVATAR_STORAGE_KEY, avatarPreset } from "./avatar-presets";

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
	const draw = (s: OrbState): ReactNode =>
		signals && preset.renderSignals ? preset.renderSignals(signals, size, seed) : preset.render(s, size, seed);
	return (
		<span className="gui-agent-avatar" role="img" aria-label={`agent ${state}`}>
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
