let inited = false;
let tipEl: HTMLDivElement | null = null;
let currentEl: Element | null = null;
let hoveredEl: Element | null = null;
const savedTitles = new WeakMap<Element, string>();
let showTimer: number | null = null;
let hideVisTimer: number | null = null;
let lastMoveX = 0;
let lastMoveY = 0;
let suppressReShow = false;
let touch: { el: Element; pointerId: number; x: number; y: number } | null = null;

const SHOW_DELAY = 250;
const TOUCH_DELAY = 500;
const GAP = 12;
const EDGE = 6;
const MAX_W = 340;
const TRAVEL_RESET = 4;
const TOUCH_TRAVEL = 10;
const TIP_ID = "musepi-gui-tooltip";

function ensureTip(): HTMLDivElement {
	if (!tipEl) {
		tipEl = document.createElement("div");
		tipEl.className = "gui-tooltip";
		tipEl.id = TIP_ID;
		tipEl.setAttribute("role", "tooltip");
		tipEl.setAttribute("aria-hidden", "true");
	}
	if (!tipEl.isConnected) document.body.appendChild(tipEl);
	return tipEl;
}

function findTitled(target: EventTarget | null): Element | null {
	let el = target instanceof Element ? target : null;
	while (el && el !== document.body) {
		const title = el.getAttribute("title");
		if (title && title.trim().length > 0) return el;
		el = el.parentElement;
	}
	return null;
}

function restoreTitle(): void {
	if (hoveredEl === null) return;
	const saved = savedTitles.get(hoveredEl);
	if (saved !== undefined) hoveredEl.setAttribute("title", saved);
	savedTitles.delete(hoveredEl);
	hoveredEl = null;
}

function clearShowTimer(): void {
	if (showTimer === null) return;
	window.clearTimeout(showTimer);
	showTimer = null;
}

function hide(): void {
	clearShowTimer();
	restoreTitle();
	if (currentEl) {
		const remaining = (currentEl.getAttribute("aria-describedby") ?? "")
			.split(/\s+/)
			.filter(token => token.length > 0 && token !== TIP_ID);
		if (remaining.length > 0) currentEl.setAttribute("aria-describedby", remaining.join(" "));
		else currentEl.removeAttribute("aria-describedby");
	}
	currentEl = null;
	if (!tipEl) return;
	tipEl.setAttribute("aria-hidden", "true");
	tipEl.classList.remove("gui-tooltip--show");
	if (hideVisTimer !== null) window.clearTimeout(hideVisTimer);
	hideVisTimer = window.setTimeout(() => {
		hideVisTimer = null;
		if (tipEl && !tipEl.classList.contains("gui-tooltip--show")) tipEl.style.visibility = "hidden";
	}, 140);
}

