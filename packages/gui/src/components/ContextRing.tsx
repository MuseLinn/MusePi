import { t } from "@musepi/collab-web";
import { CountUp } from "@musepi/collab-web/src/widgets/count-up";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useFloatingMenu } from "../lib/use-floating-menu";
import { Icon } from "../vendor/oc-icons";

/** Snapcompact wire-savings estimate (TUI /context parity) — wire shape
 *  of `SnapcompactSavingsEstimate` served by session.contextUsage. */
export interface SnapcompactSavingsView {
	visionCapable: boolean;
	systemPrompt?: {
		applied: boolean;
		reason?: "empty" | "margin" | "budget";
		textTokens: number;
		frames: number;
		imageTokens: number;
		savedTokens: number;
		scope: string;
	};
	toolResults?: {
		total: number;
		swapped: number;
		textTokens: number;
		frames: number;
		imageTokens: number;
		savedTokens: number;
	};
	savedTokens: number;
}

/**
 * Context-window usage ring (kimi-code-web / openchamber parity): a
 * conic-gradient donut showing the live session's context percentage,
 * colored by utilization (ok / warn / danger). Hovering or focusing it
 * opens a popover with the exact token breakdown — and, when the caller
 * supplies `onCompact`, a compact-context action right in the card.
 */
export function ContextRing({
	percent,
	tokens,
	contextWindow,
	onCompact,
	compacting = false,
	compactFailed = false,
	snapcompact = null,
}: {
	percent: number | null | undefined;
	tokens: number | null | undefined;
	contextWindow: number | null | undefined;
	/** Shows a "压缩上下文" button in the popover (TUI /compact parity). */
	onCompact?: () => void;
	/** Compaction in flight — disables the action and shows progress. */
	compacting?: boolean;
	/** Last compaction attempt failed — danger styling, transient. */
	compactFailed?: boolean;
	/** Snapcompact estimated wire savings (TUI /context parity); null/undefined hides the block. */
	snapcompact?: SnapcompactSavingsView | null;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const { anchorRef, renderMenu } = useFloatingMenu(open, setOpen);
	useEffect(() => {
		// Close when the data disappears (session gone).
		if (percent == null) setOpen(false);
	}, [percent]);

	const pct = percent ?? 0;
	const clamped = Math.min(100, Math.max(0, pct));
	const tone = clamped >= 90 ? "danger" : clamped >= 70 ? "warn" : "ok";
	const color = `var(--${tone === "ok" ? "color-ok" : "color-warning"})`;
	const radius = 8;
	const circumference = 2 * Math.PI * radius;
	const dash = (clamped / 100) * circumference;

	const fmtTokens = (n: number | null | undefined): string => {
		if (n == null) return "—";
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 1000) return `${Math.round(n / 1000)}K`;
		return String(n);
	};

	return (
		<div className="gui-context-ring" ref={anchorRef}>
			<button
				type="button"
				className="gui-context-ring-btn"
				title={`${t("context usage")} · ${Math.round(clamped)}%`}
				aria-label={`${t("context usage")} · ${Math.round(clamped)}%`}
				aria-expanded={open}
				onClick={() => setOpen(v => !v)}
			>
				<svg width="20" height="20" viewBox="0 0 20 20" className="gui-context-ring-svg">
					<circle cx="10" cy="10" r={radius} fill="none" stroke="var(--border)" strokeWidth="2.5" />
					<circle
						cx="10"
						cy="10"
						r={radius}
						fill="none"
						stroke={color}
						strokeWidth="2.5"
						strokeLinecap="round"
						strokeDasharray={`${dash} ${circumference - dash}`}
						transform="rotate(-90 10 10)"
						className="gui-context-ring-arc"
					/>
				</svg>
			</button>
			{renderMenu(
				<div className="gui-context-pop" role="tooltip">
					<div className="gui-context-pop-title">{t("context usage")}</div>
					<div className="gui-context-pop-row">
						<span>{t("used")}</span>
						<span className="gui-context-pop-val">
							{tokens != null ? <CountUp value={tokens} format={fmtTokens} /> : "—"}
						</span>
					</div>
					<div className="gui-context-pop-row">
						<span>{t("window")}</span>
						<span className="gui-context-pop-val">
							{contextWindow != null ? <CountUp value={contextWindow} format={fmtTokens} /> : "—"}
						</span>
					</div>
					<div className="gui-context-pop-row">
						<span>{t("utilization")}</span>
						<span className="gui-context-pop-val" style={{ color }}>
							{Math.round(clamped)}%
						</span>
					</div>
					{snapcompact && (
						<div className="gui-context-pop-snap">
							<div className="gui-context-pop-row">
								<span>{t("snapcompact savings")}</span>
								<span className="gui-context-pop-val">
									{snapcompact.visionCapable ? `~${fmtTokens(snapcompact.savedTokens)}` : "—"}
								</span>
							</div>
							{!snapcompact.visionCapable ? (
								<div className="gui-context-pop-note">{t("model does not support images")}</div>
							) : (
								<>
									{snapcompact.systemPrompt && (
										<div className="gui-context-pop-note">
											{snapcompact.systemPrompt.applied
												? t("system prompt imaged: {text} text → {frames} frames (saves ~{saved})", {
														text: fmtTokens(snapcompact.systemPrompt.textTokens),
														frames: String(snapcompact.systemPrompt.frames),
														saved: fmtTokens(snapcompact.systemPrompt.savedTokens),
													})
												: t("system prompt stays text ({reason})", {
														reason: t(
															snapcompact.systemPrompt.reason === "empty"
																? "reason: empty"
																: snapcompact.systemPrompt.reason === "margin"
																	? "reason: insufficient savings"
																	: "reason: image budget",
														),
													})}
										</div>
									)}
									{snapcompact.toolResults && snapcompact.toolResults.swapped > 0 && (
										<div className="gui-context-pop-note">
											{t("tool results: {imaged} imaged (saves ~{saved})", {
												imaged: String(snapcompact.toolResults.swapped),
												saved: fmtTokens(snapcompact.toolResults.savedTokens),
											})}
										</div>
									)}
								</>
							)}
						</div>
					)}
					{onCompact && (
						<button
							type="button"
							className={`gui-context-pop-action${compactFailed ? " gui-context-pop-action--danger" : ""}`}
							onClick={onCompact}
							disabled={compacting}
							title={compactFailed ? t("compaction failed") : t("compact context")}
							aria-label={t("compact context")}
						>
							<Icon name="collapse-vertical" className="h-3.5 w-3.5" />
							<span>{compacting ? t("compacting…") : t("compact context")}</span>
						</button>
					)}
				</div>,
			)}
		</div>
	);
}
