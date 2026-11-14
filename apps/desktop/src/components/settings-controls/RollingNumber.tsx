import { useLocale } from "@musepi/client-core";
import { type ReactNode, useEffect, useRef, useState } from "react";

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
/** Pointer travel for one step. Up and right both increase. */
const DRAG_PX_PER_STEP = 8;
/** Trackpad wheels emit a burst; commit once the burst settles. */
const WHEEL_COMMIT_MS = 180;

/**
 * Step for a numeric setting that declares no ladder: every digit beyond four
 * multiplies the step by ten, so a 4-digit port steps by 1 and a 6-digit
 * timeout by 100. Fractional settings get 0.01; settings whose default is an
 * integer but whose real domain is fractional declare `ui.step` in the schema.
 */
export function defaultStep(value: number): number {
	if (!Number.isFinite(value)) return 1;
	if (!Number.isInteger(value)) return 0.01;
	const magnitude = Math.floor(Math.log10(Math.max(1, Math.abs(value))));
	return Number(`1e${Math.max(0, Math.min(magnitude - 3, 6))}`);
}

function decimalsOf(value: number): number {
	if (!Number.isFinite(value)) return 0;
	const text = String(value);
	const dot = text.indexOf(".");
	return dot === -1 ? 0 : text.length - dot - 1;
}

/**
 * Numeric setting without a preset ladder: a rolling counter.
 *
 * A bare number input made every adjustment a two-step edit (clear, retype)
 * and gave no sense of direction. Here the digits are reels that roll to the
 * new position, the wheel and the arrow keys step, and dragging scrubs; typing
 * still works by clicking the value or pressing the first digit.
 */
