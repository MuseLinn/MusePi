import type { LucideIcon } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";

/** One segment of a sliding segmented control. */
export type SegmentedOption<T extends string> = {
	value: T;
	/** Visible text (hidden by `iconOnly`) — must already be translated. */
	label: string;
	/** Leading icon; becomes the whole content under `iconOnly`. */
	icon?: LucideIcon;
	/** Tooltip / accessible name — falls back to `label`. */
	title?: string;
};

/**
 * Segmented control with a single sliding thumb (iOS/ HarmonyOS "方案切换"
 * language): one element translates between equal-width segments instead of
 * every button repainting its own background, so the motion is a single
 * composited transform on an overshoot spring.
 *
 * Feel rules baked in:
 * - **Hover previews the landing spot** — the thumb slides to the hovered
 *   segment before the click commits, so pressing only settles it (never
 *   surprises the user with a jump they didn't aim at).
 * - **The first paint doesn't animate** — the transition is armed one frame
 *   after mount, otherwise every mounted control slides in from index 0.
 * - **Keyboard is a first-class path** — roving tabindex + arrows/Home/End
 *   move the selection and the focus together.
 * - **`shake`** jiggles the thumb in place for a repeat-pick (the theme
 *   switch's "already active" feedback). It animates the standalone
 *   `translate` property so it composes with the thumb's `transform`
 *   offset instead of dropping it.
 */
export function Segmented<T extends string>({
	value,
	options,
	onChange,
	ariaLabel,
	iconOnly = false,
	shake = false,
	onShakeEnd,
	className,
}: {
	value: T;
	options: readonly SegmentedOption<T>[];
	onChange(next: T): void;
	/** Omit only when a wrapping field already names the group. */
	ariaLabel?: string;
	/** Icon-only layout: no labels, fixed-width segments (header usage). */
	iconOnly?: boolean;
	/** Jiggle the thumb in place (repeat-pick feedback). */
	shake?: boolean;
	/** Fired when the jiggle finishes — clear `shake` here (no timers:
	 *  background-window timers throttle and would leave it stuck). */
	onShakeEnd?(): void;
	className?: string;
}): ReactNode {
	const activeIndex = Math.max(
		0,
		options.findIndex(o => o.value === value),
	);
	const [hoverIndex, setHoverIndex] = useState<number | null>(null);
	const [armed, setArmed] = useState(false);
	const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);

	// Arm the thumb transition one frame after mount: the first paint must
	// already sit on the active segment (no slide-in from index 0).
	useEffect(() => {
		const id = requestAnimationFrame(() => setArmed(true));
		return () => cancelAnimationFrame(id);
	}, []);

	const thumbIndex = hoverIndex ?? activeIndex;

	/** Move by `delta` with wraparound, keeping focus on the new segment. */
	const move = (delta: number): void => {
		const n = options.length;
		if (n === 0) return;
		const next = (((activeIndex + delta) % n) + n) % n;
		const opt = options[next];
		if (!opt) return;
		onChange(opt.value);
		itemsRef.current[next]?.focus();
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
		if (e.key === "ArrowRight" || e.key === "ArrowDown") {
			e.preventDefault();
			move(1);
		} else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
			e.preventDefault();
			move(-1);
		} else if (e.key === "Home") {
			e.preventDefault();
			move(-activeIndex);
		} else if (e.key === "End") {
			e.preventDefault();
			move(options.length - 1 - activeIndex);
		}
	};

	return (
		<div
			className={`gui-seg${iconOnly ? " gui-seg--icon" : ""}${armed ? " gui-seg--armed" : ""}${shake ? " gui-seg--shake" : ""}${className ? ` ${className}` : ""}`}
			role="radiogroup"
			aria-label={ariaLabel}
			style={{ "--seg-count": options.length, "--seg-index": thumbIndex } as CSSProperties}
			onPointerLeave={() => setHoverIndex(null)}
			onKeyDown={onKeyDown}
		>
			<span className="gui-seg-thumb" aria-hidden onAnimationEnd={onShakeEnd} />
			{options.map((o, i) => {
				const active = i === activeIndex;
				return (
					<button
						key={o.value}
						ref={el => {
							itemsRef.current[i] = el;
						}}
						type="button"
						role="radio"
						aria-checked={active}
						tabIndex={active ? 0 : -1}
						className="gui-seg-item"
						title={o.title ?? o.label}
						aria-label={iconOnly ? (o.title ?? o.label) : undefined}
						onPointerEnter={() => setHoverIndex(i)}
						onFocus={() => setHoverIndex(i)}
						onBlur={() => setHoverIndex(null)}
						onClick={() => onChange(o.value)}
					>
						{o.icon ? <o.icon size={iconOnly ? 15 : 14} /> : null}
						{iconOnly ? null : <span className="gui-seg-item-label">{o.label}</span>}
					</button>
				);
			})}
		</div>
	);
}
