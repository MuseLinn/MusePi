import type { WorkspaceSessionInfo } from "@musepi/pi-wire";
import { Check, Loader2, Pencil, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import { useBackLayer } from "../../lib/back-stack";
import type { SessionClient } from "../../lib/client";
import { formatWhen, shortenPath } from "../../lib/format";
import { haptic } from "../../lib/haptics";

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
	client,
	sessions,
	currentId,
	onSelect,
	open,
	onClose,
}: {
	client: SessionClient;
	sessions: readonly WorkspaceSessionInfo[];
	currentId: string | null;
	onSelect(id: string): void;
	open: boolean;
	onClose(): void;
}): ReactNode {
	const [dragY, setDragY] = useState(0);
	const dragging = useRef(false);
	const startY = useRef(0);
	// Only one row may sit open at a time (iOS list convention) — the sheet
	// owns the swiped id so opening row B snaps row A shut.
	const [swipedId, setSwipedId] = useState<string | null>(null);

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
				className={`ss-card${stage === "closing" ? " ss-closing" : ""}`}
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
							<SwipeableRow
								key={session.id}
								client={client}
								session={session}
								active={active}
								anySwiped={swipedId !== null && swipedId !== session.id}
								onSwiped={setSwipedId}
								onSelect={() => {
									onSelect(session.id);
									onClose();
								}}
							/>
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

/** Reveal width of the trailing action pair (rename + delete, 68px each + 6 gap). */
const SWIPE_ACTIONS_PX = 142;

/**
 * One session row with iOS-style trailing swipe actions (design 二期 F4):
 * pointer-drag follows the finger, past half the reveal width (or a quick
 * flick) it snaps open; otherwise it springs shut. Delete uses an inline
 * two-step confirm (the button itself turns solid red) instead of a system
 * dialog. Rename swaps the title for an inline input; Enter commits.
 */
function SwipeableRow({
	client,
	session,
	active,
	anySwiped,
	onSwiped,
	onSelect,
}: {
	client: SessionClient;
	session: WorkspaceSessionInfo;
	active: boolean;
	anySwiped: boolean;
	onSwiped(id: string | null): void;
	onSelect(): void;
}): ReactNode {
	const [offset, setOffset] = useState(0); // ≤ 0; negative = revealed
	const [dragging, setDragging] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [renaming, setRenaming] = useState(false);
	const [title, setTitle] = useState(session.title ?? "");
	const startX = useRef(0);
	const baseAtStart = useRef(0);
	const moved = useRef(false);

	const open = offset <= -SWIPE_ACTIONS_PX + 2;
	// Row state resets when another row opens.
	useEffect(() => {
		if (anySwiped) {
			setOffset(0);
			setConfirming(false);
		}
	}, [anySwiped]);

	const onPointerDown = useCallback(
		(e: React.PointerEvent) => {
			startX.current = e.clientX;
			baseAtStart.current = offset;
			moved.current = false;
			setDragging(true);
		},
		[offset],
	);

	const onPointerMove = useCallback(
		(e: React.PointerEvent) => {
			if (!dragging) return;
			const dx = e.clientX - startX.current;
			if (!moved.current && Math.abs(dx) > 6) {
				moved.current = true;
				e.currentTarget.setPointerCapture(e.pointerId);
				haptic(8);
			}
			if (!moved.current) return;
			setOffset(Math.max(-SWIPE_ACTIONS_PX - 24, Math.min(0, baseAtStart.current + dx)));
		},
		[dragging],
	);

	const onPointerUp = useCallback(
		(e: React.PointerEvent) => {
			if (!dragging) return;
			setDragging(false);
			if (moved.current) {
				const dx = e.clientX - startX.current;
				const willOpen = offset < -SWIPE_ACTIONS_PX / 2 || (dx < -40 && Math.abs(offset) > 8);
				setOffset(willOpen ? -SWIPE_ACTIONS_PX : 0);
				if (willOpen) {
					haptic(12);
					onSwiped(session.id);
					setConfirming(false);
				} else {
					onSwiped(null);
				}
			}
		},
		[dragging, offset, onSwiped, session.id],
	);

	const commitRename = useCallback(async () => {
		const next = title.trim();
		setRenaming(false);
		if (!next || next === (session.title ?? "")) return;
		try {
			await client.rpc("session.rename", { sessionId: session.id, title: next });
			haptic(8);
		} catch {
			// Tree subscription will re-broadcast the unchanged title.
		}
	}, [client, session.id, session.title, title]);

	const doDelete = useCallback(async () => {
		if (!confirming) {
			setConfirming(true);
			haptic(30);
			return;
		}
		try {
			await client.rpc("session.delete", { sessionId: session.id });
			haptic(15);
		} catch {
			// Deletion failures surface through the workspace tree state.
		}
	}, [client, confirming, session.id]);

	return (
		<div className="ss-swipe">
			<div className="ss-swipe-actions" aria-hidden={open}>
				<button
					type="button"
					className="ss-swipe-btn ss-swipe-btn--rename"
					onClick={() => {
						setTitle(session.title ?? "");
						setRenaming(true);
						haptic(8);
					}}
				>
					<Pencil size={13} aria-hidden />
					<span>{t("rename")}</span>
				</button>
				<button
					type="button"
					className={`ss-swipe-btn${confirming ? " ss-swipe-btn--confirm" : " ss-swipe-btn--delete"}`}
					onClick={() => void doDelete()}
				>
					<Trash2 size={13} aria-hidden />
					<span>{confirming ? t("confirm delete?") : t("delete")}</span>
				</button>
			</div>
			{renaming ? (
				<div className="ss-item ss-item--active ss-rename">
					<input
						className="ss-rename-input"
						value={title}
						autoFocus
						onChange={e => setTitle(e.target.value)}
						onKeyDown={e => {
							if (e.key === "Enter") void commitRename();
							if (e.key === "Escape") setRenaming(false);
						}}
						onBlur={() => void commitRename()}
						aria-label={t("rename")}
					/>
				</div>
			) : (
				<button
					type="button"
					className={`ss-item${active ? " ss-item--active" : ""}`}
					style={{
						transform: `translateX(${offset}px)`,
						transition: dragging ? "none" : undefined,
					}}
					onClick={() => {
						if (moved.current) return;
						if (open) {
							setOffset(0);
							onSwiped(null);
							return;
						}
						onSelect();
					}}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerCancel={onPointerUp}
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
			)}
		</div>
	);
}
