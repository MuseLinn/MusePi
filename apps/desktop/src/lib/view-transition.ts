import { motionDisabled } from "@musepi/client-core";
import { flushSync } from "react-dom";

type ViewTransitionDocument = Document & {
	startViewTransition?: (update: () => void) => { finished: Promise<void> };
};

/**
 * View Transitions for a surface that has a visible trigger — the browser's
 * own shared-element transition (what HarmonyOS calls 共享元素转场 / 一镜到底).
 *
 * The trigger element is named for the OLD snapshot only; the destination
 * (a dialog) carries the same `view-transition-name` in CSS. The browser
 * matches the two rectangles, animates position and size on one composited
 * group, and cross-fades the content — no hand-written transforms, no second
 * panel, and the content of either side never stretches because each snapshot
 * is drawn at its own size.
 */

/** A CSS custom-ident for a shared surface: `prefix` + a sanitized id. */
export function surfaceName(prefix: string, id: string): string {
	return `${prefix}-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

/** Motion must be allowed by the runtime, the app toggle, and the OS setting. */
export function sharedSurfaceTransitionAllowed(): boolean {
	const doc = globalThis.document as ViewTransitionDocument | undefined;
	if (!doc?.startViewTransition) return false;
	return !motionDisabled();
}

/**
 * Marker + transition bootstrap shared by every one-take entry point: the
 * class tells the dialog CSS to skip its own entrance while the browser owns
 * the geometry, and it leaves with the transition.
 */
function beginTransition(doc: ViewTransitionDocument, update: () => void): { finished: Promise<void> } {
	document.documentElement.classList.add("gui-view-transition");
	const transition = doc.startViewTransition(() => flushSync(update));
	void transition.finished.finally(() => {
		document.documentElement.classList.remove("gui-view-transition");
	});
	return transition;
}

/**
 * Run `update` inside a same-document view transition with `element` as the
 * shared rectangle. Falls back to a plain update where the API or motion is
 * unavailable, so the dialog keeps its ordinary entrance.
 */
export function morphSurfaceFrom(element: Element | null, name: string, update: () => void): void {
	const doc = globalThis.document as ViewTransitionDocument | undefined;
	if (!element || !doc?.startViewTransition || !sharedSurfaceTransitionAllowed()) {
		update();
		return;
	}
	const origin = element as HTMLElement;
	// A dialog that is still exiting from the last open holds the same name via
	// CSS; two elements with one name make the browser ignore both, which is the
	// "sometimes it just fades" case. The origin is what should carry it now.
	for (const dialog of document.querySelectorAll<HTMLElement>(".gui-dialog")) {
		if (dialog === origin) continue;
		if (getComputedStyle(dialog).viewTransitionName === name) dialog.style.viewTransitionName = "none";
	}
	const previous = origin.style.viewTransitionName;
	origin.style.viewTransitionName = name;
	const transition = beginTransition(doc, () => {
		// The new state must hold exactly one element with this name: the
		// destination is what carries it now.
		origin.style.viewTransitionName = previous;
		update();
	});
	void transition.finished.finally(() => {
		origin.style.viewTransitionName = previous;
	});
}

/**
 * The reverse move, for a dialog that closes back to its trigger.
 *
 * The dialog already carries the name in the old snapshot (its class supplies
 * it). Inside the update the leaving dialog drops it and the destination takes
 * it, so the new state names exactly one element and the browser pairs the two
 * rectangles in the other direction.
 */
export function morphSurfaceBack(from: Element | null, to: Element | null, name: string, update: () => void): void {
	const doc = globalThis.document as ViewTransitionDocument | undefined;
	if (!to || !doc?.startViewTransition || !sharedSurfaceTransitionAllowed()) {
		update();
		return;
	}
	const destination = to as HTMLElement;
	const leaving = from as HTMLElement | null;
	const previous = destination.style.viewTransitionName;
	const transition = beginTransition(doc, () => {
		if (leaving) leaving.style.viewTransitionName = "none";
		destination.style.viewTransitionName = name;
		update();
	});
	void transition.finished.finally(() => {
		destination.style.viewTransitionName = previous;
		if (leaving) leaving.style.viewTransitionName = "";
	});
}

/**
 * A plain same-document transition for a layout change (grid ⇄ list). Named
 * elements morph individually; everything else cross-fades, which is the
 * "shared container" half of Huawei's one-take: the container's bounds and its
 * children's movement read as one continuous change.
 */
export function withViewTransition(update: () => void): void {
	const doc = globalThis.document as ViewTransitionDocument | undefined;
	if (!doc?.startViewTransition || !sharedSurfaceTransitionAllowed()) {
		update();
		return;
	}
	beginTransition(doc, update);
}
