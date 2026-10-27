import { type TranslationKey, t } from "@musepi/client-core";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { placeTooltip, TOOLTIP_SHOW_DELAY_MS, TOOLTIP_TOUCH_DELAY_MS } from "../lib/tooltips";

const TOUCH_TRAVEL = 10;

type RailTooltipDetails = { anchor: HTMLElement; label: string; description?: string; extra?: string | null };
type TouchTooltip = RailTooltipDetails & { pointerId: number; x: number; y: number };

export function RailTooltip({
	anchor,
	label,
	description,
	extra,
	suppressed,
}: {
	anchor: HTMLElement | null;
	label?: string;
	description?: string;
	extra?: string | null;
	suppressed: boolean;
}): React.ReactNode {
	const tooltipId = useId();
	const tipRef = useRef<HTMLDivElement | null>(null);
	const touchRef = useRef<TouchTooltip | null>(null);
	const touchTimerRef = useRef<number | null>(null);
	const dismissedRef = useRef<HTMLElement | null>(null);
	const [shown, setShown] = useState(false);
	const [touchTip, setTouchTip] = useState<TouchTooltip | null>(null);
	const [hoveredTip, setHoveredTip] = useState<RailTooltipDetails | null>(null);
	const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
	const currentTip = anchor && label ? { anchor, label, description, extra } : null;
	const retainedTip = touchTip ?? currentTip ?? hoveredTip;
	const activeAnchor = retainedTip?.anchor ?? null;
	const activeLabel = retainedTip?.label;
	const activeDescription = touchTip ? undefined : retainedTip?.description;
	const activeExtra = touchTip ? null : retainedTip?.extra;
	const visible = !suppressed && (touchTip !== null || shown || hoveredTip !== null);
	const labelText = touchTip?.label ?? (activeLabel ? t(activeLabel as TranslationKey) : undefined);

	useEffect(() => {
		if (!anchor || suppressed || touchTip || dismissedRef.current === anchor) {
			setShown(false);
			if (!anchor) dismissedRef.current = null;
			return;
		}
		const id = window.setTimeout(() => {
			if (dismissedRef.current !== anchor) setShown(true);
		}, TOOLTIP_SHOW_DELAY_MS);
		return () => window.clearTimeout(id);
	}, [anchor, suppressed, touchTip]);

	useEffect(() => {
		const onPointerOut = (event: PointerEvent | MouseEvent): void => {
			const tip = tipRef.current;
			const target = event.target instanceof Node ? event.target : null;
			const related = event.relatedTarget instanceof Node ? event.relatedTarget : null;
			if (tip && target && tip.contains(target)) {
				if (related && tip.contains(related)) return;
				setHoveredTip(null);
				setShown(false);
				return;
			}
			if (!anchor || !label || !tip || related !== tip || !target || !anchor.contains(target)) return;
			setHoveredTip({ anchor, label, description, extra });
			setShown(false);
		};
		document.addEventListener("pointerout", onPointerOut, true);
		document.addEventListener("mouseout", onPointerOut, true);
		return () => {
			document.removeEventListener("pointerout", onPointerOut, true);
			document.removeEventListener("mouseout", onPointerOut, true);
		};
	}, [anchor, description, extra, label]);

	useEffect(() => {
		const clearTouchTimer = (): void => {
			if (touchTimerRef.current !== null) window.clearTimeout(touchTimerRef.current);
			touchTimerRef.current = null;
		};
		const finishTouch = (event?: PointerEvent): void => {
			const current = touchRef.current;
			if (!current || (event && event.pointerId !== current.pointerId)) return;
			clearTouchTimer();
			touchRef.current = null;
			setTouchTip(null);
		};
		const onPointerDown = (event: PointerEvent): void => {
			if (event.pointerType !== "touch" || suppressed) return;
			const target = event.target instanceof Element ? event.target : null;
			const button = target?.closest<HTMLElement>(".gui-right-rail-scroll .gui-right-rail-btn");
			if (!button || button.hasAttribute("title")) return;
			const text = button.getAttribute("aria-label")?.trim();
			if (!text) return;
			finishTouch();
			dismissedRef.current = null;
			setHoveredTip(null);
			setShown(false);
			const current: TouchTooltip = {
				anchor: button,
				label: text,
				pointerId: event.pointerId,
				x: event.clientX,
				y: event.clientY,
			};
			touchRef.current = current;
			touchTimerRef.current = window.setTimeout(() => {
				touchTimerRef.current = null;
				if (touchRef.current === current && button.isConnected) setTouchTip(current);
			}, TOOLTIP_TOUCH_DELAY_MS);
		};
		const onPointerMove = (event: PointerEvent): void => {
			const current = touchRef.current;
			if (!current || event.pointerId !== current.pointerId) return;
			const dx = event.clientX - current.x;
			const dy = event.clientY - current.y;
			if (dx * dx + dy * dy > TOUCH_TRAVEL * TOUCH_TRAVEL) finishTouch(event);
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("pointermove", onPointerMove, true);
		document.addEventListener("pointerup", finishTouch, true);
		document.addEventListener("pointercancel", finishTouch, true);
		return () => {
			clearTouchTimer();
			touchRef.current = null;
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("pointermove", onPointerMove, true);
			document.removeEventListener("pointerup", finishTouch, true);
			document.removeEventListener("pointercancel", finishTouch, true);
		};
	}, [suppressed]);

	useEffect(() => {
		if (!suppressed) return;
		if (touchTimerRef.current !== null) window.clearTimeout(touchTimerRef.current);
		touchTimerRef.current = null;
		touchRef.current = null;
		setTouchTip(null);
		setHoveredTip(null);
		setShown(false);
	}, [suppressed]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			if (event.key !== "Escape" || (!anchor && !touchTip && !touchRef.current && !hoveredTip)) return;
			event.preventDefault();
			dismissedRef.current = anchor;
			if (touchTimerRef.current !== null) window.clearTimeout(touchTimerRef.current);
			touchTimerRef.current = null;
			touchRef.current = null;
			setTouchTip(null);
			setHoveredTip(null);
			setShown(false);
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [anchor, hoveredTip, touchTip]);

	useLayoutEffect(() => {
		if (!activeAnchor || !visible || !activeLabel) {
			setPos(null);
			return;
		}
		const place = (): void => {
			const tip = tipRef.current;
			if (!tip) return;
			placeTooltip(tip, activeAnchor, "left", 260);
			setPos({ left: Number.parseFloat(tip.style.left), top: Number.parseFloat(tip.style.top) });
		};
		place();
		document.addEventListener("scroll", place, true);
		window.addEventListener("resize", place);
		return () => {
			document.removeEventListener("scroll", place, true);
			window.removeEventListener("resize", place);
		};
	}, [activeAnchor, activeDescription, activeExtra, activeLabel, visible]);

	useEffect(() => {
		if (!activeAnchor || !visible || !activeLabel) return;
		const descriptions = new Set(
			(activeAnchor.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(token => token.length > 0),
		);
		descriptions.add(tooltipId);
		activeAnchor.setAttribute("aria-describedby", [...descriptions].join(" "));
		return () => {
			const remaining = (activeAnchor.getAttribute("aria-describedby") ?? "")
				.split(/\s+/)
				.filter(token => token.length > 0 && token !== tooltipId);
			if (remaining.length > 0) activeAnchor.setAttribute("aria-describedby", remaining.join(" "));
			else activeAnchor.removeAttribute("aria-describedby");
		};
	}, [activeAnchor, activeLabel, tooltipId, visible]);

	if (!activeAnchor || !visible || !activeLabel) return null;
	return createPortal(
		<div
			ref={tipRef}
			id={tooltipId}
			className={`gui-rail-tooltip${pos ? " gui-rail-tooltip--show" : ""}`}
			style={{
				left: pos?.left ?? 0,
				top: pos?.top ?? 0,
				visibility: pos ? "visible" : "hidden",
			}}
			role="tooltip"
		>
			<span className="gui-rail-tooltip-label">{labelText}</span>
			{activeDescription ? (
				<span className="gui-rail-tooltip-desc">{t(activeDescription as TranslationKey)}</span>
			) : null}
			{activeExtra ? <span className="gui-rail-tooltip-desc">{activeExtra}</span> : null}
		</div>,
		document.getElementById("root") ?? document.body,
	);
}
