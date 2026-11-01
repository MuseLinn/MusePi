/**
 * Pet bubbles (pet-bubbles.tsx) — the pet's activity/message cards.
 *
 * Window hosting history: dedicated bubble window (双窗口) → merged into
 * the pet window (single window, 2026-09-16) → SPLIT BACK OUT into
 * bubbles.html (2026-09-21, user: 气泡应该和桌宠分开窗口). The merged
 * single-window absolute positioning is what made the bubbles clip at the
 * screen edge and overlap the main window: the stack grew the pet window
 * upward from its bottom-anchored rect with no work-area awareness, and
 * the 320px-wide window's left:50% centre often landed the stack over the
 * app window. The split window is sized to its content, pinned above the
 * sprite with proper work-area clamping, and hidden when empty.
 *
 * 2026-09-21 redesign (kimi-work bubble parity, user review screenshots):
 *  - the single-click interaction PANEL is gone (user: 单击弹窗删除) — a
 *    single click on the pet greets it and raises the main window instead;
 *    everything the panel did now lives on the bubbles themselves
 *  - hovering a bubble reveals its quick actions: ✓ confirm (approval →
 *    批准, other cards → 关闭), ✗ deny on approval bubbles, and 💬 回复 on
 *    session bubbles — the reply button expands an inline input that sends
 *    via petReply (no panel hop)
 *
 * Session cards are authoritative: the main window pushes working and unread
 * main sessions. A stacked card with multiple items expands first; an expanded
 * card opens its session and leaves the list expanded. Quick actions, inline
 * replies and approvals stay on the cards. Dismissal never marks a session read.
 *
 * One pet-side control advances expanded → stacked → count → stacked. Count
 * mode hides this window; it never marks sessions read. Expanded mode has only
 * a small clear-all control above the list.
 *
 * The standalone window is content-sized. The renderer reports content bounds,
 * interactive bounds (including overhanging controls) and occupancy. Count mode
 * and an empty stack both hide the window. The main process pins its bottom 8px
 * above the sprite and follows every pet move.
 */

import { setLocale, t } from "@musepi/client-core";
import { isValidElement, type ReactNode, useEffect, useRef, useState } from "react";
import type { PetActivity, PetSessionCard } from "./lib/pet";
import { useScrollShadow } from "./lib/use-scroll-shadow";

interface PetBubblesBridge {
	onPetActivity?(cb: (payload: PetActivity) => void): () => void;
	/** A global approval hotkey (Ctrl/Cmd+Shift+Y / N) decided a request —
	 *  drop the bubble. */
	onPetApprovalResolved?(cb: (payload: { requestId: string; approved: boolean }) => void): () => void;
	petReply?(text: string, sessionId?: string): Promise<unknown>;
	petApprove?(requestId: string, approved: boolean): Promise<unknown>;
	/** ■ on a working session card → abort that session (main window owns
	 *  the RPC; fires session.abort on the target session). */
	petStopSession?(sessionId: string): Promise<unknown>;
	focusMainWindow?(): Promise<unknown>;
	petOpenSession?(sessionId: string): Promise<unknown>;
	/** Report the content size the window must take (CSS px). The main
	 *  process sizes the bubbles window to exactly this. */
	setBubblesContentSize?(size: { width: number; height: number }): Promise<unknown>;
	/** Report whether any bubble is showing — empty stack hides the
	 *  window entirely. */
	setBubblesVisible?(visible: boolean): Promise<unknown>;
	/** Mirror the collapse mode + live item count to the pet-side control. */
	bubblesSetMode?(mode: "expanded" | "stacked" | "hidden", count: number): Promise<unknown>;
	/** The pet-side control requested expanded → stacked → hidden → stacked. */
	onBubblesAdvance?(cb: () => void): () => void;
	/** Report the interactive card union (window-relative CSS px) — the
	 *  main process keeps the transparent padding ring click-through. */
	setBubblesHitbox?(rect: { x: number; y: number; width: number; height: number } | null): Promise<unknown>;
	/** Ask the main window to re-push its latest pet state (on mount — the
	 *  push also carries the active pet descriptor, which this window
	 *  cannot read from localStorage under file://). */
	requestPetState?(): Promise<unknown>;
}

