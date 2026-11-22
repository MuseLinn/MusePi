import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { formatTokenCount } from "../../lib/format-tokens";

/** Effective auto-compaction policy for the live session (session.contextUsage).
 *  `thresholdPercent` is where compaction fires as a share of the current
 *  model's window; `thresholdValuePercent` is the explicitly configured value
 *  the slider rests on (null while the legacy reserve policy decides). */
export interface CompactionThresholdView {
	thresholdTokens?: number | null;
	thresholdPercent?: number | null;
	thresholdMode?: "auto" | "percent" | "fixed" | null;
	thresholdScope?: "global" | "model" | null;
	thresholdValuePercent?: number | null;
	thresholdModelKey?: string | null;
}

const MIN_PERCENT = 1;
const MAX_PERCENT = 99;

function clampPercent(value: number): number {
	return Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, Math.round(value)));
}

/**
 * Auto-compaction trigger as a percentage of the context window, adjustable
 * in place (Kiro Crew parity): a percent threshold scales with whatever
 * model the session uses, unlike a fixed token cap. Changing it writes the
 * layer that actually governs this session — the per-model entry when one
 * is in force, the global setting otherwise — so the readout never claims a
 * value the agent will not apply.
 */
export function AutoCompactThresholdControl({
	view,
	busy = false,
	error = null,
	onChange,
	onReset,
	onSwitchToPercent,
}: {
	view: CompactionThresholdView | null | undefined;
	busy?: boolean;
	/** Write failure text; the control shows it instead of silently snapping back. */
	error?: string | null;
	onChange(percent: number): void;
	/** Clear a configured percentage so the policy decides (or, for a model
	 *  entry, follow the global setting again). */
	onReset(): void;
	/** Replace a fixed token trigger with the equivalent percentage. */
	onSwitchToPercent(percent: number): void;
}): ReactNode {
	const mode = view?.thresholdMode ?? null;
	const effective = view?.thresholdPercent ?? null;
	const seedPercent = view?.thresholdValuePercent ?? effective;
	const seed = seedPercent == null ? null : clampPercent(seedPercent);
	const [draft, setDraft] = useState<number | null>(seed);
	const dirtyRef = useRef(false);

	useEffect(() => {
		setDraft(seed);
		dirtyRef.current = false;
	}, [seed]);

	if (mode == null || effective == null) return null;

	if (mode === "fixed") {
		const percent = clampPercent(effective);
		return (
			<div className="gui-context-threshold">
				<div className="gui-context-pop-row">
					<span>{t("general.autoCompactThreshold")}</span>
					<span className="gui-context-pop-val">
						{t("general.autoCompactFixedValue", { tokens: formatTokenCount(view?.thresholdTokens) })}
					</span>
				</div>
				<div className="gui-context-pop-note">{t("general.autoCompactFixedNote", { percent: `${percent}%` })}</div>
				<div className="gui-context-threshold-actions">
					<button
						type="button"
						className="gui-context-threshold-link"
						disabled={busy}
						onClick={() => onSwitchToPercent(percent)}
					>
						{t("general.autoCompactSwitchToPercent")}
					</button>
				</div>
				{error && (
					<div className="gui-context-threshold-error" role="alert">
						{error}
					</div>
				)}
			</div>
		);
	}

	const shown = draft ?? seed ?? clampPercent(effective);
	const valueLabel =
		mode === "auto"
			? t("general.autoCompactAutoValue", { percent: `${Math.round(effective)}%` })
			: view?.thresholdScope === "model"
				? t("general.autoCompactModelValue", { percent: `${shown}%` })
				: `${shown}%`;
	const canReset = mode === "percent" || view?.thresholdScope === "model";
	const resetLabel =
		view?.thresholdScope === "model" ? t("general.autoCompactFollowGlobal") : t("general.autoCompactResetAuto");

	const commit = (): void => {
		if (!dirtyRef.current || busy) return;
		dirtyRef.current = false;
		const next = clampPercent(draft ?? shown);
		if (next !== shown) setDraft(next);
		onChange(next);
	};

	return (
		<div className="gui-context-threshold">
			<div className="gui-context-pop-row">
				<span>{t("general.autoCompactThreshold")}</span>
				<span className="gui-context-pop-val">
					{valueLabel}
					<span className="gui-context-threshold-tokens"> · {formatTokenCount(view?.thresholdTokens)}</span>
				</span>
			</div>
			<input
				type="range"
				className="gui-range gui-context-threshold-range"
				min={MIN_PERCENT}
				max={MAX_PERCENT}
				step={1}
				value={shown}
				disabled={busy}
				aria-label={t("general.autoCompactThreshold")}
				onChange={event => {
					dirtyRef.current = true;
					setDraft(Number(event.target.value));
				}}
				onPointerUp={commit}
				onKeyUp={commit}
				onBlur={commit}
			/>
			<div className="gui-context-pop-note">{t("general.autoCompactHint")}</div>
			{canReset && (
				<div className="gui-context-threshold-actions">
					<button type="button" className="gui-context-threshold-link" disabled={busy} onClick={onReset}>
						{resetLabel}
					</button>
				</div>
			)}
			{error && (
				<div className="gui-context-threshold-error" role="alert">
					{error}
				</div>
			)}
		</div>
	);
}
