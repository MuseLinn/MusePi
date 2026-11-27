/**
 * Reveal-on-hold for a masked field.
 *
 * A toggle leaves the value on screen after the reader has looked at it — the
 * most likely moment to forget is exactly when they are done. Holding shows it
 * only while the button is down, so the field re-masks on release, on pointer
 * leave, and on keyboard keyup even if focus moved away.
 *
 * Both the pointer and the keyboard are supported: `aria-pressed` reflects
 * whether the value is visible right now, and the button is reachable by Tab so
 * a keyboard user is not asked to press and hold a mouse.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export interface RevealOnHold {
	/** True while the value should be readable. */
	revealed: boolean;
	/** Props for the hold button. Spread them; do not keep a copy. */
	handlers: {
		onPointerDown(event: { preventDefault(): void }): void;
		onPointerUp(): void;
		onPointerLeave(): void;
		onPointerCancel(): void;
		onKeyDown(event: { key: string; preventDefault(): void }): void;
		onKeyUp(event: { key: string }): void;
		onBlur(): void;
	};
}

/**
 * Hold-to-reveal state for one masked input.
 *
 * `disabled` follows the form's busy state: nothing should be readable while a
 * save is in flight.
 */
export function useRevealOnHold(disabled = false): RevealOnHold {
	const [revealed, setRevealed] = useState(false);
	// A pointer hold and a key hold can overlap; whichever ends last re-masks.
	const holdingPointer = useRef(false);
	const holdingKey = useRef(false);

	const release = useCallback(() => {
		holdingPointer.current = false;
		holdingKey.current = false;
		setRevealed(false);
	}, []);

	// A window-level release catches the pointerup that happens off the button,
	// which is what a fast drag does, and a window blur covers tabbing away.
	useEffect(() => {
		if (!revealed) return;
		const stop = (): void => {
			holdingPointer.current = false;
			holdingKey.current = false;
			setRevealed(false);
		};
		window.addEventListener("pointerup", stop);
		window.addEventListener("blur", stop);
		return () => {
			window.removeEventListener("pointerup", stop);
			window.removeEventListener("blur", stop);
		};
	}, [revealed]);

	// The field going away must never leave it open.
	useEffect(() => () => release(), [release]);

	return {
		revealed,
		handlers: {
			onPointerDown(event) {
				// Keep focus in the input: the reader is mid-typing.
				event.preventDefault();
				if (disabled) return;
				holdingPointer.current = true;
				setRevealed(true);
			},
			onPointerUp: release,
			onPointerLeave: release,
			onPointerCancel: release,
			onKeyDown(event) {
				if (disabled) return;
				if (event.key !== " " && event.key !== "Enter") return;
				event.preventDefault();
				holdingKey.current = true;
				setRevealed(true);
			},
			onKeyUp(event) {
				if (event.key !== " " && event.key !== "Enter") return;
				holdingKey.current = false;
				setRevealed(holdingPointer.current);
			},
			onBlur: release,
		},
	};
}
