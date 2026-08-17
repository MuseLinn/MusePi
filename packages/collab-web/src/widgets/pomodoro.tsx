import { t } from "../i18n/index.js";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { SendChip } from "./send";

/**
 * Pomodoro widget (kimi Hello-World parity): focus 25 / short 5 / long 15
 * mode tags, SVG progress ring with MM:SS, start/pause/reset, per-day
 * round + focus-minute stats (persisted via the board data), and the
 * "4 rounds → long break" reward hint. Timer state is component-local;
 * only mode/rounds persist.
 */
const MODES: Array<{ id: string; label: string; minutes: number; labelKey: string }> = [
	{ id: "focus", label: "25", minutes: 25, labelKey: "widget pomodoro focus" },
	{ id: "short", label: "5", minutes: 5, labelKey: "widget pomodoro short" },
	{ id: "long", label: "15", minutes: 15, labelKey: "widget pomodoro long" },
];

function fmt(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function PomodoroCard({
	data,
	update,
	sendPrompt,
}: {
	data: Record<string, unknown>;
	update(patch: Record<string, unknown>): void;
	sendPrompt?(text: string): void;
}): ReactNode {
	const modeId = typeof data.mode === "string" ? data.mode : "focus";
	const mode = MODES.find(m => m.id === modeId) ?? MODES[0];
	const [left, setLeft] = useState(mode.minutes * 60);
	const [running, setRunning] = useState(false);
	const [tick, setTick] = useState(0);
	const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

	// Mode switch resets the timer (not running).
	useEffect(() => {
		setLeft(mode.minutes * 60);
		setRunning(false);
	}, [mode.minutes, modeId]);

	useEffect(() => {
		if (!running) return;
		timerRef.current = setInterval(() => {
			setLeft(prev => {
				if (prev <= 1) {
					// Round complete: +1 round, +mode minutes, auto-stop.
					const isFocus = modeId === "focus";
					update({
						rounds: (typeof data.rounds === "number" ? data.rounds : 0) + (isFocus ? 1 : 0),
						minutes: (typeof data.minutes === "number" ? data.minutes : 0) + mode.minutes,
						day: new Date().toDateString(),
					});
					setRunning(false);
					return mode.minutes * 60;
				}
				return prev - 1;
			});
			setTick(x => x + 1);
		}, 1000);
		return () => {
			if (timerRef.current) clearInterval(timerRef.current);
		};
	}, [running, modeId, mode.minutes, data.rounds, data.minutes, update]);

	const total = mode.minutes * 60;
	const pct = total > 0 ? 1 - left / total : 0;
	const radius = 52;
	const circ = 2 * Math.PI * radius;
	const dash = pct * circ;
	const rounds = typeof data.rounds === "number" ? data.rounds : 0;
	const minutes = typeof data.minutes === "number" ? data.minutes : 0;

	return (
		<div className="gui-widget-pomodoro">
			<div className="gui-widget-pomodoro-modes">
				{MODES.map(m => (
					<button
						key={m.id}
						type="button"
						className={`gui-widget-pomodoro-mode${modeId === m.id ? " gui-widget-pomodoro-mode--active" : ""}`}
						onClick={() => update({ mode: m.id })}
					>
						{t(m.labelKey as never)} {m.minutes}
					</button>
				))}
			</div>
			<div className="gui-widget-pomodoro-ring-wrap">
				<svg viewBox="0 0 120 120" className="gui-widget-pomodoro-ring">
					<circle cx="60" cy="60" r={radius} fill="none" className="gui-widget-pomodoro-ring-bg" />
					<circle
						cx="60"
						cy="60"
						r={radius}
						fill="none"
						className="gui-widget-pomodoro-ring-fg"
						strokeDasharray={`${dash} ${circ - dash}`}
						transform="rotate(-90 60 60)"
					/>
				</svg>
				<div className="gui-widget-pomodoro-center">
					<span className="gui-widget-pomodoro-time">{fmt(left)}</span>
					<span className="gui-widget-pomodoro-state">{running ? t("widget pomodoro running") : t("widget pomodoro ready")}</span>
				</div>
			</div>
			<div className="gui-widget-pomodoro-actions">
				<button type="button" className="gui-widget-pomodoro-btn gui-widget-pomodoro-btn--primary" onClick={() => setRunning(r => !r)}>
					{running ? t("widget pomodoro pause") : t("widget pomodoro start")}
				</button>
				<button
					type="button"
					className="gui-widget-pomodoro-btn"
					onClick={() => {
						setRunning(false);
						setLeft(mode.minutes * 60);
					}}
				>
					{t("widget pomodoro reset")}
				</button>
			</div>
			<div className="gui-widget-pomodoro-stats">
				<span>
					{t("widget pomodoro rounds")} {rounds}
				</span>
				<span>
					{t("widget pomodoro minutes")} {minutes}
				</span>
			</div>
			<div className="gui-widget-pomodoro-hint">{t("widget pomodoro reward")}</div>
			{tick >= 0 && null}
		
			<SendChip
				text={`${t("widget pomodoro done")} ${rounds} ${t("widget pomodoro rounds")}`}
				onSend={sendPrompt}
			/>
</div>
	);
}
