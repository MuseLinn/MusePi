import { isTopModal, useModalFocus } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HeightMorph } from "./HeightMorph";

function motionIsOff(): boolean {
	return (
		document.documentElement.classList.contains("gui-motion-off") ||
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

/**
 * Modal dialog shell with the same two-phase enter / closing exit the
 * floating menus use (Pop.tsx): the first frame paints at opacity 0 with no
 * animation class so the frosted backdrop composites before the fade starts
 * (no transparent→glassy flash), then `--entered` runs the scale/fade-in;
 * flipping `open` false keeps the dialog mounted through the exit animation
 * before unmounting.
 *
 * Host renders this unconditionally and drives it with `open` — do NOT
 * conditionally mount the dialog yourself or the exit animation is lost.
 */
export function DialogFrame({
	open,
	onClose,
	children,
	className,
	label,
	morphKey,
	originRect,
}: {
	open: boolean;
	onClose(): void;
	children: ReactNode;
	className?: string;
	label: string;
	/**
	 * Content identity for the size morph: when it changes, the dialog springs
	 * from its old height to the new one instead of jumping. Pass something
	 * that names the state being shown (a step, a connector id + its open
	 * panels). Omit when the dialog's height is fixed.
	 */
	morphKey?: unknown;
	/**
	 * Viewport rectangle of the control that opened this dialog. When set, the
	 * dialog's surface grows from that rectangle into place (one continuous
	 * move) instead of scaling up on its own; the content fades in as the
	 * surface lands. Dialogs with no visible trigger omit it and keep the
	 * standard entrance.
	 */
	originRect?: { left: number; top: number; width: number; height: number } | null;
}): ReactNode {
	const [mounted, setMounted] = useState(open);
	const [phase, setPhase] = useState<"enter" | "open" | "closing">(open ? "enter" : "open");
	/** True while the shared-origin move runs; suppresses the built-in entrance. */
	const [originActive, setOriginActive] = useState(false);
	const rafRef = useRef<number | null>(null);
	const timerRef = useRef<Timer | null>(null);
	const dialogRef = useModalFocus<HTMLDivElement>(mounted);
	const morphRef = useRef<HTMLDivElement | null>(null);
	const originPlayed = useRef(false);
	const onCloseRef = useRef(onClose);
	const phaseRef = useRef(phase);
	onCloseRef.current = onClose;
	phaseRef.current = phase;

	useEffect(() => {
		if (!open) originPlayed.current = false;
	}, [open]);

	/**
	 * Shared-origin entrance: the dialog's own surface travels and scales from
	 * the trigger's rectangle, so one element carries the whole move — there is
	 * no second panel to hand over from. The content is counter-scaled to its
	 * natural size and clipped by the frame, which therefore grows a window
	 * around the content instead of stretching it.
	 *
	 * 260ms with an ease-out curve, not the spring the size morph uses: a
	 * dialog is an arrival, and a settling spring reads as lag on a move this
	 * large.
	 */
	useLayoutEffect(() => {
		if (!mounted || !open || !originRect || originPlayed.current) return;
		if (originRect.width < 1 || originRect.height < 1) return;
		if (motionIsOff()) return;
		const dialog = dialogRef.current;
		if (!dialog) return;
		originPlayed.current = true;
		dialog.classList.add("gui-dialog--from-origin");
		// React owns className: a phase re-render would drop the imperative class
		// and let the entrance animation start underneath the move.
		setOriginActive(true);
		// The pending class carries a scale; neutralize it before measuring, or
		// the target rectangle would be the shrunken one.
		void dialog.offsetHeight;
		const target = dialog.getBoundingClientRect();
		if (target.width < 1 || target.height < 1) {
			dialog.classList.remove("gui-dialog--from-origin");
			return;
		}

		const wrapper = morphRef.current;
		const scaleX = originRect.width / target.width;
		const scaleY = originRect.height / target.height;
		const offsetX = originRect.left - target.left;
		const offsetY = originRect.top - target.top;
		const radiusTo = Number.parseFloat(getComputedStyle(dialog).borderRadius) || 16;
		// Pin the first frame inline so no paint can show the dialog at its
		// final size before the animation's first frame lands.
		const startTransform = `translate(${offsetX}px, ${offsetY}px) scale(${scaleX}, ${scaleY})`;
		// Both the frame and its counter-scaled content must share a top-left
		// origin, or the content slides against the frame while it grows.
		dialog.style.transformOrigin = "top left";
		dialog.style.transform = startTransform;
		dialog.style.borderRadius = `${Math.min(radiusTo, 12)}px`;
		if (wrapper) {
			wrapper.style.transformOrigin = "top left";
			wrapper.style.transform = `scale(${1 / scaleX}, ${1 / scaleY})`;
		}
		const overflowBefore = dialog.style.overflow;
		dialog.style.overflow = "hidden";

		const anim = dialog.animate(
			[
				{ transform: startTransform, borderRadius: `${Math.min(radiusTo, 12)}px` },
				{ transform: "none", borderRadius: `${radiusTo}px` },
			],
			{ duration: 260, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "both" },
		);
		let done = false;
		const settle = (): void => {
			if (done) return;
			done = true;
			anim.cancel();
			setOriginActive(false);
			dialog.classList.remove("gui-dialog--from-origin");
			dialog.style.transform = "";
			dialog.style.transformOrigin = "";
			dialog.style.borderRadius = "";
			dialog.style.overflow = overflowBefore;
			if (wrapper) {
				wrapper.style.transform = "";
				wrapper.style.transformOrigin = "";
			}
		};
		anim.addEventListener("finish", settle);
		return settle;
	}, [dialogRef, mounted, open, originRect]);

	useEffect(() => {
		if (!mounted) return;
		const onKey = (e: KeyboardEvent): void => {
			const dialog = dialogRef.current;
			if (!dialog || !isTopModal(dialog) || e.key !== "Escape" || phaseRef.current === "closing") return;
			e.preventDefault();
			e.stopPropagation();
			onCloseRef.current();
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [mounted, dialogRef]);

	useEffect(() => {
		if (open) {
			setMounted(true);
			setPhase("enter");
			// Two rAF hops: first paints the transparent frame, second adds
			// the animation class — same pattern as useFloatingMenu. A timer
			// fallback covers throttled rAF (hidden/background tabs).
			const advance = (): void => {
				rafRef.current = requestAnimationFrame(() => {
					rafRef.current = requestAnimationFrame(() => setPhase("open"));
				});
			};
			advance();
			timerRef.current = setTimeout(() => {
				if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
				setPhase("open");
			}, 80);
			return () => {
				if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
				if (timerRef.current !== null) clearTimeout(timerRef.current);
			};
		}
		setPhase("closing");
		const t = setTimeout(() => setMounted(false), 180);
		return () => clearTimeout(t);
	}, [open]);

	if (!mounted) return null;

	const backdropCls = `gui-dialog-backdrop${
		phase === "enter"
			? " gui-dialog-backdrop--pending"
			: phase === "closing"
				? " gui-dialog-backdrop--closing"
				: " gui-dialog-backdrop--entered"
	}`;
	const dialogCls = `gui-dialog${className ? ` ${className}` : ""}${
		originActive
			? " gui-dialog--from-origin"
			: phase === "enter"
				? " gui-dialog--pending"
				: phase === "closing"
					? " gui-dialog--closing"
					: " gui-dialog--entered"
	}`;

	// Portal to document.body: a backdrop-filter ancestor (e.g. the
	// settings view) creates a containing block that hijacks position:fixed
	// — the dialog would be clipped/misplaced inside the panel instead of
	// covering the viewport (observed: API-key import dialog cut off).
	return createPortal(
		<div className={backdropCls} onClick={onClose}>
			<div
				ref={dialogRef}
				className={dialogCls}
				role="dialog"
				aria-modal="true"
				aria-label={label}
				onClick={e => e.stopPropagation()}
			>
				<HeightMorph
					morphKey={morphKey ?? null}
					className="gui-dialog-morph"
					innerRef={morphRef}
					fade={!originRect}
				>
					{children}
				</HeightMorph>
			</div>
		</div>,
		document.body,
	);
}