const BUBBLE_MS = 8000;
const MAX_VISIBLE_BUBBLES = 5;

function bubbleMotionOff(): boolean {
	return (
		document.documentElement.classList.contains("gui-motion-off") ||
		window.matchMedia("(prefers-reduced-motion: reduce)").matches
	);
}

/** Stack collapse state (kimi-work parity): the full list, the single
 *  stacked card, or fully hidden behind a count badge by the pet. */
type StackMode = "expanded" | "stacked" | "hidden";

interface Bubble {
	id: number;
	kind: string;
	text: string;
	/** Session this notification belongs to — click opens it directly and
	 *  回复 routes to it. */
	sessionId?: string;
	/** Tool-approval request — ✓/✗ on the hover actions decide it. */
	requestId?: string;
	visible: string;
}

/** Remember dismissal per activity revision, not only per phase. A later turn
 *  must be able to surface the same session again. */
function sessionActivityKey(card: PetSessionCard): string {
	const revision = card.activityKey?.trim();
	if (revision) return ["revision", card.sessionId, revision].join("\0");
	return ["legacy", card.sessionId, card.title, card.phase, card.statusText, card.replyPreview ?? ""].join("\0");
}

/** Short tag shown on each notification card so the four notification
 *  kinds are distinguishable at a glance. Session CARDS don't need a tag —
 *  their title row identifies them. Unknown kinds get no tag rather than a
 *  misleading one: the daemon may add kinds before this window learns
 *  about them. */
function bubbleKindLabel(kind: string): string | null {
	switch (kind) {
		case "completed":
			return t("settings.petBubbleKindCompleted");
		case "error":
			return t("settings.petBubbleKindError");
		case "question":
			return t("settings.petBubbleKindQuestion");
		case "subtask":
			return t("settings.petBubbleKindSubtask");
		default:
			return null;
	}
}

