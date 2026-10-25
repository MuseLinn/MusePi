import { isTopModal, useModalFocus } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
}: {
	open: boolean;
	onClose(): void;
	children: ReactNode;
	className?: string;
	label: string;
}): ReactNode {
	const [mounted, setMounted] = useState(open);
	const [phase, setPhase] = useState<"enter" | "open" | "closing">(open ? "enter" : "open");
	const rafRef = useRef<number | null>(null);
	const timerRef = useRef<Timer | null>(null);
	const dialogRef = useModalFocus<HTMLDivElement>(mounted);
	const onCloseRef = useRef(onClose);
	const phaseRef = useRef(phase);
	onCloseRef.current = onClose;
	phaseRef.current = phase;

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
				{children}
			</div>
		</div>,
		document.body,
	);
}
