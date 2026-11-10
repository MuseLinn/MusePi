import type { CSSProperties } from "react";
import { clampProgress } from "./progress";
import "./progress.css";

export type ProgressTone = "accent" | "ok" | "warn" | "err";

export interface ProgressMeterProps {
	/** 0–100. Floored, so an unfinished meter never reads full. */
	value: number;
	tone?: ProgressTone;
	/** Accessible name for the track. */
	label?: string;
	/** Announced reading when the visual percentage is not the whole story. */
	valueText?: string;
	/** Running work with no measurable total: slides until it settles. */
	indeterminate?: boolean;
	size?: "sm" | "md";
	className?: string;
}

/**
 * One determinate (or indeterminate) progress track. The visual value and the
 * announced value come from the same floored number, so assistive tech and the
 * fill can never disagree.
 */
export function ProgressMeter({
	value,
	tone = "accent",
	label,
	valueText,
	indeterminate = false,
	size = "sm",
	className,
}: ProgressMeterProps) {
	const percent = clampProgress(value);
	return (
		<div
			className={`musepi-progress${size === "md" ? " musepi-progress--md" : ""}${className ? ` ${className}` : ""}`}
			role="progressbar"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={indeterminate ? undefined : percent}
			aria-label={label}
			aria-valuetext={valueText}
			data-tone={tone}
			data-indeterminate={indeterminate ? "true" : undefined}
			data-done={percent === 100 && !indeterminate ? "true" : undefined}
			style={{ ["--progress-value" as string]: String(percent / 100) } as CSSProperties}
		>
			<span className="musepi-progress-fill" />
		</div>
	);
}

export interface ProgressSegment {
	value: number;
	tone?: ProgressTone;
}

/**
 * Multi-phase overview (done / running / failed …). Phases keep their own tone
 * and grow in proportion to their count. The legend beside it owns the
 * accessible counts, so the bar is decorative unless a `label` is supplied.
 */
export function ProgressSegments({
	segments,
	label,
	className,
}: {
	segments: readonly ProgressSegment[];
	label?: string;
	className?: string;
}) {
	const visible = segments.filter(segment => Number.isFinite(segment.value) && segment.value > 0);
	if (visible.length === 0) return null;
	return (
		<div
			className={`musepi-progress musepi-progress--segments${className ? ` ${className}` : ""}`}
			role={label ? "img" : undefined}
			aria-label={label}
			aria-hidden={label ? undefined : "true"}
		>
			{visible.map((segment, index) => (
				<span
					key={index}
					className="musepi-progress-seg"
					data-tone={segment.tone ?? "accent"}
					style={{ flexGrow: Math.max(0, segment.value) }}
				/>
			))}
		</div>
	);
}
