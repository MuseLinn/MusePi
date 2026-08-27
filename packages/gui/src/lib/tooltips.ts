/**
 * Unified tooltip layer (统一悬浮提示).
 *
 * Problem: the app uses native `title` attributes everywhere (icon buttons,
 * truncated rows, the message-tree "从此处在新会话中继续"…). In the
 * Electron window, Chromium positions the native tooltip at the cursor and
 * it gets CLIPPED at the window/screen edge — the message-tree tooltip was
 * cut off mid-text on the right side of the window.
 *
 * This module replaces EVERY native title tooltip with one shared floating
 * tooltip:
 *   - document-level delegation reads `title` at hover time (no markup
 *     changes, covers the transcript/tr-action buttons too);
 *   - the attribute is temporarily removed while the tooltip shows so the
 *     native tooltip (which would otherwise appear ~1s later and double up)
 *     never fires, and restored on leave;
 *   - the tooltip appears once, CENTERED BELOW the hovered element
 *     (图标按钮正下方), fully visible at its final position — it does NOT
 *     follow the cursor and never repositions while shown; the hover delay
 *     only counts while the pointer rests (it never trails a moving
 *     cursor);
 *   - moving onto another titled element swaps the text immediately
 *     (no hide gap); leaving titled areas hides it;
 *   - hides on scroll/wheel/Escape/blur/resize.
 *
 * `aria-label` and the `title` attribute itself are untouched for
 * non-hover consumers; a11y is preserved.
 */

let inited = false;
let tipEl: HTMLDivElement | null = null;
/** Element the tooltip is currently shown for. */
let currentEl: Element | null = null;
/** Element whose `title` is currently suppressed (removed from the DOM). */
let hoveredEl: Element | null = null;
const savedTitles = new WeakMap<Element, string>();
let showTimer: ReturnType<typeof setTimeout> | null = null;
/** Hides the tooltip element AFTER the fade-out transition completes
 *  (visibility is not transitioned in CSS — a differing visibility delay
 *  between the two class states cancels the whole fade in Chromium). */
let hideVisTimer: ReturnType<typeof setTimeout> | null = null;
/** Last pointer position — the rest-to-show delay counts only while the
 *  pointer stays within this (the tooltip appears where the element is,
 *  not where the cursor stopped). */
let lastMoveX = 0;
let lastMoveY = 0;
/** While true, pointerovers do not schedule a show (the pointer is hopping
 *  between titled elements after a hide — no re-show until it leaves titled
 *  areas, so the tooltip never jumps from anchor to anchor). */
let suppressReShow = false;

const SHOW_DELAY = 250;
const GAP = 12;
const EDGE = 6;
const MAX_W = 340;
/** Pointer travel beyond this (px) resets the pending hover delay. */
const TRAVEL_RESET = 4;

const TIP_ID = "musepi-gui-tooltip";

function ensureTip(): HTMLDivElement {
	if (!tipEl) {
		tipEl = document.createElement("div");
		tipEl.className = "gui-tooltip";
		tipEl.id = TIP_ID;
		tipEl.setAttribute("role", "tooltip");
		tipEl.setAttribute("aria-hidden", "true");
		document.body.appendChild(tipEl);
	}
	return tipEl;
}

/** Closest element (self or ancestor) with a non-empty `title`. */
function findTitled(target: EventTarget | null): Element | null {
	let el = target instanceof Element ? target : null;
	while (el && el !== document.body) {
		const t = el.getAttribute("title");
		if (t && t.trim().length > 0) return el;
		el = el.parentElement;
	}
	return null;
}

function restoreTitle(): void {
	if (hoveredEl !== null) {
		const saved = savedTitles.get(hoveredEl);
		if (saved !== undefined) hoveredEl.setAttribute("title", saved);
		savedTitles.delete(hoveredEl);
		hoveredEl = null;
	}
}

