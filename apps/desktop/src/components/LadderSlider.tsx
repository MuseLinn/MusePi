import { t } from "@musepi/client-core";
import type { CSSProperties, ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useRef, useState } from "react";
import { THINKING_LEVELS, thinkingLabel } from "./thinking-selector-shared";

/**
 * Pointer and key math for the GUI's ladders — this thinking ladder and the
 * settings detent ladder (`settings-controls/LadderSlider.tsx`), which imports
 * it. One implementation, so the two never drift into different drag feels.
 *
 * The pointer writes a FRACTIONAL rung position: the thumb stays glued to the
 * pointer instead of hopping between detents, which is what made the old drag
 * read as a sequence of jumps. Detents are magnetic, not binding — `target` is
 * the nearest reachable rung and follows the pointer while the readout and
 * `aria-valuenow`/`aria-valuetext` report it, and the thumb only settles onto it
 * when the gesture ends (the CSS eases `left`, so the release snaps; reduced
 * motion lands at once). Nothing is written during the gesture: `onSettle`
 * fires once on release, or once per discrete key step.
 */
export interface SliderDragOptions {
	/** Highest rung index: the measured travel span covers rungs 0..last. */
	last: number;
	/** Committed rung — where the thumb rests between gestures. */
	value: number;
	/** Rounded index → the rung a release may land on (a model ceiling, an
	 *  unreachable detent). Identity with clamping when every rung is legal. */
	reachable?(index: number): number;
	/** One call per gesture: the rung a release or a key step landed on. */
	onSettle(index: number): void;
	disabled?: boolean;
}

export interface SliderDrag {
	/** Callback ref for the element whose border box spans the travel. */
	setRail(node: HTMLElement | null): void;
	/** Fractional rung the thumb is drawn at. */
	position: number;
	/** Rung a release would land on right now. */
	target: number;
	dragging: boolean;
	handlers: {
		onPointerDown(event: ReactPointerEvent<HTMLElement>): void;
		onPointerMove(event: ReactPointerEvent<HTMLElement>): void;
		onPointerUp(event: ReactPointerEvent<HTMLElement>): void;
		onPointerCancel(): void;
		onLostPointerCapture(): void;
	};
	/** Discrete move (arrow keys): settles exactly like a release. */
	step(index: number): void;
}

/** A pointer that has not travelled this far has not started a drag: a press
 *  and release still moves the thumb straight onto a detent instead of letting
 *  it slide sideways under a still cursor. */
const DRAG_THRESHOLD_PX = 2;

export function useSliderDrag({ last, value, reachable, onSettle, disabled = false }: SliderDragOptions): SliderDrag {
	const rail = useRef<HTMLElement | null>(null);
	const dragRef = useRef<{ pointerId: number; pressX: number } | null>(null);
	const rawRef = useRef<number | null>(null);
	const movedRef = useRef(false);
	// The fractional pointer position while a gesture is live; `null` when the
	// pointer does not own the thumb.
	const [drag, setDrag] = useState<{ raw: number; moved: boolean } | null>(null);

	const settle = (index: number): number => {
		const rounded = Math.round(index);
		return reachable ? reachable(rounded) : Math.min(Math.max(rounded, 0), last);
	};

	/** Pointer x → fractional rung, or null while the rail has no laid-out
	 *  width (the first frame, a hidden panel). The rail's rect is exactly the
	 *  travel span, because CSS insets it by the knob radius. */
	const positionAt = (clientX: number): number | null => {
		const rect = rail.current?.getBoundingClientRect();
		if (!rect || rect.width <= 0) return null;
		return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * last;
	};

	const drop = (index: number | null): void => {
		if (!dragRef.current) return;
		dragRef.current = null;
		rawRef.current = null;
		movedRef.current = false;
		setDrag(null);
		// A cancelled gesture writes nothing; an ended one settles on its rung and
		// the committed prop — updated optimistically by the owner in the same
		// batch — becomes the thumb's target, so the CSS transition snaps it there.
		if (index != null) onSettle(settle(index));
	};

	const step = (index: number): void => {
		onSettle(settle(index));
	};

	const magnetic = drag ? settle(drag.raw) : null;
	// A press that has not travelled yet puts the thumb straight on the detent
	// under the pointer instead of sliding it there.
	const position = drag ? (drag.moved ? drag.raw : (magnetic ?? value)) : value;
	const target = drag ? (magnetic ?? value) : value;

	return {
		setRail: useCallback((node: HTMLElement | null) => {
			rail.current = node;
		}, []),
		position,
		target,
		dragging: drag !== null,
		handlers: {
			onPointerDown: event => {
				if (disabled || event.button !== 0) return;
				const raw = positionAt(event.clientX);
				if (raw == null) return;
				event.preventDefault();
				try {
					event.currentTarget.setPointerCapture?.(event.pointerId);
				} catch {
					/* capture is best-effort; the release still settles */
				}
				dragRef.current = { pointerId: event.pointerId, pressX: event.clientX };
				rawRef.current = raw;
				movedRef.current = false;
				setDrag({ raw, moved: false });
				event.currentTarget.focus();
			},
			onPointerMove: event => {
				const state = dragRef.current;
				if (!state || state.pointerId !== event.pointerId) return;
				const raw = positionAt(event.clientX);
				if (raw == null) return;
				rawRef.current = raw;
				if (!movedRef.current && Math.abs(event.clientX - state.pressX) > DRAG_THRESHOLD_PX)
					movedRef.current = true;
				setDrag({ raw, moved: movedRef.current });
			},
			onPointerUp: event => {
				const state = dragRef.current;
				if (!state || state.pointerId !== event.pointerId) return;
				drop(positionAt(event.clientX) ?? rawRef.current);
			},
			// A cancelled drag never commits: dropping the draft lets the
			// committed value drive the thumb again. `lostpointercapture` also
			// fires after a normal release, where no drag is left to cancel.
			onPointerCancel: () => drop(null),
			onLostPointerCapture: () => drop(null),
		},
		step,
	};
}

