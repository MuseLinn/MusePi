import { t } from "@musepi/client-core";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useState } from "react";
import { THINKING_LEVELS, thinkingLabel } from "./thinking-selector-shared";

/**
 * Thinking-effort ladder slider.
 *
 * One discrete track over the current model's REAL efforts plus `auto` (and
 * `off` when the model has a ladder to turn off). The knob follows the drag;
 * only the release writes — a slider that committed every pointer tick would
 * send one RPC per pixel and race its own optimistic state.
 *
 * `ceiling` is the model's top supported rung: rungs above it stay visible,
 * struck through, and neither the draft nor the commit can land on them, so the
 * model's limit is readable instead of silently missing.
 */

interface LadderRung {
	/** Wire level; null is `off`. */
	level: string | null;
	label: string;
	/** Above the model's ceiling — visible, unreachable. */
	capped: boolean;
	/** The `auto` rung (classified per turn by the daemon). */
	auto: boolean;
}

function ladderRungs(
	efforts: readonly string[],
	ceiling: string | null | undefined,
	labelFor: (level: string | null) => string,
): LadderRung[] {
	const ceilingIndex = ceiling ? efforts.indexOf(ceiling) : -1;
	const cappedFrom = ceilingIndex === -1 ? efforts.length : ceilingIndex + 1;
	const rungs: LadderRung[] = [{ level: null, label: labelFor(null), capped: false, auto: false }];
	efforts.forEach((level, index) => {
		rungs.push({
			level,
			label: labelFor(level),
			capped: index >= cappedFrom,
			auto: false,
		});
	});
	rungs.push({ level: "auto", label: t("transcript.thinkingAuto"), capped: false, auto: true });
	return rungs;
}

/** Index of `value` on the rung list; an unknown level falls back to `off`. */
function ladderIndex(rungs: readonly LadderRung[], value: string | null | undefined): number {
	if (value == null) return 0;
	const index = rungs.findIndex(rung => rung.level === value);
	return index === -1 ? 0 : index;
}

/** Nearest reachable rung at or below `index` — moving right into a capped
 *  rung settles on the ceiling, moving left is untouched. `auto` is always
 *  reachable and sits past every effort, so it is never clamped. */
function clampLadderIndex(rungs: readonly LadderRung[], index: number): number {
	const bounded = Math.min(Math.max(Math.round(index), 0), rungs.length - 1);
	if (!rungs[bounded]?.capped) return bounded;
	let settled = bounded;
	while (settled > 0 && rungs[settled]?.capped) settled -= 1;
	return settled;
}

/** A configured level folded onto the model's real ladder. An unsupported
 *  rung settles on the nearest supported one below it (never above the
 *  model's ceiling); with no ladder at all the level is off. */
export function clampLadderValue(
	efforts: readonly string[],
	ceiling: string | null | undefined,
	value: string | null | undefined,
): string | null {
	if (value == null) return null;
	if (value === "auto") return "auto";
	if (efforts.length === 0) return null;
	const ceilingIndex = ceiling ? efforts.indexOf(ceiling) : -1;
	const allowed = ceilingIndex === -1 ? efforts : efforts.slice(0, ceilingIndex + 1);
	if (allowed.includes(value)) return value;
	const order = THINKING_LEVELS.indexOf(value as (typeof THINKING_LEVELS)[number]);
	let settled = allowed[0] ?? null;
	for (const level of allowed) {
		if (order === -1 || THINKING_LEVELS.indexOf(level as (typeof THINKING_LEVELS)[number]) <= order) settled = level;
	}
	return settled;
}

interface LadderSliderProps {
	/** The current model's supported efforts, lowest first. Empty means the
	 *  model has no thinking ladder. */
	efforts: readonly string[];
	/** Configured state: an effort, `auto`, or null for off. */
	value: string | null | undefined;
	/** Effort `auto` resolved to for the current turn — the secondary readout. */
	resolved?: string | null;
	/** Model's top supported rung. */
	ceiling?: string | null;
	disabled?: boolean;
	onCommit(level: string | null): void;
}

export function LadderSlider({
	efforts,
	value,
	resolved = null,
	ceiling = null,
	disabled = false,
	onCommit,
}: LadderSliderProps): ReactNode {
	const rungs = ladderRungs(efforts, ceiling, thinkingLabel);
	const committed = ladderIndex(rungs, value);
	const [draft, setDraft] = useState(committed);
	const [dragging, setDragging] = useState(false);

	useEffect(() => {
		if (!dragging) setDraft(committed);
	}, [committed, dragging]);

	if (efforts.length === 0) {
		return <p className="gui-agent-info-note">{t("general.agentInfoThinkingUnsupported")}</p>;
	}

	const rung = rungs[draft] ?? rungs[0]!;
	const commit = (): void => {
		if (dragging) setDragging(false);
		const settled = clampLadderIndex(rungs, draft);
		if (settled !== draft) setDraft(settled);
		const next = rungs[settled]?.level ?? null;
		if (next !== (value ?? null)) onCommit(next);
	};
	// A cancelled drag never commits: drop the draft and let the committed
	// value drive the knob again (the following blur then sees no change).
	const cancel = (): void => {
		if (!dragging) return;
		setDragging(false);
		setDraft(committed);
	};
	return (
		<div className="gui-ladder" data-disabled={disabled ? "true" : undefined}>
			<input
				type="range"
				className="gui-ladder-range"
				min={0}
				max={rungs.length - 1}
				step={1}
				value={draft}
				disabled={disabled}
				aria-label={t("general.agentInfoThinking")}
				aria-valuetext={rung.label}
				style={
					{
						"--gui-ladder-fill": `${(draft / Math.max(1, rungs.length - 1)) * 100}%`,
					} as CSSProperties
				}
				onChange={event => {
					setDragging(true);
					setDraft(Number(event.currentTarget.value));
				}}
				onPointerUp={commit}
				onPointerCancel={cancel}
				onLostPointerCapture={cancel}
				onKeyUp={commit}
				onBlur={commit}
			/>
			<div className="gui-ladder-ticks" aria-hidden="true">
				{rungs.map((item, index) => (
					<span
						key={item.level ?? "off"}
						className={`gui-ladder-tick${index === draft ? " gui-ladder-tick--on" : ""}${item.capped ? " gui-ladder-tick--capped" : ""}`}
					>
						{item.label}
					</span>
				))}
			</div>
			{rung.auto && resolved ? (
				<p className="gui-agent-info-note gui-ladder-resolved">{thinkingLabel(resolved)}</p>
			) : null}
			{rungs.some(item => item.capped) && ceiling ? (
				<p className="gui-agent-info-note">
					{`${t("transcript.thinkingCappedModel")} · ${t("transcript.modelCap")} ${thinkingLabel(ceiling)}`}
				</p>
			) : null}
		</div>
	);
}
