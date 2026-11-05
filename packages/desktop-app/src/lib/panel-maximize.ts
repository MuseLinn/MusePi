import { flushSync } from "react-dom";

/**
 * Right-panel maximize/restore — the panel's only controller.
 *
 * ContextPanel renders the chrome but never toggles: its buttons carry
 * `data-panel-maximize`, and this document-level controller owns the click,
 * the store, the class, the measured geometry and the FLIP morph. Compiled
 * surfaces that still render the sprite `#oc-fullscreen` glyph go through the
 * same path instead of growing a second toggle.
 *
 * Geometry: the maximized box is the SESSION column (`.gui-chat-column`) inside
 * `.gui-chat-surface`. The surface also contains this panel and the rail, and
 * the collapsed panel's session-info dock rides beside the session, so the
 * column is selected by content — never by being "the first column in the
 * surface".
 */

const MAXIMIZED_CLASS = "gui-pane-right--maximized";
const MAXIMIZE_GLYPH = 'use[href="#oc-fullscreen"], use[href="#oc-fullscreen-exit"]';
const GEOMETRY = ["left", "top", "width", "height"] as const;
const MAXIMIZE_VARS = ["--pane-max-left", "--pane-max-top", "--pane-max-width", "--pane-max-height"] as const;
const SPRING =
	"left 260ms var(--spring), top 260ms var(--spring), width 260ms var(--spring), height 260ms var(--spring)";

let maximized = false;
const listeners = new Set<() => void>();

export function getPanelMaximized(): boolean {
	return maximized;
}

