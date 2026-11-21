import { t } from "@musepi/client-core";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
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
 *
 * The track is the shared slider primitive (`.gui-slider`, `--gui-slider-*`):
 * the same rail, fill, detents and knob as the settings detent ladder, with the
 * ladder labels below because a thinking level is read as a word, not a value.
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
	const [draft, setDraftState] = useState(committed);
	const [dragging, setDragging] = useState(false);
	const trackRef = useRef<HTMLDivElement | null>(null);
	// The rail is the laid-out span between the two end stops: `--gui-slider-inset`
	// insets it in CSS, so measuring it keeps the knob size out of the pointer
	// math instead of restating half of it here.
	const railRef = useRef<HTMLSpanElement | null>(null);
	const dragRef = useRef<{ pointerId: number } | null>(null);
	// The pointer sequence reads the draft between renders: `pointerup` can
	// arrive in the same tick as its `pointerdown` (a click without a move),
	// before React has re-rendered from the press. The ref is the source of
	// truth so that release commits the rung the press landed on.
	const draftRef = useRef(draft);
	const applyDraft = useCallback((next: number): void => {
		draftRef.current = next;
		setDraftState(next);
	}, []);

	useEffect(() => {
		if (!dragging) applyDraft(committed);
	}, [committed, dragging, applyDraft]);

	if (efforts.length === 0) {
		return <p className="gui-agent-info-note">{t("general.agentInfoThinkingUnsupported")}</p>;
	}

	const last = Math.max(1, rungs.length - 1);
	const rung = rungs[draft] ?? rungs[0]!;

	const write = (index: number): void => {
		const settled = clampLadderIndex(rungs, index);
		dragRef.current = null;
		setDragging(false);
		applyDraft(settled);
		const next = rungs[settled]?.level ?? null;
		if (next !== (value ?? null)) onCommit(next);
	};
	// A cancelled drag never commits: drop the draft and let the committed
	// value drive the knob again. `lostpointercapture` also fires after a
	// normal release, so a settled drag is left alone (its commit owns the
	// knob from here).
	const cancel = (): void => {
		if (!dragRef.current) return;
		dragRef.current = null;
		setDragging(false);
		applyDraft(committed);
	};
	/** Pointer x → nearest rung, or null while the rail has no laid-out width
	 *  (the first frame, a hidden panel). The rail already excludes the knob
	 *  inset, so its rect is exactly the travel span. */
	const indexAt = (clientX: number): number | null => {
		const rect = railRef.current?.getBoundingClientRect();
		if (!rect || rect.width <= 0) return null;
		const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
		return Math.round(ratio * last);
	};

	return (
		<div className="gui-slider" data-disabled={disabled ? "true" : undefined}>
			<div className="gui-slider-head">
				<span className="gui-slider-value">{rung.label}</span>
				{rung.auto && resolved ? (
					<span className="gui-slider-resolved">{`${t("transcript.thinkingAuto")} · ${thinkingLabel(resolved)}`}</span>
				) : null}
			</div>
			<div
				ref={trackRef}
				className="gui-slider-track"
				role="slider"
				tabIndex={disabled ? -1 : 0}
				aria-label={t("general.agentInfoThinking")}
				aria-disabled={disabled || undefined}
				aria-valuemin={0}
				aria-valuemax={last}
				aria-valuenow={draft}
				aria-valuetext={rung.label}
				data-dragging={dragging ? "" : undefined}
				style={{ "--gui-slider-p": draft / last } as CSSProperties}
				onPointerDown={event => {
					if (disabled || event.button !== 0) return;
					event.preventDefault();
					try {
						event.currentTarget.setPointerCapture?.(event.pointerId);
					} catch {
						/* capture is best-effort; the release still commits */
					}
					dragRef.current = { pointerId: event.pointerId };
					setDragging(true);
					const next = indexAt(event.clientX);
					if (next != null) applyDraft(clampLadderIndex(rungs, next));
					event.currentTarget.focus();
				}}
				onPointerMove={event => {
					const drag = dragRef.current;
					if (!drag || drag.pointerId !== event.pointerId) return;
					const next = indexAt(event.clientX);
					if (next == null) return;
					const settled = clampLadderIndex(rungs, next);
					if (settled !== draftRef.current) applyDraft(settled);
				}}
				onPointerUp={event => {
					const drag = dragRef.current;
					if (!drag || drag.pointerId !== event.pointerId) return;
					write(draftRef.current);
				}}
				onPointerCancel={cancel}
				onLostPointerCapture={cancel}
				onKeyDown={event => {
					if (disabled) return;
					const step: Record<string, number> = {
						ArrowLeft: -1,
						ArrowDown: -1,
						ArrowRight: 1,
						ArrowUp: 1,
					};
					let next: number | null = null;
					const delta = step[event.key];
					if (delta !== undefined) next = draftRef.current + delta;
					else if (event.key === "Home") next = 0;
					else if (event.key === "End") next = last;
					if (next == null) return;
					event.preventDefault();
					write(next);
				}}
			>
				<span ref={railRef} className="gui-slider-rail" aria-hidden="true" />
				<span className="gui-slider-fill" aria-hidden="true" />
				{rungs.map((item, index) => (
					<span
						key={item.level ?? "off"}
						className={`gui-slider-dot${index <= draft ? " gui-slider-dot--on" : ""}`}
						data-capped={item.capped ? "" : undefined}
						style={{ "--gui-slider-dot-p": index / last } as CSSProperties}
						aria-hidden="true"
					/>
				))}
				<span className="gui-slider-knob" aria-hidden="true" />
			</div>
			<div className="gui-slider-ticks" aria-hidden="true">
				{rungs.map((item, index) => (
					<span
						key={item.level ?? "off"}
						className={`gui-slider-tick${index === draft ? " gui-slider-tick--on" : ""}${item.capped ? " gui-slider-tick--capped" : ""}`}
					>
						{item.label}
					</span>
				))}
			</div>
			{rungs.some(item => item.capped) && ceiling ? (
				<p className="gui-agent-info-note">
					{`${t("transcript.thinkingCappedModel")} · ${t("transcript.modelCap")} ${thinkingLabel(ceiling)}`}
				</p>
			) : null}
		</div>
	);
}
