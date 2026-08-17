import { type ReactNode, useEffect, useState } from "react";
import { type OrbState } from "../vendor/thinking-orbs";
import { AVATAR_STORAGE_KEY, avatarPreset } from "./avatar-presets";

/**
 * Agent avatar — a thinking-orb by default whose animation reflects the
 * agent's current state (idle → working, searching, composing…).
 * Alternative presets (hex, spark) swap in via 设置 → 常规 → Agent 头像
 * (pet-style switcher, persisted omp-gui-avatar); all presets receive
 * the same OrbState so the animation still tracks the agent.
 * Theme-aware via data-theme. Sizes: 20 (toolbar), 32, or 64 (chat avatar).
 *
 * While idle (`listening`) the orb leisurely cycles through a few pleasant
 * effects (wave → globe → morph) every few seconds, crossfaded — a subtle
 * "waiting for you" pulse instead of a frozen waveform. Working/composing
 * states stay pinned to their distinct animation.
 */
const IDLE_CYCLE: OrbState[] = ["listening", "searching", "shaping"];
const CYCLE_MS = 4000;

export function AgentAvatar({ state = "working", size = 20 }: { state?: OrbState; size?: 20 | 32 | 64 }): ReactNode {
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
		motionOff = localStorage.getItem("omp-gui-motion") === "off";
	} catch {
		// storage unavailable — keep cycling on
	}
	const cycling = state === "listening" && !motionOff;
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
	return (
		<span className="gui-agent-avatar" role="img" aria-label={`agent ${state}`}>
			{cycling && presetId === "orbs" ? (
				<span className="gui-agent-avatar-cycle">
					{IDLE_CYCLE.map(s => (
						<span
							key={s}
							className={`gui-agent-avatar-frame${s === active ? " gui-agent-avatar-frame--active" : ""}`}
						>
							{preset.render(s, size)}
						</span>
					))}
				</span>
			) : (
				preset.render(active, size)
			)}
		</span>
	);
}