/**
 * Thinking-effort ladder slider.
 *
 * One discrete track over the current model's REAL efforts plus `auto` (and
 * `off` when the model has a ladder to turn off). The knob tracks the pointer
 * continuously and snaps to the nearest reachable rung on release; only the
 * release writes — a slider that committed every pointer tick would send one
 * RPC per pixel and race its own optimistic state.
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
	const last = Math.max(1, rungs.length - 1);
	const committed = ladderIndex(rungs, value);
	// Rungs above the model's ceiling are visible but unreachable: a gesture that
	// passes over them reports the ceiling instead, never a capped rung.
	const clampIndex = (index: number): number => clampLadderIndex(rungs, index);
	const commit = (index: number): void => {
		const next = rungs[index]?.level ?? null;
		if (next !== (value ?? null)) onCommit(next);
	};
	const slider = useSliderDrag({ last, value: committed, reachable: clampIndex, onSettle: commit, disabled });

	if (efforts.length === 0) {
		return <p className="gui-agent-info-note">{t("general.agentInfoThinkingUnsupported")}</p>;
	}

	const rung = rungs[slider.target] ?? rungs[0]!;

	return (
		<div className="gui-slider" data-disabled={disabled ? "true" : undefined}>
			<div className="gui-slider-head">
				<span className="gui-slider-value">{rung.label}</span>
				{rung.auto && resolved ? (
					<span className="gui-slider-resolved">{`${t("transcript.thinkingAuto")} · ${thinkingLabel(resolved)}`}</span>
				) : null}
			</div>
			<div
				className="gui-slider-track"
				role="slider"
				tabIndex={disabled ? -1 : 0}
				aria-label={t("general.agentInfoThinking")}
				aria-disabled={disabled || undefined}
				aria-valuemin={0}
				aria-valuemax={last}
				aria-valuenow={slider.target}
				aria-valuetext={rung.label}
				data-dragging={slider.dragging ? "" : undefined}
				style={{ "--gui-slider-p": slider.position / last } as CSSProperties}
				{...slider.handlers}
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
					if (delta !== undefined) next = slider.target + delta;
					else if (event.key === "Home") next = 0;
					else if (event.key === "End") next = last;
					if (next == null) return;
					event.preventDefault();
					slider.step(next);
				}}
			>
				<span ref={slider.setRail} className="gui-slider-rail" aria-hidden="true" />
				<span className="gui-slider-fill" aria-hidden="true" />
				{rungs.map((item, index) => (
					<span
						key={item.level ?? "off"}
						className={`gui-slider-dot${index <= slider.target ? " gui-slider-dot--on" : ""}`}
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
						className={`gui-slider-tick${index === slider.target ? " gui-slider-tick--on" : ""}${item.capped ? " gui-slider-tick--capped" : ""}`}
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
