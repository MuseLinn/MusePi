import type { WorkspaceSessionInfo } from "@musepi/pi-wire";
import { Check, Loader2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import { useBackLayer } from "../../lib/back-stack";
import { formatWhen, shortenPath } from "../../lib/format";

/**
 * Floating bottom sheet for switching live sessions (openchamber
 * "sessions sheet" parity, iOS 26 / HarmonyOS 6.1 floating frosted-glass card).
 *
 * Unlike the desktop popover / workspace grid, this is a mobile-first modal
 * that floats above the transcript: a rounded frosted-glass card sitting clear
 * of the screen edges, with a grabber handle, elastic rise-in, and drag-to-dismiss.
 *
 * It is only meaningful on multi-session hosts (workspace !== null); the header
 * title becomes the trigger. The current session is marked with the accent.
 */

const DRAG_DISMISS_PX = 120; // downward drag past this dismisses the sheet

export function SessionsSheet({
	sessions,
	currentId,
	onSelect,
	open,
	onClose,
}: {
	sessions: readonly WorkspaceSessionInfo[];
	currentId: string | null;
	onSelect(id: string): void;
	open: boolean;
	onClose(): void;
}): ReactNode {
	const [dragY, setDragY] = useState(0);
	const dragging = useRef(false);
	const startY = useRef(0);

	// Esc closes.
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, onClose]);
	// Reset drag when the sheet (re)opens.
	useEffect(() => {
		if (open) setDragY(0);
	}, [open]);

	const prefersReduced = usePrefersReducedMotion();

	// Always mounted; the visible/closing stage drives the CSS animations.
	// `visible` keeps the DOM during the exit animation so a close never
	// pops the card off screen instantly (DialogFrame convention).
	const [stage, setStage] = useState<"hidden" | "open" | "closing">(open ? "open" : "hidden");
	useEffect(() => {
		setStage(prev => {
			if (open) return "open";
			return prev === "open" ? "closing" : "hidden";
		});
	}, [open]);
	// Android back key closes the sheet first (topmost modal priority 90).
	useBackLayer(
		90,
		open,
		useCallback(() => {
			onClose();
			return true;
		}, [onClose]),
	);
	// Exit animation is ~280ms (card `ss-card-out`); fall back to a timer so
	// the card always hides even if animationend is swallowed (hidden tab).
	// Under reduced motion the CSS disables the animation (`animation: none`),
	// so animationend never fires — hide immediately instead of waiting out
	// the full 280ms on a frozen card.
	const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		if (stage !== "closing") return;
		exitTimer.current = setTimeout(() => setStage("hidden"), prefersReduced ? 0 : 280);
		return () => {
			if (exitTimer.current !== null) clearTimeout(exitTimer.current);
		};
	}, [stage, prefersReduced]);
	const onExitAnimEnd = useCallback((): void => {
		if (stage === "closing") setStage("hidden");
	}, [stage]);

	const onDragStart = useCallback(
		(e: React.PointerEvent) => {
			if (prefersReduced) return;
			dragging.current = true;
			startY.current = e.clientY;
		},
		[prefersReduced],
	);

	const onDragMove = useCallback((e: React.PointerEvent) => {
		if (!dragging.current) return;
		const dy = Math.max(0, e.clientY - startY.current);
		setDragY(dy);
	}, []);

	const onDragEnd = useCallback(() => {
		if (!dragging.current) return;
		dragging.current = false;
		setDragY(current => {
			if (current >= DRAG_DISMISS_PX) onClose();
			return current >= DRAG_DISMISS_PX ? current : 0;
		});
	}, [onClose]);

	if (stage === "hidden") return null;

	return (
		<div className={`ss-backdrop${stage === "closing" ? " ss-closing" : ""}`} role="presentation" onClick={onClose}>
			<div
				className="ss-card"
				role="dialog"
				aria-modal="true"
				aria-label={t("sessions")}
				style={dragY > 0 ? { transform: `translateY(${dragY}px)` } : undefined}
				onClick={e => e.stopPropagation()}
				onAnimationEnd={onExitAnimEnd}
			>
				<div
					className="ss-drag"
					onPointerDown={onDragStart}
					onPointerMove={onDragMove}
					onPointerUp={onDragEnd}
					onPointerCancel={onDragEnd}
				>
					<div className="ss-grabber" aria-hidden />
					<div className="ss-card-head">
						<h2 className="ss-card-title">{t("sessions")}</h2>
						<button type="button" className="ss-close" onClick={onClose} title={t("close")}>
							<X size={15} />
						</button>
					</div>
				</div>
				<div className="ss-list">
					{sessions.length === 0 && <p className="ss-empty">{t("no sessions yet")}</p>}
					{sessions.map(session => {
						const active = session.id === currentId;
						return (
							<button
								key={session.id}
								type="button"
								className={`ss-item${active ? " ss-item--active" : ""}`}
								onClick={() => {
									onSelect(session.id);
									onClose();
								}}
							>
								<span className="ss-item-status" aria-hidden>
									{session.working ? (
										<Loader2 size={13} className="ss-spin" />
									) : (
										<span className={`ss-item-dot${session.paused ? " ss-item-dot--paused" : ""}`} />
									)}
								</span>
								<span className="ss-item-body">
									<span className="ss-item-title">{session.title ?? t("untitled session")}</span>
									{session.cwd && (
										<span className="ss-item-cwd" title={session.cwd}>
											{shortenPath(session.cwd)}
										</span>
									)}
								</span>
								<span className="ss-item-meta">
									<span className="ss-item-count">
										{t("{count} messages", { count: String(session.messageCount) })}
									</span>
									<span className="ss-item-when">{formatWhen(session.updatedAt)}</span>
								</span>
								{active && (
									<span className="ss-item-check" aria-hidden>
										<Check size={14} />
									</span>
								)}
							</button>
						);
					})}
				</div>
			</div>
		</div>
	);
}

function usePrefersReducedMotion(): boolean {
	const [reduced, setReduced] = useState(false);
	useEffect(() => {
		const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
		setReduced(mq.matches);
		const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
		mq.addEventListener("change", onChange);
		return () => mq.removeEventListener("change", onChange);
	}, []);
	return reduced;
}
