import { t } from "@musepi/desktop-web";
import { SlidingNumber } from "@musepi/desktop-web/src/lib/sliding-number";
import { CountUp } from "@musepi/desktop-web/src/widgets/count-up";
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

/** Provider subscription quota (TUI /usage parity) shown in the popover
 *  next to the token breakdown. Same-provider credentials merge into
 *  side-by-side columns with the aggregate at the far right (the tray /
 *  TUI /usage treatment — several opencode-go credentials no longer show
 *  as an ambiguous flattened list). */
export interface UsageQuotaView {
	providers: Array<{
		provider: string;
		/** Per limit-window: one column per credential + trailing total. */
		windows: Array<{
			label: string;
			resetsIn?: string;
			cells: Array<{ cred: string; usedPercent: number; resetsIn?: string }>;
		}>;
	}>;
}

/** Bar tone for the popover quota meters (err ≥85%, warn ≥50%). */
function quotaTone(usedPercent: number): string {
	if (usedPercent >= 85) return "gui-usage-bar--err";
	if (usedPercent >= 50) return "gui-usage-bar--warn";
	return "gui-usage-bar--ok";
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
	fetchQuota,
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
	/** Provider subscription quota (TUI /usage parity) — fetched lazily
	 *  when the popover opens; null/undefined hides the block. */
	fetchQuota?: () => Promise<UsageQuotaView | null>;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const [quota, setQuota] = useState<UsageQuotaView | null>(null);
	const [quotaLoading, setQuotaLoading] = useState(false);
	const { anchorRef, renderMenu } = useFloatingMenu(open, setOpen);
	useEffect(() => {
		// Close when the data disappears (session gone).
		if (percent == null) setOpen(false);
	}, [percent]);
	// Subscription quota is fetched lazily on first popover open (the
	// provider call is a network round-trip — don't pay it on mount).
	useEffect(() => {
		if (!open || !fetchQuota) return;
		let cancelled = false;
		setQuotaLoading(true);
		void fetchQuota()
			.then(v => {
				if (!cancelled) setQuota(v);
			})
			.catch(() => {
				if (!cancelled) setQuota(null);
			})
			.finally(() => {
				if (!cancelled) setQuotaLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, fetchQuota]);

	const pct = percent ?? 0;
	// The arc clamps at 100% (a full ring), but the displayed numbers keep
	// the REAL value: a big-window model switched to a small one can exceed
	// its window, and showing "100%" would hide the overflow (TUI shows the
	// true "123.4%/200K" + error color).
	const clamped = Math.min(100, Math.max(0, pct));
	const tone = clamped >= 90 ? "danger" : clamped >= 70 ? "warn" : "ok";
	const color =
		tone === "danger" ? "var(--color-danger)" : tone === "warn" ? "var(--color-warning)" : "var(--color-ok)";
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
				title={`${t("context usage")} · ${Math.round(pct)}%`}
				aria-label={`${t("context usage")} · ${Math.round(pct)}%`}
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
							<SlidingNumber value={Math.round(pct)} />%
						</span>
					</div>
					{pct > 100 && (
						<div className="gui-context-pop-note" style={{ color: "var(--color-danger)" }}>
							{t("context over window")} — {t("over window: compact or switch to a larger-context model")}
						</div>
					)}
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
					{quotaLoading ? (
						<div className="gui-context-pop-quota">
							<div className="gui-context-pop-quota-title">{t("subscription usage")}</div>
							<div className="gui-context-pop-note">…</div>
						</div>
					) : quota && quota.providers.length > 0 ? (
						<div className="gui-context-pop-quota">
							<div className="gui-context-pop-quota-title">{t("subscription usage")}</div>
							{quota.providers.map(provider => (
								<div key={provider.provider} className="gui-context-pop-provider">
									<div className="gui-context-pop-provider-name">{provider.provider}</div>
									{provider.windows.map((win, wi) => {
										const avg =
											win.cells.reduce((sum, cell) => sum + cell.usedPercent, 0) /
											Math.max(1, win.cells.length);
										const cols = `${win.cells.map(() => "minmax(0, 1fr)").join(" ")} 44px`;
										const resetsIn = win.cells.find(cell => cell.resetsIn)?.resetsIn;
										return (
											<div key={`${win.label}|${wi}`} className="gui-context-pop-window">
												<div className="gui-context-pop-window-label">
													{win.label}
													{resetsIn ? ` · resets in ${resetsIn}` : ""}
												</div>
												<div className="gui-context-pop-cols" style={{ gridTemplateColumns: cols }}>
													{win.cells.slice(0, 4).map((cell, ci) => (
														<div
															key={`${provider.provider}|${wi}|${ci}:${cell.cred}`}
															className="gui-context-pop-cell"
															title={cell.cred}
														>
															<div className="gui-context-pop-cell-label">{cell.cred}</div>
															<div className="gui-usage-bar-track">
																<div
																	className={`gui-usage-bar ${quotaTone(cell.usedPercent)}`}
																	style={{ width: `${Math.min(100, Math.max(0, cell.usedPercent))}%` }}
																/>
															</div>
															<div className="gui-context-pop-cell-pct">
																{Math.round(cell.usedPercent)}%
															</div>
														</div>
													))}
													<div className="gui-context-pop-cell gui-context-pop-cell--total">
														<div className="gui-context-pop-cell-label">{t("total")}</div>
														<div className="gui-usage-bar-track">
															<div
																className={`gui-usage-bar ${quotaTone(avg)}`}
																style={{ width: `${Math.min(100, Math.max(0, avg))}%` }}
															/>
														</div>
														<div className="gui-context-pop-cell-pct">{Math.round(avg)}%</div>
													</div>
												</div>
											</div>
										);
									})}
								</div>
							))}
						</div>
					) : null}
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
