import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { type OrbState, ThinkingOrb } from "../vendor/thinking-orbs";

/**
 * Agent avatar — a thinking-orb whose animation reflects the agent's
 * current state (idle → working, searching, composing…). Theme-aware
 * via data-theme. Sizes: 20 (toolbar), 32, or 64 (chat avatar).
 *
 * While idle (`listening`) the orb leisurely cycles through a few pleasant
 * effects (wave → globe → morph) every few seconds, crossfaded — a subtle
 * "waiting for you" pulse instead of a frozen waveform. Working/composing
 * states stay pinned to their distinct animation.
 */
const IDLE_CYCLE: OrbState[] = ["listening", "searching", "shaping"];
const CYCLE_MS = 4000;

export function AgentAvatar({ state = "working", size = 20 }: { state?: OrbState; size?: 20 | 32 | 64 }): ReactNode {
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
	const active = cycling ? IDLE_CYCLE[cycleIndex % IDLE_CYCLE.length] : state;
	return (
		<span className="gui-agent-avatar" role="img" aria-label={`agent ${state}`}>
			{cycling ? (
				<span className="gui-agent-avatar-cycle">
					{IDLE_CYCLE.map(s => (
						<span
							key={s}
							className={`gui-agent-avatar-frame${s === active ? " gui-agent-avatar-frame--active" : ""}`}
						>
							<ThinkingOrb state={s} size={size} theme="auto" />
						</span>
					))}
				</span>
			) : (
				<ThinkingOrb state={state} size={size} theme="auto" />
			)}
		</span>
	);
}
