import { shellPlatform } from "./electron";

export const TOOLTIP_SHOW_DELAY_MS = 150;
export const TOOLTIP_TOUCH_DELAY_MS = 500;

const HIDE_DELAY_MS = 120;
const GAP = 8;
const EDGE = 6;
const MAX_W = 340;
const TOUCH_TRAVEL = 10;
const TIP_ID = "musepi-gui-tooltip";

type TooltipPlacement = "top" | "bottom" | "left" | "right";

type AnchorRect = Pick<DOMRect, "top" | "right" | "bottom" | "left" | "width" | "height">;
type TooltipSize = { width: number; height: number };
type ViewportSize = { width: number; height: number };

function computeTooltipPosition(
	anchor: AnchorRect,
	size: TooltipSize,
	viewport: ViewportSize,
	preferred: TooltipPlacement = "bottom",
): { left: number; top: number; placement: TooltipPlacement } {
	let placement = preferred;
	if (preferred === "bottom" || preferred === "top") {
		const fitsPreferred =
			preferred === "bottom"
				? anchor.bottom + GAP + size.height <= viewport.height - EDGE
				: anchor.top - GAP - size.height >= EDGE;
		const opposite = preferred === "bottom" ? "top" : "bottom";
		const fitsOpposite =
			opposite === "bottom"
				? anchor.bottom + GAP + size.height <= viewport.height - EDGE
				: anchor.top - GAP - size.height >= EDGE;
		const oppositeSpace = preferred === "bottom" ? anchor.top : viewport.height - anchor.bottom;
		const preferredSpace = preferred === "bottom" ? viewport.height - anchor.bottom : anchor.top;
		if (!fitsPreferred && (fitsOpposite || oppositeSpace > preferredSpace)) placement = opposite;
	} else {
		const fitsPreferred =
			preferred === "left"
				? anchor.left - GAP - size.width >= EDGE
				: anchor.right + GAP + size.width <= viewport.width - EDGE;
		const opposite = preferred === "left" ? "right" : "left";
		const fitsOpposite =
			opposite === "left"
				? anchor.left - GAP - size.width >= EDGE
				: anchor.right + GAP + size.width <= viewport.width - EDGE;
		const oppositeSpace = preferred === "left" ? viewport.width - anchor.right : anchor.left;
		const preferredSpace = preferred === "left" ? anchor.left : viewport.width - anchor.right;
		if (!fitsPreferred && (fitsOpposite || oppositeSpace > preferredSpace)) placement = opposite;
	}

	let left = anchor.left + anchor.width / 2 - size.width / 2;
	let top = anchor.top + anchor.height / 2 - size.height / 2;
	if (placement === "bottom") top = anchor.bottom + GAP;
	else if (placement === "top") top = anchor.top - size.height - GAP;
	else if (placement === "left") left = anchor.left - size.width - GAP;
	else left = anchor.right + GAP;

	return {
		left: Math.max(EDGE, Math.min(left, viewport.width - size.width - EDGE)),
		top: Math.max(EDGE, Math.min(top, viewport.height - size.height - EDGE)),
		placement,
	};
}

/** Places a tooltip beside its anchor, flipping and clamping to the viewport.
 * @param tip Tooltip element measured after its content is laid out.
 * @param anchor Trigger whose current client rect owns the position.
 * @param preferred Side to try before collision fallback.
 * @param maxWidth Content width cap before the viewport margin is applied.
 * @returns Nothing; coordinates and the resolved placement are written to `tip`.
 */
export function placeTooltip(
	tip: HTMLElement,
	anchor: Element,
	preferred: TooltipPlacement = "bottom",
	maxWidth = MAX_W,
): void {
	const maxW = Math.max(0, Math.min(maxWidth, window.innerWidth - 2 * EDGE));
	if (maxW < maxWidth) tip.style.maxWidth = `${maxW}px`;
	else tip.style.removeProperty("max-width");
	const position = computeTooltipPosition(
		anchor.getBoundingClientRect(),
		{ width: tip.offsetWidth, height: tip.offsetHeight },
		{ width: window.innerWidth, height: window.innerHeight },
		preferred,
	);
	tip.style.left = `${position.left}px`;
	tip.style.top = `${position.top}px`;
	tip.dataset.placement = position.placement;
}

