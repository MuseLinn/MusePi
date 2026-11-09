import type { LucideIcon } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

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

/** Box metrics of one rendered segment. */
export type SegmentBox = {
	/** Inner width the segment currently has. */
	clientWidth: number;
	/** Padding, icon, and gap without the flex free space. */
	chromeWidth?: number;
	/** The label span, when the segment has one. */
	label?: { clientWidth: number; scrollWidth: number };
};

/**
 * Width the widest segment actually needs. Equal-width segments share one
 * width, so the longest label sets all of them — and CSS cannot read "widest"
 * from siblings (a `flex: 1 1 0` container splits the SUM of the labels, so
 * 「运行中」+「全部」 gives each segment half of 60px and clips the long one).
 * A clipped label reports the full text width through `scrollWidth`. The
 * segment's padding, icon, and gap complete the required width; flex free
 * space must not feed back into this floor when the parent later shrinks.
 */
export function segmentFitWidth(items: readonly SegmentBox[]): number {
	let widest = 0;
	for (const item of items) {
		const need = item.label
			? item.label.scrollWidth + (item.chromeWidth ?? Math.max(0, item.clientWidth - item.label.clientWidth))
			: item.clientWidth;
		widest = Math.max(widest, need);
	}
	return Math.ceil(widest);
}

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
 * - **Segments are never narrower than their longest label** — the width is
 *   measured and published as `--seg-min` (see {@link segmentFitWidth}).
 */

/** `useLayoutEffect` that degrades to `useEffect` when there is no DOM, so
 *  SSR `renderToStaticMarkup` callers do not log React's "does nothing on the
 *  server" warning for a purely visual measurement. */
const useMeasuredLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
export function Segmented<T extends string>({
	value,
	options,
	onChange,
	ariaLabel,
	iconOnly = false,
	shake = false,
	onShakeEnd,
	className,
	disabled = false,
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
	/** Prevent pointer and keyboard selection while preserving the current value. */
	disabled?: boolean;
}): ReactNode {
	const activeIndex = Math.max(
		0,
		options.findIndex(o => o.value === value),
	);
	const [hoverIndex, setHoverIndex] = useState<number | null>(null);
	const [armed, setArmed] = useState(false);
	const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);
	const rootRef = useRef<HTMLDivElement | null>(null);

	// Arm the thumb transition one frame after mount: the first paint must
	// already sit on the active segment (no slide-in from index 0).
	useEffect(() => {
		const id = requestAnimationFrame(() => setArmed(true));
		return () => cancelAnimationFrame(id);
	}, []);

	// Publish the widest segment's required width as `--seg-min`; CSS turns it
	// into `min-width: var(--seg-count) * var(--seg-min)` so the equal-width
	// segments are never narrower than their longest label (labels are
	// `nowrap` + `overflow: hidden`, so an under-sized control silently clips
	// instead of overflowing). Written straight to the node — a var that only
	// drives one min-width must not cost a render pass on every control.
	const labelKey = `${iconOnly ? "i" : "t"}:${options.map(o => o.label).join("\u0000")}`;
	useMeasuredLayoutEffect(() => {
		// `labelKey` is the only input that changes the measurement (labels or
		// the icon-only switch); `options` is a fresh array each render and
		// would re-measure forever.
		const measure = (): void => {
			const root = rootRef.current;
			if (!root) return;
			const boxes: SegmentBox[] = [];
			for (const item of root.querySelectorAll<HTMLElement>(".gui-seg-item")) {
				const label = item.querySelector<HTMLElement>(".gui-seg-item-label");
				const style = getComputedStyle(item);
				const icon = label ? item.querySelector("svg") : null;
				const chromeWidth =
					(Number.parseFloat(style.paddingLeft) || 0) +
					(Number.parseFloat(style.paddingRight) || 0) +
					(icon ? icon.getBoundingClientRect().width + (Number.parseFloat(style.columnGap) || 0) : 0);
				boxes.push({
					clientWidth: item.clientWidth,
					chromeWidth,
					...(label ? { label: { clientWidth: label.clientWidth, scrollWidth: label.scrollWidth } } : {}),
				});
			}
			const fit = segmentFitWidth(boxes);
			if (fit > 0) root.style.setProperty("--seg-min", `${fit}px`);
		};
		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, [labelKey]);

	const thumbIndex = disabled ? activeIndex : (hoverIndex ?? activeIndex);

	/** Move by `delta` with wraparound, keeping focus on the new segment. */
	const move = (delta: number): void => {
		if (disabled) return;
		const n = options.length;
		if (n === 0) return;
		const next = (((activeIndex + delta) % n) + n) % n;
		const opt = options[next];
		if (!opt) return;
		onChange(opt.value);
		itemsRef.current[next]?.focus();
	};

	const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
		if (disabled) return;
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
			ref={rootRef}
			className={`gui-seg${iconOnly ? " gui-seg--icon" : ""}${armed ? " gui-seg--armed" : ""}${shake ? " gui-seg--shake" : ""}${className ? ` ${className}` : ""}`}
			role="radiogroup"
			aria-label={ariaLabel}
			aria-disabled={disabled || undefined}
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
						tabIndex={!disabled && active ? 0 : -1}
						disabled={disabled}
						className="gui-seg-item"
						title={o.title ?? o.label}
						aria-label={iconOnly ? (o.title ?? o.label) : undefined}
						onPointerEnter={() => {
							if (!disabled) setHoverIndex(i);
						}}
						onFocus={() => {
							if (!disabled) setHoverIndex(i);
						}}
						onBlur={() => setHoverIndex(null)}
						onClick={() => {
							if (!disabled) onChange(o.value);
						}}
					>
						{o.icon ? <o.icon size={iconOnly ? 15 : 14} /> : null}
						{iconOnly ? null : <span className="gui-seg-item-label">{o.label}</span>}
					</button>
				);
			})}
		</div>
	);
}
