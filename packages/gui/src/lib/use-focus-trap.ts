/**
 * Lightweight focus trap for modal dialogs (WCAG 2.4.3 / 2.1.2 parity).
 * Traps Tab/Shift+Tab inside the container and restores focus to the
 * previously-active element on removal.
 *
 * Usage:
 * ```tsx
 * const trapRef = useFocusTrap(open);
 * return <div ref={trapRef} role="dialog" aria-modal="true">…</div>;
 * ```
 */
import { useEffect, useRef } from "react";

const FOCUSABLE =
	'a[href], button:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"]):not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), details summary';

function getFocusable(el: HTMLElement | null): HTMLElement[] {
	if (!el) return [];
	return Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(e => e.offsetWidth > 0 || e.offsetHeight > 0);
}

/**
 * Trap keyboard focus within the ref'd element while `active` is true.
 * Returns a ref to attach to the trap container.
 */
export function useFocusTrap<T extends HTMLElement = HTMLElement>(active: boolean): React.RefObject<T | null> {
	const ref = useRef<T | null>(null);
	const prevFocus = useRef<HTMLElement | null>(null);

	useEffect(() => {
		if (!active) return;
		const el = ref.current;
		if (!el) return;

		// Save the active element before the trap opens.
		prevFocus.current = document.activeElement as HTMLElement;

		// Auto-focus the first focusable element inside the trap.
		const candidates = getFocusable(el);
		if (candidates.length > 0) {
			candidates[0]!.focus();
		} else {
			// Fallback: focus the container itself so Tab stays inside.
			el.setAttribute("tabindex", "-1");
			el.focus();
		}

		const onKeyDown = (e: KeyboardEvent): void => {
			if (e.key !== "Tab") return;
			const focusable = getFocusable(el);
			if (focusable.length === 0) {
				e.preventDefault();
				return;
			}
			const idx = focusable.indexOf(document.activeElement as HTMLElement);
			if (e.shiftKey) {
				if (idx <= 0) {
					e.preventDefault();
					focusable[focusable.length - 1]!.focus();
				}
			} else {
				if (idx === -1 || idx >= focusable.length - 1) {
					e.preventDefault();
					focusable[0]!.focus();
				}
			}
		};

		el.addEventListener("keydown", onKeyDown);
		return () => {
			el.removeEventListener("keydown", onKeyDown);
			// Restore focus to the element that was active before opening.
			prevFocus.current?.focus();
		};
	}, [active]);

	return ref;
}