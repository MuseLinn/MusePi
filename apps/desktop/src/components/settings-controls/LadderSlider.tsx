import { useLocale } from "@musepi/client-core";
import type { CSSProperties, ReactNode } from "react";
import { useSliderDrag } from "../LadderSlider";

/** One detent on a preset ladder. */
export interface LadderStep {
	value: number;
	/** Visible label for this stop (already translated). */
	label: string;
	/** Preset explanation, surfaced as the value tooltip. */
	description?: string;
}

/** A stored value that no preset declares still needs an honest thumb
 *  position: insert it where it numerically belongs instead of snapping the
 *  display to a neighbour. Preset order is otherwise preserved — the declared
 *  order is the ladder, and some ladders are not monotonic (`-1 = Default`
 *  first, then real values). */
function withCurrent(steps: readonly LadderStep[], value: number): LadderStep[] {
	if (!Number.isFinite(value) || steps.some(step => step.value === value)) return [...steps];
	const list = [...steps];
	const at = list.findIndex(step => step.value > value);
	list.splice(at === -1 ? list.length : at, 0, { value, label: String(value) });
	return list;
}

/**
 * Detent slider for numeric settings that declare a preset ladder
 * (`ui.options` on a number, TUI submenu parity).
 *
 * A plain number input let the user store values the setting does not
 * support and hid every preset label. This control owns one detent per
 * declared preset, so a release and the arrow keys can only land on legal
 * values, and the current preset's label is always on screen. The pointer
 * math is the thinking ladder's (`useSliderDrag`): the thumb tracks the
 * pointer continuously and snaps to the nearest detent on release, and the
 * gesture writes once instead of once per pointer tick.
 */
export function LadderSlider({
	steps,
	value,
	onChange,
	ariaLabel,
	disabled = false,
}: {
	steps: readonly LadderStep[];
	value: number;
	onChange(next: number): void;
	ariaLabel?: string;
	disabled?: boolean;
}): ReactNode {
	const locale = useLocale();
	const points = withCurrent(steps, value);
	const index = Math.max(
		0,
		points.findIndex(step => step.value === value),
	);
	const last = Math.max(1, points.length - 1);

	// The ladder is index-spaced, not value-spaced: presets are frequently
	// non-linear (1, 2.5, 5, 10, 20, 50…), and a value-spaced rail would bunch
	// most detents into one edge.
	const pick = (target: number): void => {
		const step = points[target];
		if (step && step.value !== value) onChange(step.value);
	};
	const slider = useSliderDrag({ last, value: index, onSettle: pick, disabled });

	// The readout names the rung the release would land on, so the label and
	// `aria-valuetext` never disagree with the magnetic target.
	const active = points[slider.target] ?? points[0];

	return (
		<div className={`gui-ladder${disabled ? " gui-ladder--disabled" : ""}`}>
			<span className="gui-ladder-value" title={active?.description}>
				{active?.label ?? Number(value).toLocaleString(locale, { maximumFractionDigits: 3 })}
			</span>
			<div
				className="gui-ladder-track"
				role="slider"
				tabIndex={disabled ? -1 : 0}
				aria-label={ariaLabel}
				aria-disabled={disabled || undefined}
				aria-valuemin={0}
				aria-valuemax={last}
				aria-valuenow={slider.target}
				aria-valuetext={active?.label}
				data-dragging={slider.dragging ? "" : undefined}
				style={{ "--gui-ladder-p": slider.position / last } as CSSProperties}
				{...slider.handlers}
				onKeyDown={event => {
					if (disabled) return;
					const moves: Record<string, number> = {
						ArrowRight: 1,
						ArrowUp: 1,
						ArrowLeft: -1,
						ArrowDown: -1,
						PageUp: 5,
						PageDown: -5,
					};
					const delta = moves[event.key];
					if (delta !== undefined) {
						event.preventDefault();
						slider.step(slider.target + delta);
					} else if (event.key === "Home") {
						event.preventDefault();
						slider.step(0);
					} else if (event.key === "End") {
						event.preventDefault();
						slider.step(last);
					}
				}}
			>
				<span ref={slider.setRail} className="gui-ladder-rail" aria-hidden />
				<span className="gui-ladder-fill" aria-hidden />
				{points.map((step, stop) => (
					<span
						key={`${stop}:${step.value}`}
						className={`gui-ladder-tick${stop <= slider.target ? " gui-ladder-tick--on" : ""}`}
						style={{ "--gui-ladder-dot-p": stop / last } as CSSProperties}
						aria-hidden
					/>
				))}
				<span className="gui-ladder-thumb" aria-hidden />
			</div>
		</div>
	);
}
