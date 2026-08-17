import { Square } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";
import { t } from "../../i18n/index.js";
import { sessionAccentHex } from "../../lib/session-accent";

/** Braille spinner frames (cli-spinners "dots" parity): 10 frames at 80ms
 * reads as a rotating 2×4 dot matrix while the agent works. */
const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Agent status line prefs (settings → agent 状态行): the indicator is
 * either the braille spinner, the pulsing orb, the aicss-style 3×3
 * lattice wave, or the 8-dot orbit ring; the label effect is the
 * shimmer sweep, the KITT eye sweep, or plain. The sweep color picks the
 * default tone (text-colored bright stop, shimmer-like) or the accent
 * color — applies to both the shimmer and KITT sweeps. */
export type AgentStatusEffect = "shimmer" | "kitt" | "plain";
export type AgentStatusIndicator = "braille" | "orb" | "lattice" | "ring";
export type SweepColor = "default" | "accent";

export function readStatusPrefs(): {
	effect: AgentStatusEffect;
	indicator: AgentStatusIndicator;
	sweepColor: SweepColor;
} {
	let effect: AgentStatusEffect = "shimmer";
	let indicator: AgentStatusIndicator = "braille";
	let sweepColor: SweepColor = "default";
	try {
		const e = localStorage.getItem("musepi-gui-statusbar");
		if (e === "kitt" || e === "plain" || e === "shimmer") effect = e;
		const i = localStorage.getItem("musepi-gui-statusbar-indicator");
		if (i === "orb" || i === "braille" || i === "lattice" || i === "ring") indicator = i;
		const k = localStorage.getItem("musepi-gui-statusbar-kitt-color");
		if (k === "accent" || k === "default") sweepColor = k;
	} catch {
		// localStorage unavailable — defaults stand
	}
	return { effect, indicator, sweepColor };
}

/**
 * Agent status line hanging above the input card: small braille spinner
 * (or the pulsing orb, per prefs) + label while the agent works, then a
 * brief "思考完毕" acknowledgement when the turn ends (user: the thinking
 * state lives here — outside the input card and not duplicated in the
 * transcript — and flips to complete once finished). The label defaults to
 * the shimmer sweep; in kitt mode the label carries the KITT eye instead
 * (a text-clipped accent band bouncing left↔right, same idea, no bar).
 */
export function AgentStatusLine({
	working,
	effect,
	indicator,
	sweepColor = "default",
	sessionKey,
}: {
	working: boolean;
	effect: AgentStatusEffect;
	indicator: AgentStatusIndicator;
	sweepColor?: SweepColor;
	/** Session id/name — derives the TUI-style per-session accent that
	 * colors the spinner/orb; absent (settings preview) → theme accent. */
	sessionKey?: string;
}): ReactNode {
	const [phase, setPhase] = useState<"idle" | "thinking" | "done">("idle");
	const [braille, setBraille] = useState(0);
	// Phase transitions are pure state changes; the idle-revert timer lives
	// in its OWN effect so the re-render triggered by thinking→done (which
	// re-runs this effect and its cleanup) cannot clear the timer it just
	// set — the old shape left "思考完毕" pinned forever after a stop.
	useEffect(() => {
		if (working) {
			setPhase("thinking");
		} else if (phase === "thinking") {
			setPhase("done");
		}
	}, [working, phase]);
	// "done" reverts to idle after a beat (keeps the static ⠿ ack visible).
	useEffect(() => {
		if (phase !== "done") return;
		const id = window.setTimeout(() => setPhase("idle"), 1500);
		return () => clearTimeout(id);
	}, [phase]);
	// Braille frame clock — only while thinking; "done" holds a static ⠿.
	useEffect(() => {
		if (phase !== "thinking") return;
		const id = window.setInterval(() => setBraille(i => (i + 1) % BRAILLE_FRAMES.length), 80);
		return () => clearInterval(id);
	}, [phase]);
	if (phase === "idle") return null;
	const accent = sessionKey ? sessionAccentHex(sessionKey) : null;
	return (
		<div
			className={`gui-agent-status gui-agent-status--${effect}${
				sweepColor === "accent" ? " gui-agent-status--sweep-accent" : ""
			}`}
			style={accent ? ({ "--gui-status-accent": accent } as CSSProperties) : undefined}
		>
			{indicator === "orb" ? (
				<span className="gui-agent-status-orb" aria-hidden />
			) : indicator === "lattice" ? (
				<span className="gui-agent-status-lattice" aria-hidden>
					<i />
					<i />
					<i />
					<i />
					<i />
					<i />
					<i />
					<i />
					<i />
				</span>
			) : indicator === "ring" ? (
				<span className="gui-agent-status-ring" aria-hidden>
					<i />
					<i />
					<i />
					<i />
					<i />
					<i />
					<i />
					<i />
				</span>
			) : (
				<span className="gui-agent-status-braille" aria-hidden>
					{phase === "thinking" ? BRAILLE_FRAMES[braille] : "⠿"}
				</span>
			)}
			<span className="gui-agent-status-text">
				{phase === "thinking" ? t("agent is thinking…") : t("thinking complete")}
			</span>
		</div>
	);
}

/**
 * Compaction status line — replaces the agent status line while the
 * session context is being compacted (manual ring action or daemon auto
 * compaction). Same floating chip above the input card, plus a stop
 * button: the TUI's Esc path (session.abort → AgentSession.abort →
 * abortCompaction) without a confirm — compaction is cheap to re-run.
 */
export function CompactionStatusLine({ onCancel }: { onCancel(): void }): ReactNode {
	const [braille, setBraille] = useState(0);
	useEffect(() => {
		const id = window.setInterval(() => setBraille(i => (i + 1) % BRAILLE_FRAMES.length), 80);
		return () => clearInterval(id);
	}, []);
	return (
		<div className="gui-compact-line" role="status" aria-live="polite">
			<span className="gui-agent-status-braille" aria-hidden>
				{BRAILLE_FRAMES[braille]}
			</span>
			<span className="gui-compact-line-text">{t("compacting…")}</span>
			<button
				type="button"
				className="gui-compact-line-stop"
				onClick={onCancel}
				title={t("stop compaction")}
				aria-label={t("stop compaction")}
			>
				<Square size={11} fill="currentColor" />
			</button>
		</div>
	);
}