export function PetBubbles(): ReactNode {
	// Transient + approval notifications (session-scoped completion/error
	// pushes are superseded by the authoritative session cards).
	const [bubbles, setBubbles] = useState<Bubble[]>([]);
	// Authoritative session cards pushed by the main window (working +
	// unread finished sessions).
	const [cards, setCards] = useState<PetSessionCard[]>([]);
	// iOS Notification-Center style collapse: stacked shows the top card +
	// "N more" chip; expanded the full list; hidden only the count badge.
	const [stackMode, setStackMode] = useState<StackMode>("stacked");
	// Size morph between collapse states: capture the old size on switch,
	// render the new view locked to that size, then transition (spring).
	const [stackMorph, setStackMorph] = useState<{ from: { width: number; height: number } } | null>(null);
	const stackRef = useRef<HTMLDivElement | null>(null);
	// Dismissals and notifications are scoped to an activity revision. A poll
	// with the same snapshot cannot undo the user's action; a new turn can.
	const hiddenSessionsRef = useRef<Map<string, string>>(new Map());
	const notifiedSessionsRef = useRef<Map<string, { activityKey: string; kinds: Set<string> }>>(new Map());
	const dismissedRequestIdsRef = useRef<Set<string>>(new Set());
	const notifiedRequestIdsRef = useRef<Set<string>>(new Set());
	// The newest actionable notification moves to the front once. Ordinary
	// polls retain the existing order instead of repeatedly stealing priority.
	const priorityItemRef = useRef<string | null>(null);
	const nextBubbleIdRef = useRef(1);
	// Inline reply: which card/bubble's input is open (null = none). Keys:
	// `c:<sessionId>` for session cards, `b:<bubble id>` for bubbles.
	const [replyFor, setReplyFor] = useState<string | null>(null);
	const [replyText, setReplyText] = useState("");
	const [sending, setSending] = useState(false);
	const bridge = (window as unknown as { electronAPI?: PetBubblesBridge }).electronAPI;

	// pet:activity — session cards, bubbles, approvals, theme/locale push.
	useEffect(() => {
		const promote = (key: string): void => {
			priorityItemRef.current = key;
			// A genuinely new notification leaves count mode, but an unchanged
			// polling snapshot never reopens cards the user hid.
			setStackMode(current => (current === "hidden" ? "stacked" : current));
		};
		const off = bridge?.onPetActivity?.(payload => {
			if (Array.isArray(payload.sessions)) {
				const hidden = hiddenSessionsRef.current;
				for (const card of payload.sessions) {
					const kind = card.phase === "working" ? null : card.phase;
					if (!kind) continue;
					const activityKey = sessionActivityKey(card);
					let notified = notifiedSessionsRef.current.get(card.sessionId);
					if (!notified || notified.activityKey !== activityKey) {
						notified = { activityKey, kinds: new Set() };
						notifiedSessionsRef.current.set(card.sessionId, notified);
					}
					if (!notified.kinds.has(kind)) {
						notified.kinds.add(kind);
						if (hidden.get(card.sessionId) !== activityKey) promote(`c:${card.sessionId}`);
					}
				}
				// Authoritative list — replace wholesale. Dismissal memory is
				// keyed by activity revision so a later turn can reappear.
				setCards(
					payload.sessions.filter(card => {
						const activityKey = sessionActivityKey(card);
						const dismissed = hidden.get(card.sessionId);
						if (dismissed === activityKey) return false;
						if (dismissed) hidden.delete(card.sessionId);
						return true;
					}),
				);
			}
			if (payload.approval?.requestId) {
				const approval = payload.approval;
				const { requestId } = approval;
				if (!dismissedRequestIdsRef.current.has(requestId) && !notifiedRequestIdsRef.current.has(requestId)) {
					notifiedRequestIdsRef.current.add(requestId);
					const id = nextBubbleIdRef.current++;
					promote(`b:${id}`);
					setBubbles(prev =>
						prev.some(b => b.requestId === requestId)
							? prev
							: [
									...prev,
									{
										id,
										kind: "question",
										text: t("settings.petApprovalWithTool", { tool: approval.tool }),
										requestId,
										visible: "",
									},
								].slice(-MAX_VISIBLE_BUBBLES),
					);
				}
			}
			if (payload.bubble?.text) {
				const bubble = payload.bubble;
				// Session-scoped completion/error pushes are OWNED by the
				// authoritative session cards — skip them here so a
				// background session never double-notifies.
				const superseded = !!bubble.sessionId && (bubble.kind === "completed" || bubble.kind === "error");
				const dismissedRequest = !!bubble.requestId && dismissedRequestIdsRef.current.has(bubble.requestId);
				if (!superseded && !dismissedRequest) {
					const newRequest = !!bubble.requestId && !notifiedRequestIdsRef.current.has(bubble.requestId);
					if (bubble.requestId && newRequest) notifiedRequestIdsRef.current.add(bubble.requestId);
					const id = nextBubbleIdRef.current++;
					const actionable = bubble.kind === "question" || bubble.kind === "error" || bubble.kind === "completed";
					if (actionable && (!bubble.requestId || newRequest)) promote(`b:${id}`);
					setBubbles(prev => {
						const next = bubble.sessionId
							? // Replace the prior bubble for this session — each session
								// shows only its latest transient note, not an ever-growing
								// stack. Session-less bubbles still append.
								prev.some(b => b.sessionId === bubble.sessionId)
								? prev.map(b =>
										b.sessionId === bubble.sessionId
											? {
													id,
													kind: bubble.kind,
													text: bubble.text,
													sessionId: bubble.sessionId,
													requestId: bubble.requestId,
													visible: "",
												}
											: b,
									)
								: [
										...prev,
										{
											id,
											kind: bubble.kind,
											text: bubble.text,
											sessionId: bubble.sessionId,
											requestId: bubble.requestId,
											visible: "",
										},
									]
							: [
									...prev,
									{
										id,
										kind: bubble.kind,
										text: bubble.text,
										sessionId: bubble.sessionId,
										requestId: bubble.requestId,
										visible: "",
									},
								];
						return next.length > MAX_VISIBLE_BUBBLES ? next.slice(next.length - MAX_VISIBLE_BUBBLES) : next;
					});
					// Transient bubbles auto-dismiss; question bubbles persist
					// until decided (completion/error live on the cards now).
					if (bubble.kind !== "question") {
						window.setTimeout(() => {
							setBubbles(prev => prev.filter(b => b.id !== id));
						}, BUBBLE_MS);
					}
				}
			}
			if (typeof payload.locale === "string") setLocale(payload.locale);
			// Opening or acknowledging in the main window removes its cards.
			// Unrelated local dismissals remain suppressed.
			if (Array.isArray(payload.dismissSessions) && payload.dismissSessions.length > 0) {
				const ids = new Set(payload.dismissSessions);
				setBubbles(prev => {
					const next = prev.filter(b => !(b.sessionId && ids.has(b.sessionId)));
					return next.length === prev.length ? prev : next;
				});
				setCards(prev => {
					const next = prev.filter(c => !ids.has(c.sessionId));
					return next.length === prev.length ? prev : next;
				});
			}
			if (payload.theme === "light" || payload.theme === "dark") {
				document.documentElement.dataset.theme = payload.theme;
				document.documentElement.dataset.colorScheme = payload.theme;
				document.documentElement.style.colorScheme = payload.theme;
			}
		});
		// Ask the main window for the latest state — it re-pushes mood,
		// theme AND the active pet descriptor (this window's localStorage
		// carries no petdex state under file://).
		void bridge?.requestPetState?.();
		return off;
	}, []);

	// A global hotkey (Ctrl/Cmd+Shift+Y / N) decided a request — drop the
	// bubble (the main window was already told via pet:command).
	useEffect(() => {
		return bridge?.onPetApprovalResolved?.(({ requestId }) => {
			setBubbles(prev => prev.filter(b => b.requestId !== requestId));
		});
	}, []);

	// Mirror theme and the application's motion preference into this window.
	useEffect(() => {
		const doc = document.documentElement;
		const applyScheme = (): void => {
			let pref: "system" | "light" | "dark" = "system";
			let motionOff = false;
			try {
				const v = localStorage.getItem("omp-collab-theme");
				if (v === "light" || v === "dark" || v === "system") pref = v;
				motionOff = localStorage.getItem("musepi-gui-motion") === "off";
			} catch {
				/* storage unavailable — follow the system */
			}
			const resolved =
				pref === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : pref;
			doc.dataset.theme = resolved;
			doc.dataset.colorScheme = resolved;
			doc.style.colorScheme = resolved;
			doc.classList.toggle("gui-motion-off", motionOff);
		};
		applyScheme();
		const mq = window.matchMedia("(prefers-color-scheme: dark)");
		const onMq = (): void => {
			try {
				if ((localStorage.getItem("omp-collab-theme") ?? "system") === "system") applyScheme();
			} catch {
				applyScheme();
			}
		};
		const onStorage = (event: StorageEvent): void => {
			if (event.key === "musepi-gui-motion" || event.key === "omp-collab-theme") applyScheme();
		};
		mq.addEventListener("change", onMq);
		window.addEventListener("storage", onStorage);
		return () => {
			mq.removeEventListener("change", onMq);
			window.removeEventListener("storage", onStorage);
		};
	}, []);

	// Typewriter reveal for notification bubbles. Reduced motion shows the
	// complete message immediately instead of animating each character.
	useEffect(() => {
		if (bubbles.length === 0 || bubbles.every(b => b.visible === b.text)) return;
		if (bubbleMotionOff()) {
			setBubbles(prev => prev.map(b => (b.visible === b.text ? b : { ...b, visible: b.text })));
			return;
		}
		const timer = window.setInterval(() => {
			setBubbles(prev => {
				let changed = false;
				const next = prev.map(b => {
					if (b.visible === b.text) return b;
					const gap = b.text.length - b.visible.length;
					const step = Math.max(1, Math.floor(gap / 6));
					changed = true;
					return { ...b, visible: b.text.slice(0, b.visible.length + step) };
				});
				return changed ? next : prev;
			});
		}, 28);
		return () => window.clearInterval(timer);
	}, [bubbles]);

	// Report the content union — the bubbles window is sized to exactly
	// Measure only the stack. The pet-side control lives in another window.
	// Layout boxes avoid feeding entrance transforms back into window size.
	useEffect(() => {
		if (!bridge?.setBubblesContentSize) return;
		const MEASURED = ".pet-bubbles";
		const report = (): void => {
			const bodyStyle = getComputedStyle(document.body);
			let w = 0;
			let h = parseFloat(bodyStyle.paddingTop) + parseFloat(bodyStyle.paddingBottom);
			for (const el of document.querySelectorAll<HTMLElement>(MEASURED)) {
				const r = el.getBoundingClientRect();
				const animating =
					typeof el.getAnimations === "function" && el.getAnimations().some(a => a.playState === "running");
				const style = getComputedStyle(el);
				w = Math.max(w, animating ? el.offsetWidth : r.width);
				h +=
					(animating ? el.offsetHeight : r.height) + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
				el.addEventListener("animationend", report, { once: true });
			}
			void bridge.setBubblesContentSize?.({ width: Math.ceil(w), height: Math.ceil(h) });
		};
		const ro = new ResizeObserver(report);
		for (const el of document.querySelectorAll<HTMLElement>(MEASURED)) ro.observe(el);
		report();
		const timer = window.setTimeout(report, 300);
		const mo = new MutationObserver(report);
		const root = document.getElementById("root");
		if (root) mo.observe(root, { childList: true, subtree: true, characterData: true });
		return () => {
			ro.disconnect();
			mo.disconnect();
			window.clearTimeout(timer);
		};
	}, []);

	const itemCount = bubbles.length + cards.length;
	useEffect(() => {
		// Mirror the mode before hiding the native window. The reverse order can
		// leave the pet showing the previous mode when the hidden renderer stalls.
		void bridge?.bubblesSetMode?.(stackMode, itemCount);
		void bridge?.setBubblesVisible?.(itemCount > 0 && stackMode !== "hidden");
	}, [itemCount, stackMode]);

	// Include overhanging dismiss buttons and the clear-all capsule. Re-report
	// after transitions so their delayed hover reveal never remains click-through.
	useEffect(() => {
		if (!bridge?.setBubblesHitbox) return;
		const INTERACTIVE = ".pet-bubble, .pet-bubble__dismiss, .pet-bubbles__head, .pet-bubbles__clear";
		const report = (): void => {
			let left = Infinity;
			let top = Infinity;
			let right = -Infinity;
			let bottom = -Infinity;
			for (const el of document.querySelectorAll<HTMLElement>(INTERACTIVE)) {
				const r = el.getBoundingClientRect();
				if (r.width <= 0 || r.height <= 0) continue;
				left = Math.min(left, r.left);
				top = Math.min(top, r.top);
				right = Math.max(right, r.right);
				bottom = Math.max(bottom, r.bottom);
				el.addEventListener("animationend", report, { once: true });
				el.addEventListener("transitionend", report, { once: true });
			}
			void bridge.setBubblesHitbox?.(
				left === Infinity
					? null
					: {
							x: Math.round(left),
							y: Math.round(top),
							width: Math.round(right - left),
							height: Math.round(bottom - top),
						},
			);
		};
		report();
		const timer = window.setTimeout(report, 300);
		const ro = new ResizeObserver(report);
		const mo = new MutationObserver(report);
		const root = document.getElementById("root");
		if (root) mo.observe(root, { childList: true, subtree: true, characterData: true });
		for (const el of document.querySelectorAll<HTMLElement>(".pet-bubbles")) ro.observe(el);
		return () => {
			ro.disconnect();
			mo.disconnect();
			window.clearTimeout(timer);
		};
	}, []);

	const switchMode = (next: StackMode): void => {
		if (next === stackMode) return;
		const r = stackRef.current?.getBoundingClientRect();
		setStackMode(next);
		setStackMorph(!bubbleMotionOff() && r ? { from: { width: r.width, height: r.height } } : null);
		if (next === "hidden") {
			setReplyFor(null);
			setReplyText("");
		}
	};

	const stackModeRef = useRef(stackMode);
	stackModeRef.current = stackMode;
	const switchModeRef = useRef(switchMode);
	switchModeRef.current = switchMode;
	useEffect(() => {
		return bridge?.onBubblesAdvance?.(() => {
			const current = stackModeRef.current;
			switchModeRef.current(current === "expanded" ? "stacked" : current === "stacked" ? "hidden" : "stacked");
		});
	}, []);

	useScrollShadow(stackRef);

	useEffect(() => {
		if (!stackMorph) return;
		const el = stackRef.current;
		if (!el || bubbleMotionOff()) {
			setStackMorph(null);
			return;
		}
		// Lift the inline lock to measure the true target, then restore it in
		// the same frame. No paint can occur between these operations.
		el.style.transition = "none";
		el.style.width = "";
		el.style.height = "";
		const toW = el.getBoundingClientRect().width;
		const toH = el.getBoundingClientRect().height;
		el.style.width = `${stackMorph.from.width}px`;
		el.style.height = `${stackMorph.from.height}px`;
		void el.offsetHeight;
		if (Math.abs(toH - stackMorph.from.height) < 1 && Math.abs(toW - stackMorph.from.width) < 1) {
			setStackMorph(null);
			return;
		}
		const liquid = getComputedStyle(el).getPropertyValue("--spring-liquid").trim() || "ease";
		el.style.transition = `width 320ms ${liquid}, height 320ms ${liquid}`;
		el.style.width = `${toW}px`;
		el.style.height = `${toH}px`;
		const done = (): void => {
			el.style.transition = "";
			el.style.width = "";
			el.style.height = "";
			setStackMorph(null);
		};
		el.addEventListener("transitionend", done, { once: true });
		const fallback = window.setTimeout(done, 420);
		return () => {
			window.clearTimeout(fallback);
			el.removeEventListener("transitionend", done);
		};
	}, [stackMorph]);

	// ── Session card actions ──────────────────────────────────────────────

	/** × / ✓ closes only this activity card. Read state remains owned by the
	 *  main window; a later activity revision may surface the session again. */
	const dismissCard = (c: PetSessionCard): void => {
		hiddenSessionsRef.current.set(c.sessionId, sessionActivityKey(c));
		setCards(prev => prev.filter(x => x.sessionId !== c.sessionId));
		if (replyFor === `c:${c.sessionId}`) {
			setReplyFor(null);
			setReplyText("");
		}
	};

	/** ■ stop — abort the run and dismiss only the current activity card. */
	const stopCard = (c: PetSessionCard): void => {
		void bridge?.petStopSession?.(c.sessionId);
		hiddenSessionsRef.current.set(c.sessionId, sessionActivityKey(c));
		setCards(prev => prev.filter(x => x.sessionId !== c.sessionId));
		if (replyFor === `c:${c.sessionId}`) {
			setReplyFor(null);
			setReplyText("");
		}
	};

	/** Card body click → jump to that conversation in the main window. */
	const openCard = (c: PetSessionCard): void => {
		void bridge?.petOpenSession?.(c.sessionId);
	};

	// ── Notification bubble actions ───────────────────────────────────────

	const dismissBubble = (b: Bubble): void => {
		if (b.requestId) dismissedRequestIdsRef.current.add(b.requestId);
		setBubbles(prev => prev.filter(x => x.id !== b.id));
		if (replyFor === `b:${b.id}`) {
			setReplyFor(null);
			setReplyText("");
		}
	};

	/** ✓ confirm — the meaning follows the bubble kind: a tool approval is
	 *  批准'd, anything else just closes (completion/error live on the
	 *  session cards now). */
	const confirmBubble = (b: Bubble): void => {
		if (b.requestId) {
			void bridge?.petApprove?.(b.requestId, true);
			setBubbles(prev => prev.filter(x => x.id !== b.id));
			return;
		}
		dismissBubble(b);
	};

	const denyBubble = (b: Bubble): void => {
		if (!b.requestId) return;
		void bridge?.petApprove?.(b.requestId, false);
		setBubbles(prev => prev.filter(x => x.id !== b.id));
	};

	/** Inline reply row shared by session cards and session-scoped bubbles. */
	const sendReply = (sessionId: string): void => {
		const text = replyText.trim();
		if (!text || sending) return;
		setSending(true);
		void bridge?.petReply?.(text, sessionId).finally(() => {
			setSending(false);
			setReplyText("");
			setReplyFor(null);
		});
	};

	const renderReplyRow = (sessionId: string): ReactNode => (
		<div
			className="pet-bubble__reply"
			// Clicking into the input must not trigger the card's own click.
			onClick={e => e.stopPropagation()}
		>
			<input
				className="pet-bubble__reply-input"
				placeholder={t("settings.petReplyPlaceholder")}
				value={replyText}
				autoFocus
				onChange={e => setReplyText(e.target.value)}
				onKeyDown={e => {
					if (e.key === "Enter") sendReply(sessionId);
					if (e.key === "Escape") {
						setReplyFor(null);
						setReplyText("");
					}
				}}
			/>
			<button
				type="button"
				className="pet-bubble__reply-send"
				aria-label={t("settings.send2")}
				title={t("settings.send2")}
				onClick={() => sendReply(sessionId)}
				disabled={!replyText.trim() || sending}
			>
				↑
			</button>
		</div>
	);

	const clearAll = (): void => {
		// Clear only the visible activity cards. This never marks conversations
		// read and never decides pending approvals on the user's behalf.
		for (const card of cards) hiddenSessionsRef.current.set(card.sessionId, sessionActivityKey(card));
		for (const bubble of bubbles) {
			if (bubble.requestId) dismissedRequestIdsRef.current.add(bubble.requestId);
		}
		priorityItemRef.current = null;
		setCards([]);
		setBubbles([]);
		setReplyFor(null);
		setReplyText("");
		setStackMode("stacked");
	};

	if (itemCount === 0) return null;

	// A stacked stack with multiple cards expands before an action runs. This
	// prevents a hidden priority card from being replied to or dismissed by
	// accident. Expanded cards keep the list open when their session opens.
	const runAction = (action: () => void): void => {
		if (stackMode === "stacked" && itemCount > 1) switchMode("expanded");
		else action();
	};
	const items: ReactNode[] = [
		...cards.map((c): ReactNode => {
			const replyKey = `c:${c.sessionId}`;
			const unread = c.phase !== "working";
			return (
				<div
					key={replyKey}
					className={`pet-bubble pet-bubble--session pet-bubble--${c.phase}${unread ? " pet-bubble--unread" : ""}`}
					onClick={() => runAction(() => openCard(c))}
				>
					<button
						type="button"
						className="pet-bubble__dismiss"
						aria-label="dismiss"
						onClick={e => {
							e.stopPropagation();
							runAction(() => dismissCard(c));
						}}
					>
						×
					</button>
					<div className="pet-bubble__body">
						<div className="pet-bubble__title">{c.title}</div>
						<div className="pet-bubble__status">
							{c.phase === "error" && <span className="pet-bubble__flag">❗</span>}
							{c.statusText}
						</div>
						{c.replyPreview && <div className="pet-bubble__preview">{c.replyPreview}</div>}
					</div>
					{/* Phase-scoped quick actions (kimi-work parity): working
					 * cards get 💬 回复 + ■ 停止 (hover); finished cards get 💬 +
					 * ✓ 确认 — and on unread cards the ✓/❗ are ALWAYS visible,
					 * no hover needed to spot the acknowledge target. */}
					<div className="pet-bubble__actions">
						<button
							type="button"
							className="pet-bubble__action pet-bubble__action--open"
							aria-label={t("settings.petBubbleOpen")}
							title={t("settings.petBubbleOpen")}
							onClick={e => {
								e.stopPropagation();
								runAction(() => openCard(c));
							}}
						>
							↗
						</button>
						<button
							type="button"
							className={`pet-bubble__action${replyFor === replyKey ? " pet-bubble__action--active" : ""}`}
							aria-label={t("settings.petBubbleReply")}
							title={t("settings.petBubbleReply")}
							onClick={e => {
								e.stopPropagation();
								runAction(() => {
									setReplyFor(prev => (prev === replyKey ? null : replyKey));
									setReplyText("");
								});
							}}
						>
							💬
						</button>
						{c.phase === "working" ? (
							<button
								type="button"
								className="pet-bubble__action pet-bubble__action--stop"
								aria-label={t("settings.petBubbleStop")}
								title={t("settings.petBubbleStop")}
								onClick={e => {
									e.stopPropagation();
									runAction(() => stopCard(c));
								}}
							>
								■
							</button>
						) : (
							<button
								type="button"
								className="pet-bubble__action pet-bubble__action--primary"
								aria-label={t("settings.petBubbleConfirm")}
								title={t("settings.petBubbleConfirm")}
								onClick={e => {
									e.stopPropagation();
									runAction(() => dismissCard(c));
								}}
							>
								✓
							</button>
						)}
					</div>
					{replyFor === replyKey && renderReplyRow(c.sessionId)}
				</div>
			);
		}),
		...bubbles.map((b): ReactNode => {
			const replyKey = `b:${b.id}`;
			return (
				<div
					key={replyKey}
					className={`pet-bubble pet-bubble--${b.kind}`}
					onClick={() =>
						runAction(() => {
							if (b.sessionId) void bridge?.petOpenSession?.(b.sessionId);
							else void bridge?.focusMainWindow?.();
						})
					}
				>
					<button
						type="button"
						className="pet-bubble__dismiss"
						aria-label="dismiss"
						onClick={e => {
							e.stopPropagation();
							dismissBubble(b);
						}}
					>
						×
					</button>
					{bubbleKindLabel(b.kind) && <span className="pet-bubble__kind">{bubbleKindLabel(b.kind)}</span>}
					<div className="pet-bubble__text">{b.visible}</div>
					<div className="pet-bubble__actions">
						<button
							type="button"
							className="pet-bubble__action pet-bubble__action--open"
							aria-label={t("settings.petBubbleOpen")}
							title={t("settings.petBubbleOpen")}
							onClick={e => {
								e.stopPropagation();
								runAction(() => {
									if (b.sessionId) void bridge?.petOpenSession?.(b.sessionId);
									else void bridge?.focusMainWindow?.();
								});
							}}
						>
							↗
						</button>
						{b.sessionId && (
							<button
								type="button"
								className={`pet-bubble__action${replyFor === replyKey ? " pet-bubble__action--active" : ""}`}
								aria-label={t("settings.petBubbleReply")}
								title={t("settings.petBubbleReply")}
								onClick={e => {
									e.stopPropagation();
									runAction(() => {
										setReplyFor(prev => (prev === replyKey ? null : replyKey));
										setReplyText("");
									});
								}}
							>
								💬
							</button>
						)}
						<button
							type="button"
							className="pet-bubble__action pet-bubble__action--primary"
							aria-label={t("settings.petBubbleConfirm")}
							title={t("settings.petBubbleConfirm")}
							onClick={e => {
								e.stopPropagation();
								runAction(() => confirmBubble(b));
							}}
						>
							✓
						</button>
						{b.requestId && (
							<button
								type="button"
								className="pet-bubble__action pet-bubble__action--deny"
								aria-label={t("settings.petBubbleDeny")}
								title={t("settings.petBubbleDeny")}
								onClick={e => {
									e.stopPropagation();
									runAction(() => denyBubble(b));
								}}
							>
								✗
							</button>
						)}
					</div>
					{replyFor === replyKey && b.sessionId && renderReplyRow(b.sessionId)}
				</div>
			);
		}),
	];
	const priorityIndex = items.findIndex(item => isValidElement(item) && item.key === priorityItemRef.current);
	if (priorityIndex > 0) items.unshift(items.splice(priorityIndex, 1)[0]!);

	if (stackMode === "hidden") return null;

	if (stackMode === "expanded") {
		return (
			<div
				ref={stackRef}
				className={`pet-bubbles pet-bubbles--expanded${stackMorph ? " pet-bubbles--morphing" : ""}`}
				style={
					stackMorph ? { width: `${stackMorph.from.width}px`, height: `${stackMorph.from.height}px` } : undefined
				}
				data-top-scroll="false"
				data-bottom-scroll="false"
				aria-live="polite"
			>
				<div className="pet-bubbles__head">
					<button type="button" className="pet-bubbles__clear" onClick={clearAll}>
						{t("settings.petBubblesClearAll")}
					</button>
				</div>
				{items}
			</div>
		);
	}

	const top = items[0];
	const more = items.length - 1;
	return (
		<div
			ref={stackRef}
			className={`pet-bubbles pet-bubbles--stacked${stackMorph ? " pet-bubbles--morphing pet-bubbles--shrinking" : ""}`}
			style={stackMorph ? { width: `${stackMorph.from.width}px`, height: `${stackMorph.from.height}px` } : undefined}
			aria-live="polite"
		>
			{more > 1 && <span className="pet-bubbles__stack-layer pet-bubbles__stack-layer--far" aria-hidden />}
			{more > 0 && <span className="pet-bubbles__stack-layer pet-bubbles__stack-layer--near" aria-hidden />}
			{more > 0 && <span className="pet-bubble__more">{t("settings.petBubblesMore", { count: more })}</span>}
			{top}
		</div>
	);
}
