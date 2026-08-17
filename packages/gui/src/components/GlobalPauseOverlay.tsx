/**
 * Fullscreen global-pause overlay (TUI `/pause` parity for the desktop).
 *
 * The daemon's global freeze engages the process-wide gate every agent loop
 * consults BEFORE its own per-session gate, so this overlay freezes every
 * session's agents (main, subagents, advisor) at once — while each session's
 * own pause state stays orthogonal and untouched. The overlay covers the
 * whole window (settings dialogs included) with a frosted-glass scrim whose
 * blur animates in/out (dynamic blur), a live hold timer, and click/ESC to
 * resume.
 */
import { t } from "@musepi/desktop-web";
import { useEffect, useState } from "react";
import { Icon } from "../vendor/oc-icons";

/** "mm:ss" hold time; re-rendered by a 1s tick. */
function formatPauseElapsed(pausedAt: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - pausedAt) / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function GlobalPauseOverlay({
	paused,
	pausedAt,
	onResume,
}: {
	/** Process-global freeze engaged (daemon-wide). */
	paused: boolean;
	/** Epoch ms when the freeze began; null while running. */
	pausedAt: number | null;
	onResume(): void;
}): React.ReactNode {
	const [, setTick] = useState(0);
	useEffect(() => {
		if (!paused) return;
		const timer = setInterval(() => setTick(v => v + 1), 1_000);
		return () => clearInterval(timer);
	}, [paused]);

	// ESC resumes (TUI pause-screen parity: esc · enter · space — resume).
	useEffect(() => {
		if (!paused) return;
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				onResume();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [paused, onResume]);

	return (
		<div
			className={`gui-global-pause${paused ? " gui-global-pause--active" : ""}`}
			role="dialog"
			aria-modal="true"
			aria-label={t("paused")}
			onClick={() => {
				if (paused) onResume();
			}}
		>
			<div className="gui-global-pause-card" onClick={e => e.stopPropagation()}>
				<span className="gui-global-pause-icon" aria-hidden="true">
					<Icon name="pause" className="h-9 w-9" />
				</span>
				<h2 className="gui-global-pause-title">{t("paused")}</h2>
				<p className="gui-global-pause-timer" data-paused-at={pausedAt}>
					{pausedAt ? formatPauseElapsed(pausedAt) : "0:00"}
				</p>
				<p className="gui-global-pause-hint">{t("all sessions are frozen until you resume")}</p>
				<button type="button" className="gui-global-pause-resume" onClick={() => onResume()}>
					<Icon name="play" className="h-4 w-4" />
					{t("resume")}
				</button>
			</div>
		</div>
	);
}