function hide(): void {
	if (showTimer !== null) {
		clearTimeout(showTimer);
		showTimer = null;
	}
	restoreTitle();
	if (currentEl !== null && currentEl.getAttribute("aria-describedby") === TIP_ID) {
		currentEl.removeAttribute("aria-describedby");
	}
	currentEl = null;
	if (tipEl) {
		tipEl.setAttribute("aria-hidden", "true");
		tipEl.classList.remove("gui-tooltip--show");
		// Let the fade-out play, then drop visibility so the element no
		// longer exists for AT/pointer purposes.
		if (hideVisTimer !== null) clearTimeout(hideVisTimer);
		hideVisTimer = setTimeout(() => {
			hideVisTimer = null;
			if (tipEl !== null && !tipEl.classList.contains("gui-tooltip--show")) {
				tipEl.style.visibility = "hidden";
			}
		}, 140);
	}
}

/**
 * Position the tooltip CENTERED BELOW the hovered element (正下方), clamped
 * inside the viewport; when it would overflow the bottom it moves above the
 * element. Element-anchored (not cursor-anchored): deterministic, never
 * follows, never jumps. Called ONCE per show — the position can never
 * change while the tooltip is visible.
 */
function positionTip(anchorX: number, anchorY: number): void {
	const tip = ensureTip();
	// Shrink the cap for tiny windows so the clamp can always fit it.
	const maxW = Math.min(MAX_W, window.innerWidth - 2 * EDGE);
	if (maxW < MAX_W) tip.style.maxWidth = `${maxW}px`;
	const w = tip.offsetWidth;
	const h = tip.offsetHeight;
	let left = anchorX - w / 2;
	left = Math.max(EDGE, Math.min(left, window.innerWidth - w - EDGE));
	let top = anchorY + GAP;
	if (top + h > window.innerHeight - EDGE) top = anchorY - h - GAP;
	top = Math.max(EDGE, Math.min(top, window.innerHeight - h - EDGE));
	tip.style.left = `${left}px`;
	tip.style.top = `${top}px`;
}

/** Bottom-center anchor of the hovered element (its rect at show time). */
function elementAnchor(el: Element): { x: number; y: number } {
	const r = el.getBoundingClientRect();
	return { x: r.left + r.width / 2, y: r.bottom };
}

function showFor(el: Element, text: string): void {
	hide();
	currentEl = el;
	// Suppress the native tooltip (it would appear later, clipped at the
	// window edge); restore on leave.
	if (!savedTitles.has(el)) savedTitles.set(el, el.getAttribute("title") ?? "");
	el.removeAttribute("title");
	hoveredEl = el;
	const tip = ensureTip();
	tip.textContent = text;
	// A previous hide's fade-out timer may have set visibility:hidden —
	// make sure the show is actually visible from its first frame.
	tip.style.visibility = "visible";
	tip.setAttribute("aria-hidden", "false");
	// Announce the tooltip to AT: point the trigger element at it.
	el.setAttribute("aria-describedby", TIP_ID);
	if (hideVisTimer !== null) {
		clearTimeout(hideVisTimer);
		hideVisTimer = null;
	}
	const a = elementAnchor(el);
	positionTip(a.x, a.y);
	tip.classList.add("gui-tooltip--show");
}

function onPointerOver(e: PointerEvent): void {
	if (e.target === tipEl) return;
	const el = findTitled(e.target);
	if (!el) return;
	if (el === currentEl) return;
	const text = el.getAttribute("title")?.trim() ?? "";
	if (!text) return;
	// Kill the NATIVE tooltip for ANY hovered titled element, immediately:
	// Chromium would show it ~1s later centered under the element (the
	// user's "先居中后偏移" — two tooltips stacked). The title is restored
	// on leave by hide()/restoreTitle().
	if (!savedTitles.has(el)) savedTitles.set(el, el.getAttribute("title") ?? "");
	el.removeAttribute("title");
	hoveredEl = el;
	// While hopping between titled elements (the previous tooltip hid when
	// the pointer left it), do NOT immediately re-show at the next element
	// — the tooltip only reappears after the pointer left titled areas and
	// rests again. Without this, moving across adjacent buttons made the
	// tooltip "jump" from one anchor to the next.
	if (suppressReShow) return;
	// Any pointer movement that leaves the current element hides the tooltip
	// (onPointerOut) — a VISIBLE tooltip never changes position.
	scheduleShow(el, text);
}

