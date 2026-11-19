import { isTopModal, useModalFocus } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HeightMorph } from "./HeightMorph";

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
}): ReactNode {
	const [mounted, setMounted] = useState(open);
	const [phase, setPhase] = useState<"enter" | "open" | "closing">(open ? "enter" : "open");
	const rafRef = useRef<number | null>(null);
	const timerRef = useRef<Timer | null>(null);
	const dialogRef = useModalFocus<HTMLDivElement>(mounted);
	/**
	 * Opened by a shared-surface view transition: the browser already animated
	 * the geometry, so the dialog's own entrance must never start afterwards —
	 * a second animation on the same open would read as a flash.
	 */
	const entranceSuppressed = useRef(false);
	if (open && !mounted) {
		entranceSuppressed.current = document.documentElement.classList.contains("gui-view-transition");
	}
	if (!open) entranceSuppressed.current = false;
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
		// Handed off to another surface inside a one-take: the browser already
		// owns the leaving snapshot. Running our own 180ms exit as well leaves a
		// fading copy of this dialog in the NEW snapshot, which reads as a flash
		// under the incoming one (detail → device sign-in).
		if (document.documentElement.classList.contains("gui-view-transition")) {
			setMounted(false);
			return;
		}
		const t = setTimeout(() => setMounted(false), 180);
		return () => clearTimeout(t);
	}, [open]);

	if (!mounted) return null;

	const suppressed = entranceSuppressed.current;
	const backdropCls = `gui-dialog-backdrop${
		phase === "closing"
			? " gui-dialog-backdrop--closing"
			: suppressed
				? " gui-dialog-backdrop--static"
				: phase === "enter"
					? " gui-dialog-backdrop--pending"
					: " gui-dialog-backdrop--entered"
	}`;
	const dialogCls = `gui-dialog${className ? ` ${className}` : ""}${
		phase === "closing"
			? " gui-dialog--closing"
			: suppressed
				? " gui-dialog--static"
				: phase === "enter"
					? " gui-dialog--pending"
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
				<HeightMorph morphKey={morphKey ?? null} className="gui-dialog-morph">
					{children}
				</HeightMorph>
			</div>
		</div>,
		document.body,
	);
}