export function RollingNumber({
	value,
	onChange,
	min = 0,
	max = Number.POSITIVE_INFINITY,
	step,
	ariaLabel,
	disabled = false,
}: {
	value: number;
	onChange(next: number): void;
	min?: number;
	max?: number;
	step?: number;
	ariaLabel?: string;
	disabled?: boolean;
}): ReactNode {
	const locale = useLocale();
	const [draft, setDraft] = useState<number | null>(null);
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState("");
	const [dragging, setDragging] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const draftRef = useRef<number | null>(null);
	const dragRef = useRef<{ x: number; y: number; start: number } | null>(null);
	const commitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const shown = draft ?? value;
	const stepSize = step ?? defaultStep(value);
	const decimals = Math.max(decimalsOf(stepSize), decimalsOf(shown));

	const quantize = (next: number): number => Math.min(max, Math.max(min, Number(next.toFixed(decimals))));

	const cancelPending = (): void => {
		if (commitTimer.current !== null) clearTimeout(commitTimer.current);
		commitTimer.current = null;
	};

	// A pending wheel commit is the only state that can outlive a render, so
	// flush it on unmount instead of dropping the last adjustment.
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const valueRef = useRef(value);
	valueRef.current = value;
	const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const mounted = useRef(true);

	const flush = (): void => {
		cancelPending();
		const next = draftRef.current;
		draftRef.current = null;
		if (next !== null && next !== valueRef.current) onChangeRef.current(next);
		// A rejected write reverts the prop instead of matching the draft;
		// clear the stale draft so the control stops lying about the stored
		// value. An accepted write clears it through the sync effect below.
		if (settleTimer.current !== null) clearTimeout(settleTimer.current);
		if (!mounted.current) return;
		settleTimer.current = setTimeout(() => {
			if (draftRef.current === null) setDraft(null);
		}, 1000);
	};

	const emit = (next: number, timing: "now" | "soon" | "drag"): void => {
		const quantized = quantize(next);
		draftRef.current = quantized;
		setDraft(quantized);
		if (timing === "now") {
			cancelPending();
			flush();
		} else if (timing === "soon") {
			cancelPending();
			commitTimer.current = setTimeout(flush, WHEEL_COMMIT_MS);
		}
	};

	// The parent writes back optimistically; drop the local draft once it
	// matches so the control follows external changes again.
	useEffect(() => {
		if (draft !== null && draft === value) setDraft(null);
	}, [draft, value]);

	useEffect(
		() => () => {
			mounted.current = false;
			flush();
			if (settleTimer.current !== null) clearTimeout(settleTimer.current);
		},
		[],
	);

	// Wheel must be non-passive to stop the settings pane from scrolling.
	// React's synthetic wheel listener is passive, so bind natively.
	const emitRef = useRef(emit);
	emitRef.current = emit;
	useEffect(() => {
		const element = rootRef.current;
		if (!element || disabled) return;
		const onWheel = (event: WheelEvent): void => {
			if (editing) return;
			event.preventDefault();
			const direction = event.deltaY > 0 ? -1 : 1;
			const multiplier = event.shiftKey ? 10 : 1;
			emitRef.current((draftRef.current ?? valueRef.current) + direction * stepSize * multiplier, "soon");
		};
		element.addEventListener("wheel", onWheel, { passive: false });
		return () => element.removeEventListener("wheel", onWheel);
	}, [disabled, editing, stepSize]);

	const startEdit = (initial?: string): void => {
		if (disabled) return;
		setText(initial ?? String(shown));
		setEditing(true);
	};

	const commitEdit = (refocus = false): void => {
		setEditing(false);
		const parsed = Number(text.trim());
		if (Number.isFinite(parsed)) emit(parsed, "now");
		// Only a keyboard commit returns focus: clicking elsewhere must let
		// focus follow the click, not bounce back into this control.
		if (refocus) requestAnimationFrame(() => rootRef.current?.focus());
	};

	const formatted = new Intl.NumberFormat(locale, {
		numberingSystem: "latn",
		maximumFractionDigits: decimals,
		useGrouping: Math.abs(shown) >= 10000,
	}).format(shown);

	return (
		<div
			ref={rootRef}
			className={`gui-rollnum${dragging ? " gui-rollnum--dragging" : ""}${disabled ? " gui-rollnum--disabled" : ""}`}
			role="spinbutton"
			tabIndex={disabled ? -1 : 0}
			aria-label={ariaLabel}
			aria-disabled={disabled || undefined}
			aria-valuenow={shown}
			aria-valuemin={Number.isFinite(min) ? min : undefined}
			aria-valuemax={Number.isFinite(max) ? max : undefined}
			aria-valuetext={formatted}
			onPointerDown={event => {
				if (disabled || editing || event.button !== 0) return;
				event.preventDefault();
				rootRef.current?.focus();
				dragRef.current = { x: event.clientX, y: event.clientY, start: shown };
				setDragging(true);
				event.currentTarget.setPointerCapture(event.pointerId);
			}}
			onPointerMove={event => {
				const drag = dragRef.current;
				if (!drag) return;
				// Up or right increases; diagonal travel therefore scrubs too.
				const travel = event.clientX - drag.x - (event.clientY - drag.y);
				const steps = Math.round(travel / DRAG_PX_PER_STEP);
				if (steps === 0) {
					setDraft(drag.start);
					draftRef.current = drag.start;
					return;
				}
				emit(drag.start + steps * stepSize, "drag");
			}}
			onPointerUp={event => {
				if (!dragRef.current) return;
				dragRef.current = null;
				setDragging(false);
				if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
					event.currentTarget.releasePointerCapture(event.pointerId);
				}
				flush();
			}}
			onPointerCancel={() => {
				if (!dragRef.current) return;
				dragRef.current = null;
				setDragging(false);
				flush();
			}}
			onKeyDown={event => {
				if (disabled || editing) return;
				const multiplier = event.shiftKey ? 10 : 1;
				switch (event.key) {
					case "ArrowUp":
					case "ArrowRight":
						event.preventDefault();
						emit(shown + stepSize * multiplier, "now");
						return;
					case "ArrowDown":
					case "ArrowLeft":
						event.preventDefault();
						emit(shown - stepSize * multiplier, "now");
						return;
					case "PageUp":
						event.preventDefault();
						emit(shown + stepSize * 10, "now");
						return;
					case "PageDown":
						event.preventDefault();
						emit(shown - stepSize * 10, "now");
						return;
					case "Home":
						event.preventDefault();
						emit(min, "now");
						return;
					case "End":
						if (Number.isFinite(max)) {
							event.preventDefault();
							emit(max, "now");
						}
						return;
					case "Enter":
						event.preventDefault();
						startEdit();
						return;
					default:
						// Typing a digit starts text entry with that digit, so the
						// control needs no separate edit affordance.
						if (/^[0-9.-]$/u.test(event.key)) {
							event.preventDefault();
							startEdit(event.key);
						}
				}
			}}
		>
			{editing ? (
				<input
					className="gui-rollnum-input"
					autoFocus
					inputMode="decimal"
					value={text}
					aria-label={ariaLabel}
					onChange={event => setText(event.target.value)}
					onBlur={() => commitEdit()}
					onKeyDown={event => {
						if (event.key === "Enter") {
							event.preventDefault();
							commitEdit(true);
						} else if (event.key === "Escape") {
							event.preventDefault();
							setEditing(false);
							requestAnimationFrame(() => rootRef.current?.focus());
						}
					}}
				/>
			) : (
				<span className="gui-rollnum-digits" aria-hidden>
					{[...formatted].map((character, position) =>
						character >= "0" && character <= "9" ? (
							<span key={position} className="gui-rollnum-digit">
								<span className="gui-rollnum-reel" style={{ transform: `translateY(-${Number(character)}em)` }}>
									{DIGITS.map(digit => (
										<span key={digit}>{digit}</span>
									))}
								</span>
							</span>
						) : (
							<span key={position} className="gui-rollnum-static">
								{character}
							</span>
						),
					)}
				</span>
			)}
		</div>
	);
}
