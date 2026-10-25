import type { RefObject } from "react";
import { useEffect, useRef } from "react";

const FOCUSABLE =
	'a[href], button:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"]):not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), details summary';

const modalStack: HTMLElement[] = [];

function getFocusable(container: HTMLElement): HTMLElement[] {
	return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(element => {
		for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
			if (ancestor.hidden) return false;
			const style = window.getComputedStyle(ancestor);
			if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
		}
		return true;
	});
}

export function isTopModal(element: HTMLElement): boolean {
	return modalStack[modalStack.length - 1] === element;
}

export function useModalFocus<T extends HTMLElement>(
	active: boolean,
	options: { initialFocus?: "first" | "container" } = {},
): RefObject<T | null> {
	const ref = useRef<T | null>(null);
	const initialFocus = options.initialFocus ?? "first";

	useEffect(() => {
		if (!active) return;
		const container = ref.current;
		if (!container) return;

		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		modalStack.push(container);

		const focusable = getFocusable(container);
		if (initialFocus === "container" || focusable.length === 0) {
			if (!container.hasAttribute("tabindex")) container.setAttribute("tabindex", "-1");
			container.focus();
		} else {
			focusable[0]?.focus();
		}

		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key !== "Tab" || !isTopModal(container)) return;
			const candidates = getFocusable(container);
			if (candidates.length === 0) {
				event.preventDefault();
				return;
			}

			const index = candidates.indexOf(document.activeElement as HTMLElement);
			if (event.shiftKey) {
				if (index <= 0) {
					event.preventDefault();
					candidates[candidates.length - 1]?.focus();
				}
			} else if (index === -1 || index >= candidates.length - 1) {
				event.preventDefault();
				candidates[0]?.focus();
			}
		};

		container.addEventListener("keydown", onKeyDown);
		return () => {
			container.removeEventListener("keydown", onKeyDown);
			const wasTop = isTopModal(container);
			const index = modalStack.lastIndexOf(container);
			if (index !== -1) modalStack.splice(index, 1);
			if (wasTop && opener?.isConnected) opener.focus();
		};
	}, [active, initialFocus]);

	return ref;
}