function positionTip(anchorX: number, anchorY: number): void {
	const tip = ensureTip();
	const maxW = Math.max(0, Math.min(MAX_W, window.innerWidth - 2 * EDGE));
	if (maxW < MAX_W) tip.style.maxWidth = `${maxW}px`;
	else tip.style.removeProperty("max-width");
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

function showFor(el: Element, text: string): void {
	hide();
	currentEl = el;
	if (!savedTitles.has(el)) savedTitles.set(el, el.getAttribute("title") ?? "");
	el.removeAttribute("title");
	hoveredEl = el;
	const tip = ensureTip();
	tip.textContent = text;
	tip.style.visibility = "visible";
	tip.setAttribute("aria-hidden", "false");
	const descriptions = new Set(
		(el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(token => token.length > 0),
	);
	descriptions.add(TIP_ID);
	el.setAttribute("aria-describedby", [...descriptions].join(" "));
	if (hideVisTimer !== null) {
		window.clearTimeout(hideVisTimer);
		hideVisTimer = null;
	}
	const rect = el.getBoundingClientRect();
	positionTip(rect.left + rect.width / 2, rect.bottom);
	tip.classList.add("gui-tooltip--show");
}

function scheduleShow(el: Element, text: string, delay = SHOW_DELAY): void {
	hoveredEl = el;
	if (!savedTitles.has(el)) savedTitles.set(el, el.getAttribute("title") ?? "");
	el.removeAttribute("title");
	clearShowTimer();
	showTimer = window.setTimeout(() => {
		showTimer = null;
		if (hoveredEl !== el || !el.isConnected) return;
		showFor(el, text);
	}, delay);
}

function onPointerOver(event: PointerEvent): void {
	if (event.pointerType === "touch" || event.target === tipEl) return;
	const el = findTitled(event.target);
	if (!el || el === currentEl) return;
	const text = el.getAttribute("title")?.trim() ?? "";
	if (!text) return;
	if (!savedTitles.has(el)) savedTitles.set(el, el.getAttribute("title") ?? "");
	el.removeAttribute("title");
	hoveredEl = el;
	if (suppressReShow) return;
	scheduleShow(el, text);
}

function onPointerDown(event: PointerEvent): void {
	if (event.pointerType !== "touch") return;
	const el = findTitled(event.target);
	if (!el) return;
	const text = el.getAttribute("title")?.trim() ?? "";
	if (!text) return;
	hide();
	touch = { el, pointerId: event.pointerId, x: event.clientX, y: event.clientY };
	scheduleShow(el, text, TOUCH_DELAY);
}

function onPointerMove(event: PointerEvent): void {
	if (event.pointerType === "touch") {
		if (!touch || event.pointerId !== touch.pointerId || showTimer === null) return;
		const dx = event.clientX - touch.x;
		const dy = event.clientY - touch.y;
		if (dx * dx + dy * dy > TOUCH_TRAVEL * TOUCH_TRAVEL) hide();
		return;
	}
	if (suppressReShow && findTitled(event.target) === null) suppressReShow = false;
	if (hoveredEl && showTimer !== null) {
		const dx = event.clientX - lastMoveX;
		const dy = event.clientY - lastMoveY;
		if (dx * dx + dy * dy > TRAVEL_RESET * TRAVEL_RESET) {
			scheduleShow(hoveredEl, savedTitles.get(hoveredEl) ?? "");
		}
	}
	lastMoveX = event.clientX;
	lastMoveY = event.clientY;
}

function onPointerOut(event: PointerEvent): void {
	const related = event.relatedTarget instanceof Node ? event.relatedTarget : null;
	if (related) {
		if (currentEl?.contains(related)) return;
		if (hoveredEl?.contains(related)) return;
	}
	suppressReShow = currentEl !== null && related !== null && findTitled(related) !== null;
	hide();
}

function finishTouch(event: PointerEvent): void {
	if (!touch || event.pointerId !== touch.pointerId) return;
	const el = touch.el;
	touch = null;
	if (hoveredEl === el || currentEl === el) hide();
}

function onFocusIn(event: FocusEvent): void {
	if (touch || event.target === tipEl) return;
	const el = findTitled(event.target);
	if (!el || el === currentEl) return;
	const text = el.getAttribute("title")?.trim() ?? "";
	if (!text) return;
	const rect = el.getBoundingClientRect();
	if (rect.width === 0 && rect.height === 0) return;
	showFor(el, text);
}

/** Install the shared document-level tooltip behavior. */
export function initTooltips(): void {
	if (inited) return;
	inited = true;
	document.addEventListener("pointerover", onPointerOver);
	document.addEventListener("pointerdown", onPointerDown);
	document.addEventListener("pointerout", onPointerOut);
	document.addEventListener("pointermove", onPointerMove);
	document.addEventListener("pointerup", finishTouch);
	document.addEventListener("pointercancel", finishTouch);
	document.addEventListener("focusin", onFocusIn);
	document.addEventListener("focusout", hide);
	document.addEventListener("scroll", hide, true);
	document.addEventListener("wheel", hide, true);
	document.addEventListener(
		"keydown",
		event => {
			if (event.key === "Escape") hide();
		},
		true,
	);
	window.addEventListener("blur", hide);
	window.addEventListener("resize", hide);
}
