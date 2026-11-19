import { animateSpring, isTopModal, MORPH_SPRING, useModalFocus } from "@musepi/client-core";
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
	 * Shared-origin entrance: the surface travels from the trigger's rectangle
	 * to the dialog's own, then hands over to the real frame. The dialog itself
	 * never scales, so text is never stretched — a sheet carries the growing
	 * surface and the content fades in underneath as it lands.
	 */
	useLayoutEffect(() => {
		if (!mounted || !open || !originRect || originPlayed.current) return;
		if (originRect.width < 1 || originRect.height < 1) return;
		if (motionIsOff()) return;
		const dialog = dialogRef.current;
		if (!dialog) return;
		originPlayed.current = true;
		dialog.classList.add("gui-dialog--from-origin");
		// The pending class carries a scale; neutralize it before measuring, or
		// the target rectangle would be the shrunken one.
		void dialog.offsetHeight;
		const target = dialog.getBoundingClientRect();
		if (target.width < 1 || target.height < 1) {
			dialog.classList.remove("gui-dialog--from-origin");
			return;
		}

		const wrapper = morphRef.current;
		if (wrapper) wrapper.style.opacity = "0";
		const sheet = document.createElement("div");
		sheet.className = "gui-dialog-origin-sheet";
		sheet.style.left = `${originRect.left}px`;
		sheet.style.top = `${originRect.top}px`;
		sheet.style.width = `${originRect.width}px`;
		sheet.style.height = `${originRect.height}px`;
		document.body.appendChild(sheet);

		const radiusFrom = Math.min(12, Math.max(6, originRect.height / 6));
		const radiusTo = Number.parseFloat(getComputedStyle(dialog).borderRadius) || 16;
		let settled = false;
		let stop: (() => void) | undefined;
		const settle = (): void => {
			if (settled) return;
			settled = true;
			stop?.();
			sheet.remove();
			dialog.classList.remove("gui-dialog--from-origin");
			if (wrapper) wrapper.style.opacity = "";
		};
		stop = animateSpring(
			{ from: 0, to: 1, ...MORPH_SPRING, maxDuration: (MORPH_SPRING.visualDuration ?? 0.44) * 2 },
			progress => {
				sheet.style.left = `${originRect.left + (target.left - originRect.left) * progress}px`;
				sheet.style.top = `${originRect.top + (target.top - originRect.top) * progress}px`;
				sheet.style.width = `${originRect.width + (target.width - originRect.width) * progress}px`;
				sheet.style.height = `${originRect.height + (target.height - originRect.height) * progress}px`;
				sheet.style.borderRadius = `${radiusFrom + (radiusTo - radiusFrom) * progress}px`;
				if (wrapper) {
					wrapper.style.opacity = `${Math.max(0, Math.min(1, (progress - 0.6) / 0.4))}`;
				}
			},
			settle,
		);
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
		phase === "enter" ? " gui-dialog--pending" : phase === "closing" ? " gui-dialog--closing" : " gui-dialog--entered"
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