export function subscribePanelMaximize(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function setPanelMaximized(next: boolean): void {
	if (next === maximized) return;
	maximized = next;
	for (const listener of listeners) listener();
}

/** The session column a panel maximizes over; null when no surface/column exists. */
export function panelMaximizeColumn(panel: HTMLElement | null): HTMLElement | null {
	if (!panel) return null;
	const surface = panel.closest<HTMLElement>(".gui-chat-surface");
	if (!surface) return null;
	const columns = [...surface.querySelectorAll<HTMLElement>(".gui-chat-column")].filter(
		column => !panel.contains(column),
	);
	return columns.find(column => column.querySelector(".gui-transcript-wrap")) ?? columns[0] ?? null;
}

/** Write the session column's box onto --pane-max-*; the panel's CSS paints it. */
export function measurePanelMaximizedGeometry(panel: HTMLElement): void {
	const rect = panelMaximizeColumn(panel)?.getBoundingClientRect();
	if (!rect) return;
	panel.style.setProperty("--pane-max-left", `${rect.left}px`);
	panel.style.setProperty("--pane-max-top", `${rect.top}px`);
	panel.style.setProperty("--pane-max-width", `${rect.width}px`);
	panel.style.setProperty("--pane-max-height", `${rect.height}px`);
}

export function clearPanelMaximizedGeometry(panel: HTMLElement): void {
	for (const property of MAXIMIZE_VARS) panel.style.removeProperty(property);
}

function motionDisabled(): boolean {
	return (
		document.body.closest(".gui-motion-off") !== null ||
		document.querySelector(".gui-motion-off") !== null ||
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

function clearGeometry(panel: HTMLElement): void {
	for (const property of GEOMETRY) panel.style.removeProperty(property);
	panel.style.removeProperty("transition");
}

interface MaximizeMorph {
	/** Docked inline width, restored verbatim so restore never lands on the CSS fallback. */
	dockedWidth: string;
	/** Stop the morph in place; the caller re-pins the frozen box. */
	cancel(): void;
}

const morphs = new WeakMap<HTMLElement, MaximizeMorph>();
/** Docked width per panel, kept for the whole maximized session. */
const dockedWidths = new WeakMap<HTMLElement, string>();

/**
 * Commit `next` on one panel and morph to it.
 *
 * A click that lands mid-morph reverses from the box the user currently sees
 * (`getBoundingClientRect` of the animated element) instead of being dropped;
 * the previous morph is cancelled first so its transitionend/timeout cannot
 * clear the new one's geometry.
 */
export function updatePanelMaximized(panel: HTMLElement, next: boolean): void {
	// Freeze whatever is on screen now: a maximize must start at the docked box,
	// and a reversal must start at the interpolated box, not the layout box.
	panel.style.transition = "none";
	const first = panel.getBoundingClientRect();
	const inFlight = morphs.get(panel);
	// React clears the inline docked width while maximized, so the value has to
	// outlive the maximize morph or restore falls back to the CSS minimum.
	const dockedBefore = panel.style.width;
	const recordedWidth = inFlight?.dockedWidth || dockedWidths.get(panel) || "";
	inFlight?.cancel();

	// The store drives every React-owned bit of chrome (labels, pressed state,
	// icon, and the inline docked width). Committing it here — before the FLIP
	// pins geometry — keeps a deferred render from rewriting width mid-morph.
	flushSync(() => setPanelMaximized(next));
	panel.classList.toggle(MAXIMIZED_CLASS, next);
	if (next) measurePanelMaximizedGeometry(panel);

	// React owns the docked width, so pick up what it just committed (a resize
	// while maximized may have clamped it); the recorded width is only the
	// fallback for renderers that never set one inline.
	const dockedWidth = next ? recordedWidth || dockedBefore || `${first.width}px` : panel.style.width || recordedWidth;
	if (next) dockedWidths.set(panel, dockedWidth);
	const restoreDockedWidth = (): void => {
		if (dockedWidth) panel.style.width = dockedWidth;
	};
	if (motionDisabled()) {
		clearGeometry(panel);
		if (!next) restoreDockedWidth();
		return;
	}

	// The docked box comes from the panel's own width (React's inline px or the
	// CSS fallback), never from the maximized vars. Left/top/height still carry
	// the frozen morph, so drop them before measuring; the inline `transition:
	// none` stays until after `last` so the class switch cannot animate the
	// measured target (that captured 1244 and "never restored" the docked 395).
	for (const property of ["left", "top", "height"] as const) panel.style.removeProperty(property);
	panel.style.removeProperty("width");
	if (!next) restoreDockedWidth();
	const last = panel.getBoundingClientRect();
	const finalWidth = next ? "" : dockedWidth || `${last.width}px`;
	if (finalWidth) dockedWidths.set(panel, finalWidth);

	if (next) {
		panel.style.left = `${first.left}px`;
		panel.style.top = `${first.top}px`;
		panel.style.width = `${first.width}px`;
		panel.style.height = `${first.height}px`;
	} else {
		// Relative positioning: left/top offset the element VISUALLY from its
		// layout box. The panel is a RIGHT-ANCHORED flex item, so the layout left
		// sweeps with the width — pin the old box at the pinned width, then
		// animate the offset back to zero.
		panel.style.width = `${first.width}px`;
		panel.style.height = `${first.height}px`;
		const pinned = panel.getBoundingClientRect();
		panel.style.left = `${first.left - pinned.left}px`;
		panel.style.top = `${first.top - pinned.top}px`;
	}
	void panel.getBoundingClientRect();
	panel.style.transition = SPRING;
	panel.style.left = next ? `${last.left}px` : "0px";
	panel.style.top = next ? `${last.top}px` : "0px";
	panel.style.width = `${last.width}px`;
	panel.style.height = `${last.height}px`;

	let timer = 0;
	let done = false;
	let record: MaximizeMorph;
	const finish = (): void => {
		if (done) return;
		done = true;
		panel.removeEventListener("transitionend", onEnd);
		if (timer) window.clearTimeout(timer);
		clearGeometry(panel);
		if (!next) panel.style.width = finalWidth;
		if (morphs.get(panel) === record) morphs.delete(panel);
	};
	function onEnd(event: TransitionEvent): void {
		if (event.target !== panel || event.propertyName !== "width") return;
		finish();
	}
	record = { dockedWidth, cancel: finish };
	morphs.set(panel, record);
	panel.addEventListener("transitionend", onEnd);
	// Safety net: transitionend never fires when the tab is hidden or the width
	// lands on its target instantly.
	timer = window.setTimeout(finish, 300);
}

/**
 * Drop maximize without a morph. The width drag owns the panel's geometry once
 * it starts, so an in-flight morph must not keep writing width underneath it.
 */
export function exitPanelMaximized(panel: HTMLElement | null): void {
	if (!panel) {
		setPanelMaximized(false);
		return;
	}
	const inFlight = morphs.get(panel);
	inFlight?.cancel();
	flushSync(() => setPanelMaximized(false));
	panel.classList.remove(MAXIMIZED_CLASS);
	clearPanelMaximizedGeometry(panel);
	const dockedWidth = inFlight?.dockedWidth || dockedWidths.get(panel) || panel.style.width;
	clearGeometry(panel);
	if (dockedWidth) panel.style.width = dockedWidth;
}

function maximizeButtonFrom(target: EventTarget | null): HTMLButtonElement | null {
	if (!(target instanceof Element)) return null;
	const button = target.closest<HTMLButtonElement>(".gui-pane-tool");
	if (!button) return null;
	if (button.hasAttribute("data-panel-maximize")) return button;
	return button.querySelector(MAXIMIZE_GLYPH) ? button : null;
}

/**
 * Install the single click controller. It runs in the capture phase so a tab
 * strip or dnd ancestor cannot cancel the toggle, and it is the only handler
 * that writes the maximize state.
 */
export function installPanelMaximizeController(): () => void {
	const onClick = (event: MouseEvent): void => {
		const button = maximizeButtonFrom(event.target);
		const panel = button?.closest<HTMLElement>(".gui-pane-right--inner");
		if (!panel) return;
		event.stopPropagation();
		updatePanelMaximized(panel, !panel.classList.contains(MAXIMIZED_CLASS));
	};
	const onResize = (): void => {
		const panel = document.querySelector<HTMLElement>(`.${MAXIMIZED_CLASS}`);
		if (panel) measurePanelMaximizedGeometry(panel);
	};
	document.addEventListener("click", onClick, true);
	window.addEventListener("resize", onResize);
	return () => {
		document.removeEventListener("click", onClick, true);
		window.removeEventListener("resize", onResize);
	};
}