function onPointerMove(e: PointerEvent): void {
	// Re-show is allowed again once the pointer left titled areas.
	if (suppressReShow && findTitled(e.target) === null) suppressReShow = false;
	// Native hover semantics: the delay counts only while the pointer RESTS.
	// While a show is pending, travelling beyond the threshold restarts the
	// delay — the tooltip appears only after the pointer stops moving.
	if (hoveredEl !== null && showTimer !== null) {
		const dx = e.clientX - lastMoveX;
		const dy = e.clientY - lastMoveY;
		if (dx * dx + dy * dy > TRAVEL_RESET * TRAVEL_RESET) {
			// The title attribute was already suppressed on hover — reuse
			// the saved text.
			scheduleShow(hoveredEl, savedTitles.get(hoveredEl) ?? "");
		}
	}
	lastMoveX = e.clientX;
	lastMoveY = e.clientY;
}

function onPointerOut(e: PointerEvent): void {
	const related = e.relatedTarget instanceof Node ? e.relatedTarget : null;
	if (related !== null) {
		if (currentEl?.contains(related)) return;
		if (hoveredEl?.contains(related)) return;
	}
	// Leaving the element (to a non-descendant) hides the tooltip. When a
	// VISIBLE tooltip's element is left for another titled element,
	// suppress the immediate re-show so the tooltip can't hop across
	// adjacent elements (a plain pass-through with nothing shown must not
	// block the next hover).
	suppressReShow = currentEl !== null && related !== null && findTitled(related) !== null;
	hide();
}

/** Start (or restart) the pending-show timer for `el`. */
function scheduleShow(el: Element, text: string): void {
	hoveredEl = el;
	// Suppress the NATIVE tooltip immediately on hover: Chromium shows it
	// after ~1s positioned centered under the element — while the custom
	// tooltip's rest-to-show delay can be reset indefinitely by pointer
	// micro-movement, the title must be gone from the moment of hover, or
	// the native tooltip pops (centered) before the custom one (at the
	// cursor) — the user's "先居中后偏移" two-tooltip effect. Restored on
	// hide (pointerout / scroll / …).
	if (!savedTitles.has(el)) savedTitles.set(el, el.getAttribute("title") ?? "");
	el.removeAttribute("title");
	if (showTimer !== null) {
		clearTimeout(showTimer);
		showTimer = null;
	}
	showTimer = setTimeout(() => {
		showTimer = null;
		// The pointer may have moved to another titled element meanwhile.
		if (hoveredEl !== el || !el.isConnected) return;
		showFor(el, text);
	}, SHOW_DELAY);
}

/**
 * Keyboard focus: native `title` tooltips also show when an element is
 * focused via Tab — the replacement must keep that. Focus has no cursor,
 * so the tooltip anchors at the element's bottom-center (the native
 * position) and shows immediately (no hover delay).
 */
function onFocusIn(e: FocusEvent): void {
	if (e.target === tipEl) return;
	const el = findTitled(e.target);
	if (!el) return;
	if (el === currentEl) return;
	const text = el.getAttribute("title")?.trim() ?? "";
	if (!text) return;
	const r = el.getBoundingClientRect();
	if (r.width === 0 && r.height === 0) return; // not laid out
	showFor(el, text);
}

function onFocusOut(): void {
	hide();
}

/** Install the document-level tooltip interception (idempotent). */
export function initTooltips(): void {
	if (inited) return;
	inited = true;
	document.addEventListener("pointerover", onPointerOver);
	document.addEventListener("pointerout", onPointerOut);
	document.addEventListener("pointermove", onPointerMove);
	document.addEventListener("focusin", onFocusIn);
	document.addEventListener("focusout", onFocusOut);
	// Capture: inner scroll containers must also dismiss the tooltip.
	document.addEventListener("scroll", hide, true);
	document.addEventListener("wheel", hide, true);
	document.addEventListener(
		"keydown",
		e => {
			if (e.key === "Escape") hide();
		},
		true,
	);
	window.addEventListener("blur", hide);
	window.addEventListener("resize", hide);
}