let inited = false;
let tipEl: HTMLDivElement | null = null;
let pendingEl: Element | null = null;
let shownEl: Element | null = null;
let hoveredEl: Element | null = null;
let focusedEl: Element | null = null;
let titleEl: Element | null = null;
let dismissedEl: Element | null = null;
let touchFocusEl: Element | null = null;
let tipHovered = false;
let showTimer: number | null = null;
let hideTimer: number | null = null;
let touch: { el: Element; pointerId: number; x: number; y: number } | null = null;
const savedTitles = new WeakMap<Element, string>();

function ensureTip(): HTMLDivElement {
	if (!tipEl) {
		tipEl = document.createElement("div");
		tipEl.className = "gui-tooltip";
		tipEl.id = TIP_ID;
		tipEl.setAttribute("role", "tooltip");
		tipEl.setAttribute("aria-hidden", "true");
		tipEl.style.visibility = "hidden";
	}
	if (!tipEl.isConnected) document.body.appendChild(tipEl);
	return tipEl;
}

function tooltipText(el: Element): string {
	return (el.getAttribute("title") ?? savedTitles.get(el))?.trim() ?? "";
}

function findTitled(target: EventTarget | null): Element | null {
	let el = target instanceof Element ? target : null;
	while (el && el !== document.body) {
		if (tooltipText(el)) return el;
		el = el.parentElement;
	}
	return null;
}

function restoreTitle(): void {
	if (!titleEl) return;
	const saved = savedTitles.get(titleEl);
	if (saved !== undefined) titleEl.setAttribute("title", saved);
	savedTitles.delete(titleEl);
	titleEl = null;
}

function saveTitle(el: Element): void {
	if (titleEl && titleEl !== el) restoreTitle();
	if (!savedTitles.has(el)) savedTitles.set(el, el.getAttribute("title") ?? "");
	titleEl = el;
	el.removeAttribute("title");
}

function clearShowTimer(): void {
	if (showTimer !== null) window.clearTimeout(showTimer);
	showTimer = null;
}

function reducedMotion(): boolean {
	return (
		document.documentElement.classList.contains("gui-motion-off") ||
		(typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches)
	);
}

function hide(restore = true): void {
	clearShowTimer();
	pendingEl = null;
	tipHovered = false;
	if (shownEl) {
		const remaining = (shownEl.getAttribute("aria-describedby") ?? "")
			.split(/\s+/)
			.filter(token => token.length > 0 && token !== TIP_ID);
		if (remaining.length > 0) shownEl.setAttribute("aria-describedby", remaining.join(" "));
		else shownEl.removeAttribute("aria-describedby");
	}
	shownEl = null;
	if (restore) restoreTitle();
	if (!tipEl) return;
	tipEl.setAttribute("aria-hidden", "true");
	tipEl.classList.remove("gui-tooltip--show");
	if (hideTimer !== null) window.clearTimeout(hideTimer);
	if (reducedMotion()) {
		tipEl.style.visibility = "hidden";
		hideTimer = null;
		return;
	}
	hideTimer = window.setTimeout(() => {
		hideTimer = null;
		if (tipEl && !tipEl.classList.contains("gui-tooltip--show")) tipEl.style.visibility = "hidden";
	}, HIDE_DELAY_MS);
}

