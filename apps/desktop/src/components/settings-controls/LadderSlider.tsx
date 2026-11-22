import { useLocale } from "@musepi/client-core";
import type { ReactNode } from "react";
import { SliderTrack, useSliderDrag } from "../LadderSlider";

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
 * math is the thinking ladder's (`useSliderDrag`) and so is the track
 * (`SliderTrack`): the two ladders are one control with two heads. Only the
 * head differs — this one has no section label, so the value sits over the
 * track instead of beside one.
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
	const readout = active?.label ?? Number(value).toLocaleString(locale, { maximumFractionDigits: 3 });

	return (
		<div className="gui-slider gui-slider--detent" data-disabled={disabled ? "true" : undefined}>
			<div className="gui-slider-head">
				<span className="gui-slider-value" title={active?.description}>
					{readout}
				</span>
			</div>
			<SliderTrack
				slider={slider}
				last={last}
				labels={points.map(step => step.label)}
				pageStep={5}
				disabled={disabled}
				ariaLabel={ariaLabel}
				valueText={readout}
			/>
		</div>
	);
}
