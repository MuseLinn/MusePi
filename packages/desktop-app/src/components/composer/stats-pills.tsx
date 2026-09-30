import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { memo, useState, useSyncExternalStore } from "react";
import {
	billedTotalTokens,
	cacheHitPercent,
	decodeTokensPerSecond,
	formatDurationMs,
	formatTokenCount,
	hasAnyTiming,
	hasTokenActivity,
	type StatsRowProps,
	statsRowPropsEqual,
} from "../../lib/derive-window-stats";
import { useFloatingMenu } from "../../lib/use-floating-menu";
import { Icon } from "../../vendor/oc-icons";
import { formatSpend } from "../ContextRing";

/**
 * Composer「性能与用量」统计行 (gui-design.md §5w, dsh StatsPills parity).
 * Two pills ride below the composer footer row; the ContextRing stays in the
 * capsule row above. Token figures come from the durable
 * `session.contextUsage` projection (never paging/compaction sensitive);
 * time figures come from the visible-window fold (`deriveWindowStats`).
 *
 * memo contract: the comparator is field-equality on the derived numbers, so
 * a stream delta (fresh entries array, identical figures) does NOT re-render
 * the row — that is the streaming guard tested in derive-window-stats.test.ts.
 */

export const STATS_MODE_KEY = "musepi-gui-stats-mode";
export const STATS_MODE_EVENT = "musepi-stats-mode-changed";

function readStatsMode(): "detailed" | "compact" {
	try {
		return localStorage.getItem(STATS_MODE_KEY) === "compact" ? "compact" : "detailed";
	} catch {
		return "detailed";
	}
}

function subscribeStatsMode(onChange: () => void): () => void {
	const onEvent = (): void => onChange();
	window.addEventListener(STATS_MODE_EVENT, onEvent);
	window.addEventListener("storage", onEvent);
	return () => {
		window.removeEventListener(STATS_MODE_EVENT, onEvent);
		window.removeEventListener("storage", onEvent);
	};
}

/** The 简洁/详细 pref — renderer-local (§5w), mirrored by the settings row. */
export function useStatsMode(): "detailed" | "compact" {
	return useSyncExternalStore(subscribeStatsMode, readStatsMode, () => "detailed");
}

/** One popover's rows — the shared .gui-menu-popup shell carries the glass. */
function StatsPop({
	title,
	icon,
	children,
}: {
	title: string;
	icon: "timer" | "database-2";
	children: ReactNode;
}): ReactNode {
	return (
		<div className="gui-stats-pop" role="dialog" aria-label={title}>
			<div className="gui-context-pop-title">
				<Icon name={icon} className="h-3.5 w-3.5" />
				{title}
			</div>
			{children}
		</div>
	);
}

function PopRow({ label, value }: { label: string; value: string }): ReactNode {
	return (
		<div className="gui-context-pop-row">
			<span>{label}</span>
			<span className="gui-context-pop-val">{value}</span>
		</div>
	);
}

function TimePill({ stats }: { stats: StatsRowProps["stats"] }): ReactNode {
	const [open, setOpen] = useState(false);
	const { anchorRef, renderMenu } = useFloatingMenu(open, setOpen);
	const tps = decodeTokensPerSecond(stats);
	const counts = t("stats turns steps", { turns: String(stats.turns), steps: String(stats.steps) });
	const label = (
		<span className="gui-stats-pill-label">
			{counts}
			{tps !== null && (
				<>
					<span className="gui-stats-pill-sep" aria-hidden>
						·
					</span>
					{`${tps.toFixed(1)} tok/s`}
				</>
			)}
		</span>
	);
	// No timed figure in the window → plain reading, no popover (dsh contract).
	if (!hasAnyTiming(stats)) {
		return (
			<span className="gui-stats-pill">
				<Icon name="timer" className="h-3 w-3" />
				{label}
			</span>
		);
	}
	return (
		<span ref={anchorRef} className="gui-stats-anchor">
			<button
				type="button"
				className="gui-stats-pill"
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-label={tps === null ? counts : `${counts} · ${tps.toFixed(1)} tok/s`}
				onClick={() => setOpen(v => !v)}
			>
				<Icon name="timer" className="h-3 w-3" />
				{label}
			</button>
			{renderMenu(
				<StatsPop title={counts} icon="timer">
					{stats.llmMs > 0 && <PopRow label={t("stats model time")} value={formatDurationMs(stats.llmMs)} />}
					{stats.toolMs > 0 && <PopRow label={t("stats tool time")} value={formatDurationMs(stats.toolMs)} />}
					{stats.ttftSteps > 0 && (
						<PopRow label={t("avg ttft")} value={formatDurationMs(stats.ttftMs / stats.ttftSteps)} />
					)}
					{tps !== null && <PopRow label={t("tokens per second")} value={`${tps.toFixed(1)} tok/s`} />}
				</StatsPop>,
			)}
		</span>
	);
}