function show(el: Element, text: string): void {
	const tip = ensureTip();
	if (hideTimer !== null) window.clearTimeout(hideTimer);
	hideTimer = null;
	shownEl = el;
	tip.textContent = text;
	tip.style.visibility = "visible";
	tip.setAttribute("aria-hidden", "false");
	const descriptions = new Set(
		(el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(token => token.length > 0),
	);
	descriptions.add(TIP_ID);
	el.setAttribute("aria-describedby", [...descriptions].join(" "));
	placeTooltip(tip, el);
	tip.classList.add("gui-tooltip--show");
}

function schedule(el: Element, text: string, delay = TOOLTIP_SHOW_DELAY_MS): void {
	if (shownEl === el || pendingEl === el || dismissedEl === el) return;
	hide();
	saveTitle(el);
	pendingEl = el;
	showTimer = window.setTimeout(() => {
		showTimer = null;
		if (pendingEl !== el || !el.isConnected || dismissedEl === el) return;
		pendingEl = null;
		show(el, text);
	}, delay);
}

function interestEnded(el: Element): boolean {
	return hoveredEl !== el && focusedEl !== el && touch?.el !== el && !tipHovered;
}

function leave(el: Element): void {
	if (interestEnded(el) && (pendingEl === el || shownEl === el || titleEl === el)) hide();
}

function onPointerOver(event: PointerEvent): void {
	if (event.pointerType === "touch") return;
	if (tipEl && event.target instanceof Node && tipEl.contains(event.target)) {
		tipHovered = true;
		return;
	}
	const el = findTitled(event.target);
	if (!el) return;
	hoveredEl = el;
	dismissedEl = null;
	schedule(el, tooltipText(el));
}

function onPointerOut(event: PointerEvent): void {
	if (event.pointerType === "touch") return;
	const related = event.relatedTarget instanceof Node ? event.relatedTarget : null;
	if (tipEl && event.target instanceof Node && tipEl.contains(event.target)) {
		if (related && tipEl.contains(related)) return;
		tipHovered = false;
		if (shownEl) leave(shownEl);
		return;
	}
	if (!hoveredEl) return;
	const el = hoveredEl;
	if (related && el.contains(related)) return;
	hoveredEl = null;
	if (related && tipEl?.contains(related)) {
		tipHovered = true;
		return;
	}
	if (dismissedEl === el) dismissedEl = null;
	leave(el);
}

function onPointerDown(event: PointerEvent): void {
	if (event.pointerType !== "touch") {
		touchFocusEl = null;
		return;
	}
	const el = findTitled(event.target);
	if (!el) return;
	const text = tooltipText(el);
	if (!text) return;
	hide();
	touchFocusEl = el;
	dismissedEl = null;
	touch = { el, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
	schedule(el, text, TOOLTIP_TOUCH_DELAY_MS);
}

function onPointerMove(event: PointerEvent): void {
	if (event.pointerType !== "touch" || !touch || event.pointerId !== touch.pointerId) return;
	const dx = event.clientX - touch.x;
	const dy = event.clientY - touch.y;
	if (dx * dx + dy * dy <= TOUCH_TRAVEL * TOUCH_TRAVEL) return;
	touch = null;
	hide();
}

function finishTouch(event: PointerEvent): void {
	if (!touch || event.pointerId !== touch.pointerId) return;
	touch = null;
	hide();
}

function onFocusIn(event: FocusEvent): void {
	if (touch || event.target === tipEl) return;
	const el = findTitled(event.target);
	if (!el || touchFocusEl === el) return;
	const rect = el.getBoundingClientRect();
	if (rect.width === 0 && rect.height === 0) return;
	focusedEl = el;
	dismissedEl = null;
	schedule(el, tooltipText(el));
}

function onFocusOut(event: FocusEvent): void {
	const el = focusedEl;
	focusedEl = null;
	if (event.target === touchFocusEl) touchFocusEl = null;
	if (!el) return;
	if (dismissedEl === el) dismissedEl = null;
	leave(el);
}

function reposition(): void {
	if (!shownEl || !tipEl) return;
	if (!shownEl.isConnected) {
		hide();
		return;
	}
	placeTooltip(tipEl, shownEl);
}

export function initTooltips(): void {
	document.documentElement.dataset.platform = shellPlatform();
	if (inited) return;
	inited = true;
	ensureTip();
	document.addEventListener("pointerover", onPointerOver);
	document.addEventListener("pointerdown", onPointerDown);
	document.addEventListener("pointerout", onPointerOut);
	document.addEventListener("pointermove", onPointerMove);
	document.addEventListener("pointerup", finishTouch);
	document.addEventListener("pointercancel", finishTouch);
	document.addEventListener("focusin", onFocusIn);
	document.addEventListener("focusout", onFocusOut);
	document.addEventListener("scroll", reposition, true);
	document.addEventListener("wheel", reposition, true);
	document.addEventListener(
		"keydown",
		event => {
			if (event.key !== "Escape" || (!pendingEl && !shownEl)) return;
			event.preventDefault();
			dismissedEl = pendingEl ?? shownEl;
			hide(false);
		},
		true,
	);
	window.addEventListener("blur", () => {
		hoveredEl = null;
		focusedEl = null;
		touch = null;
		dismissedEl = null;
		hide();
	});
	window.addEventListener("resize", reposition);
}
