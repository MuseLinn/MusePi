import { useLocale } from "@musepi/client-core";
import { type ReactNode, useRef } from "react";

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
 * declared preset, so dragging, the wheel and the arrow keys can only land on
 * legal values, and the current preset's label is always on screen.
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
	const trackRef = useRef<HTMLDivElement>(null);
	const dragging = useRef(false);
	const points = withCurrent(steps, value);
	const index = Math.max(
		0,
		points.findIndex(step => step.value === value),
	);
	const last = Math.max(1, points.length - 1);
	const ratio = index / last;
	const active = points[index] ?? points[0];

	const pick = (nextIndex: number): void => {
		const step = points[Math.max(0, Math.min(points.length - 1, nextIndex))];
		if (step && step.value !== value) onChange(step.value);
	};

	// Pointer position → nearest detent. The ladder is index-spaced, not
	// value-spaced: presets are frequently non-linear (1, 2.5, 5, 10, 20,
	// 50…), and a value-spaced rail would bunch most detents into one edge.
	const pickAt = (clientX: number): void => {
		const rect = trackRef.current?.getBoundingClientRect();
		if (!rect || rect.width === 0) return;
		const ratioAt = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
		pick(Math.round(ratioAt * last));
	};

	return (
		<div className={`gui-ladder${disabled ? " gui-ladder--disabled" : ""}`}>
			<span className="gui-ladder-value" title={active?.description}>
				{active?.label ?? Number(value).toLocaleString(locale, { maximumFractionDigits: 3 })}
			</span>
			<div
				ref={trackRef}
				className="gui-ladder-track"
				role="slider"
				tabIndex={disabled ? -1 : 0}
				aria-label={ariaLabel}
				aria-disabled={disabled || undefined}
				aria-valuemin={0}
				aria-valuemax={last}
				aria-valuenow={index}
				aria-valuetext={active?.label}
				onPointerDown={event => {
					if (disabled || event.button !== 0) return;
					event.preventDefault();
					dragging.current = true;
					event.currentTarget.setPointerCapture(event.pointerId);
					event.currentTarget.focus();
					pickAt(event.clientX);
				}}
				onPointerMove={event => {
					if (dragging.current) pickAt(event.clientX);
				}}
				onPointerUp={event => {
					dragging.current = false;
					if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
						event.currentTarget.releasePointerCapture(event.pointerId);
					}
				}}
				onPointerCancel={() => {
					dragging.current = false;
				}}
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
						pick(index + delta);
					} else if (event.key === "Home") {
						event.preventDefault();
						pick(0);
					} else if (event.key === "End") {
						event.preventDefault();
						pick(last);
					}
				}}
			>
				<span className="gui-ladder-rail" aria-hidden />
				<span className="gui-ladder-fill" style={{ width: `${ratio * 100}%` }} aria-hidden />
				{points.map((step, stop) => (
					<span
						key={`${stop}:${step.value}`}
						className={`gui-ladder-tick${stop <= index ? " gui-ladder-tick--on" : ""}`}
						style={{ left: `${(stop / last) * 100}%` }}
						aria-hidden
					/>
				))}
				<span className="gui-ladder-thumb" style={{ left: `${ratio * 100}%` }} aria-hidden />
			</div>
		</div>
	);
}