function UsagePill({ usage }: { usage: NonNullable<StatsRowProps["usage"]> }): ReactNode {
	const [open, setOpen] = useState(false);
	const { anchorRef, renderMenu } = useFloatingMenu(open, setOpen);
	const total = billedTotalTokens(usage);
	const totalText = t("stats total tokens", { tokens: formatTokenCount(total) });
	const hit = cacheHitPercent(usage);
	return (
		<span ref={anchorRef} className="gui-stats-anchor">
			<button
				type="button"
				className="gui-stats-pill"
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-label={hit === null ? totalText : `${totalText} · ${t("cache hit")} ${hit}%`}
				onClick={() => setOpen(v => !v)}
			>
				<Icon name="database-2" className="h-3 w-3" />
				<span className="gui-stats-pill-label">
					{totalText}
					{hit !== null && (
						<>
							<span className="gui-stats-pill-sep" aria-hidden>
								·
							</span>
							{`${t("cache hit")} ${hit}%`}
						</>
					)}
				</span>
			</button>
			{renderMenu(
				<StatsPop title={totalText} icon="database-2">
					{hit !== null && <PopRow label={t("cache hit")} value={`${hit}%`} />}
					{usage.input > usage.cacheRead && (
						<PopRow label={t("uncached input tokens")} value={formatTokenCount(usage.input - usage.cacheRead)} />
					)}
					<PopRow label={t("input tokens")} value={formatTokenCount(usage.input)} />
					<PopRow label={t("cache read tokens")} value={formatTokenCount(usage.cacheRead)} />
					{usage.cacheWrite !== 0 && (
						<PopRow label={t("cache write tokens")} value={formatTokenCount(usage.cacheWrite)} />
					)}
					<PopRow label={t("output tokens")} value={formatTokenCount(usage.output)} />
					{usage.cost > 0 && <PopRow label={t("session spend")} value={formatSpend(usage.cost)} />}
				</StatsPop>,
			)}
		</span>
	);
}

export const StatsPillsRow = memo(function StatsPillsRow({ stats, usage, mode }: StatsRowProps): ReactNode {
	const tps = decodeTokensPerSecond(stats);
	if (mode === "compact") {
		// Compact = two plain readings only (speed + cache hit); no popovers.
		const hit = hasTokenActivity(usage) ? cacheHitPercent(usage as NonNullable<StatsRowProps["usage"]>) : null;
		if (tps === null && hit === null) return null;
		return (
			<div className="gui-stats-row" data-composer-stats="">
				{tps !== null && (
					<span className="gui-stats-pill">
						<Icon name="timer" className="h-3 w-3" />
						{`${tps.toFixed(1)} tok/s`}
					</span>
				)}
				{hit !== null && (
					<span className="gui-stats-pill">
						<Icon name="database-2" className="h-3 w-3" />
						{`${t("cache hit")} ${hit}%`}
					</span>
				)}
			</div>
		);
	}
	if (stats.steps === 0 && !hasTokenActivity(usage)) return null;
	return (
		<div className="gui-stats-row" data-composer-stats="">
			{stats.steps > 0 && <TimePill stats={stats} />}
			{hasTokenActivity(usage) && <UsagePill usage={usage as NonNullable<StatsRowProps["usage"]>} />}
		</div>
	);
}, statsRowPropsEqual);
