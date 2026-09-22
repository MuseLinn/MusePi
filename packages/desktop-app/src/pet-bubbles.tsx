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
 *    批准, completion/error → 标记已读并关闭, transient → 关闭), ✗ deny on
 *    approval bubbles, and 💬 回复 on session bubbles — the reply button
 *    expands an inline input that sends via petReply (no panel hop)
 *
 * 2026-09-22 bubble v3 (kimi-work four-screenshot parity, user review):
 *  - AUTHORITATIVE session cards: the main window pushes `sessions`
 *    (working + unread finished) synthesized from its session.list poll and
 *    unread derivation — background sessions notify exactly like the
 *    active one, replacing per-event completion/error bubble pushes
 *  - two-line card: bold title row + dim status row (working → 正在使用 X…,
 *    done → 已完成, error → ❗ 出错了), optional reply preview
 *  - phase-scoped hover actions: working cards get 💬 回复 + ■ 停止
 *    (petStopSession → session.abort); done/error cards get 💬 + ✓ 确认,
 *    and the ✓/❗ are ALWAYS visible on unread cards (kimi parity — no
 *    hover needed to see the acknowledge target)
 *  - card click → petOpenSession (jump to that conversation)
 *  - three-state collapse: expanded ⇄ stacked (spring morph, existing)
 *    → hidden: the ⌄ fab collapses one level at a time (expanded →
 *    stacked → hidden), hidden shows a count BADGE floating by the pet;
 *    clicking the badge restores the stack
 *  - the PET WINDOW's own corner badge is now the SAME hidden-stack
 *    indicator (2026-09-22 user: 角标点击还是一键已读不对 / 一启动就有
 *    角标): it mirrors this window's collapse mode via bubblesSetMode,
 *    shows the hidden item count only while mode === "hidden", and
 *    clicking it asks this window to restore (bubbles:restore) — never
 *    mark-all-read, and never lit at boot (fresh stack starts "stacked")
 *
 * Sizing (split window, 2026-09-21): the bubbles live in their OWN window
 * (bubbles.html) whose size IS the content — the renderer reports the
 * content union via bubblesSetContentSize, its interactive card union via
 * bubblesSetHitbox (the transparent padding ring stays click-through), and
 * its occupancy via bubblesSetVisible (empty stack → the main process
 * hides the window). The main process (layoutBubblesWindow) pins the
 * window above the sprite and follows the pet on every move.
 */

import { setLocale, t } from "@musepi/client-core";
import { type ReactNode, useEffect, useRef, useState } from "react";
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
	/** Card ✓/× dismiss → mark that session read (the main window owns the
	 *  unread badge; acknowledging the notification must clear it too). */
	petMarkRead?(sessionId: string): Promise<unknown>;
	petMarkAllRead?(): Promise<unknown>;
	/** Report the content size the window must take (CSS px). The main
	 *  process sizes the bubbles window to exactly this. */
	bubblesSetContentSize?(size: { width: number; height: number }): Promise<unknown>;
	/** Report whether any bubble is showing — empty stack hides the
	 *  window entirely. */
	bubblesSetVisible?(visible: boolean): Promise<unknown>;
	/** Report the collapse mode + live item count — the main process
	 *  mirrors it to the pet window so its badge only lights when the
	 *  stack is fully hidden (kimi parity: badge = restore, not
	 *  mark-all-read). */
	bubblesSetMode?(mode: "expanded" | "stacked" | "hidden", count: number): Promise<unknown>;
	/** Pet-window badge click → restore the fully-hidden stack. */
	bubblesRestoreStack?(): Promise<unknown>;
	/** bubblesRestoreStack arrived — switch hidden → stacked. */
	onBubblesRestore?(cb: () => void): () => void;
	/** Report the interactive card union (window-relative CSS px) — the
	 *  main process keeps the transparent padding ring click-through. */
	bubblesSetHitbox?(rect: { x: number; y: number; width: number; height: number } | null): Promise<unknown>;
	/** Ask the main window to re-push its latest pet state (on mount — the
	 *  push also carries the active pet descriptor, which this window
	 *  cannot read from localStorage under file://). */
	requestPetState?(): Promise<unknown>;
}

const BUBBLE_MS = 8000;
const MAX_VISIBLE_BUBBLES = 5;

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

/** Short tag shown on each notification card so the four notification
 *  kinds are distinguishable at a glance. Session CARDS don't need a tag —
 *  their title row identifies them. Unknown kinds get no tag rather than a
 *  misleading one: the daemon may add kinds before this window learns
 *  about them. */
function bubbleKindLabel(kind: string): string | null {
	switch (kind) {
		case "completed":
			return t("pet bubble kind completed");
		case "error":
			return t("pet bubble kind error");
		case "question":
			return t("pet bubble kind question");
		case "subtask":
			return t("pet bubble kind subtask");
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
	// Session cards the user hid with ×/■ — suppressed while the phase is
	// unchanged (a 1s re-push would otherwise resurrect them instantly);
	// a phase flip (working → done) surfaces the card again.
	const hiddenSessionsRef = useRef<Map<string, string>>(new Map());
	// Inline reply: which card/bubble's input is open (null = none). Keys:
	// `c:<sessionId>` for session cards, `b:<bubble id>` for bubbles.
	const [replyFor, setReplyFor] = useState<string | null>(null);
	const [replyText, setReplyText] = useState("");
	const [sending, setSending] = useState(false);
	const bridge = (window as unknown as { electronAPI?: PetBubblesBridge }).electronAPI;

	// pet:activity — session cards, bubbles, approvals, theme/locale push.
	useEffect(() => {
		const off = bridge?.onPetActivity?.(payload => {
			if (Array.isArray(payload.sessions)) {
				// Authoritative list — replace wholesale. Cards the user
				// dismissed stay suppressed until their phase changes.
				const hidden = hiddenSessionsRef.current;
				setCards(
					payload.sessions.filter(c => {
						const h = hidden.get(c.sessionId);
						if (!h) return true;
						if (h === c.phase) return false;
						hidden.delete(c.sessionId);
						return true;
					}),
				);
			}
			if (payload.approval?.requestId) {
				// Tool approval → its own question bubble with ✓/✗ hover
				// actions. Duplicate requestIds collapse into one bubble.
				const approval = payload.approval;
				setBubbles(prev =>
					prev.some(b => b.requestId === approval.requestId)
						? prev
						: [
								...prev,
								{
									id: Date.now(),
									kind: "question",
									text: t("pet approval · {tool}", { tool: approval.tool }),
									requestId: approval.requestId,
									visible: "",
								},
							].slice(-MAX_VISIBLE_BUBBLES),
				);
			}
			if (payload.bubble?.text) {
				const bubble = payload.bubble;
				// Session-scoped completion/error pushes are OWNED by the
				// authoritative session cards — skip them here so a
				// background session never double-notifies.
				const superseded = !!bubble.sessionId && (bubble.kind === "completed" || bubble.kind === "error");
				if (!superseded) {
					const id = Date.now();
					setBubbles(prev => {
						const next = bubble.sessionId
							? // Replace the prior bubble for this session — each session
								// shows only its latest transient note, not an ever-growing
								// stack. Session-less bubbles still append.
								prev.some(b => b.sessionId === bubble.sessionId)
								? prev.map(b =>
										b.sessionId === bubble.sessionId
											? {
													id: b.id,
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
					if (bubble.kind === "question") return;
					window.setTimeout(() => {
						setBubbles(prev => prev.filter(b => b.id !== id));
					}, BUBBLE_MS);
				}
			}
			if (typeof payload.locale === "string") setLocale(payload.locale);
			// Sessions opened/acknowledged in the main window are read —
			// dismiss their cards and bubbles (read 闭环).
			if (Array.isArray(payload.dismissSessions) && payload.dismissSessions.length > 0) {
				const ids = new Set(payload.dismissSessions);
				hiddenSessionsRef.current.clear();
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

	// Light/dark scheme mirror (same as the pet window).
	useEffect(() => {
		const doc = document.documentElement;
		const applyScheme = (): void => {
			let pref: "system" | "light" | "dark" = "system";
			try {
				const v = localStorage.getItem("omp-collab-theme");
				if (v === "light" || v === "dark" || v === "system") pref = v;
			} catch {
				/* storage unavailable — follow the system */
			}
			const resolved =
				pref === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : pref;
			doc.dataset.theme = resolved;
			doc.dataset.colorScheme = resolved;
			doc.style.colorScheme = resolved;
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
		mq.addEventListener("change", onMq);
		return () => mq.removeEventListener("change", onMq);
	}, []);

	// Typewriter reveal for notification bubbles (session cards render
	// their title/status rows directly — no reveal needed).
	useEffect(() => {
		if (bubbles.length === 0 || bubbles.every(b => b.visible === b.text)) return;
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
	// this. The window's body padding (pet-window.css .bubbles-root) is the
	// transparent shadow ring AROUND the measured boxes, so the measured
	// stack/fab/badge layout boxes alone are what must fit.
	useEffect(() => {
		if (!bridge?.bubblesSetContentSize) return;
		const MEASURED = ".pet-bubbles, .pet-bubbles__fab, .pet-bubbles__badge";
		const report = (): void => {
			let w = 0;
			let h = 0;
			for (const el of document.querySelectorAll<HTMLElement>(MEASURED)) {
				// Entrance/leaving keyframes transform the box; getBoundingClientRect
				// includes the transform, so a mid-animation report would size the
				// window to the animating (shrunk) box. The layout box (offset*)
				// ignores transforms — use it while the element animates; the
				// animationend re-report below settles the final size.
				const r = el.getBoundingClientRect();
				const animating =
					typeof el.getAnimations === "function" && el.getAnimations().some(a => a.playState === "running");
				w = Math.max(w, animating ? el.offsetWidth : r.width);
				h += animating ? el.offsetHeight : r.height;
			}
			void bridge.bubblesSetContentSize?.({ width: Math.ceil(w), height: Math.ceil(h) });
			// Transforms do not fire ResizeObserver — re-report when an
			// entrance/leaving animation settles.
			for (const el of document.querySelectorAll<HTMLElement>(MEASURED)) {
				el.addEventListener("animationend", report, { once: true });
			}
		};
		const ro = new ResizeObserver(report);
		for (const el of document.querySelectorAll<HTMLElement>(MEASURED)) ro.observe(el);
		report();
		// Delayed re-reports: typewriter growth / stack expand change the
		// box after mount; the mutation observer catches newly mounted
		// content elements (bubbles appear/disappear, stack expands, the
		// inline reply row opens) and characterData picks up the typewriter's
		// per-tick text growth.
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

	// Show/hide the window with the stack's occupancy: an empty stack
	// renders nothing — the main process hides the window so the
	// transparent body never blocks the desktop. The hidden-mode badge
	// still counts as occupancy (it IS the visible content).
	const itemCount = bubbles.length + cards.length;
	useEffect(() => {
		void bridge?.bubblesSetVisible?.(itemCount > 0);
	}, [itemCount]);

	// Mirror the collapse mode to the main process → pet-window badge.
	// A fresh window starts "stacked", so the badge can never be spuriously
	// lit at boot (2026-09-22 user: 一启动程序没有会话怎么就有角标).
	useEffect(() => {
		void bridge?.bubblesSetMode?.(stackMode, itemCount);
	}, [stackMode, itemCount]);

	// Report the interactive card union — the main process keeps the
	// transparent padding ring and the gaps click-through. Window-relative
	// coords: the cards live inside the body's padding box, and
	// getBoundingClientRect is viewport-relative (this window == viewport).
	// The fab/badge ride outside the card union but are interactive too.
	useEffect(() => {
		if (!bridge?.bubblesSetHitbox) return;
		const INTERACTIVE = ".pet-bubble, .pet-bubbles__fab, .pet-bubbles__badge";
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
			}
			void bridge.bubblesSetHitbox?.(
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
		const ro = new ResizeObserver(report);
		const mo = new MutationObserver(report);
		const root = document.getElementById("root");
		if (root) mo.observe(root, { childList: true, subtree: true, characterData: true });
		for (const el of document.querySelectorAll<HTMLElement>(".pet-bubbles")) ro.observe(el);
		return () => {
			ro.disconnect();
			mo.disconnect();
		};
	}, []);

	// Collapse-state switches with a size morph: capture the old size,
	// swap the view (renderer locks the container to `from` via the
	// inline style), then measure the target size and transition.
	const switchMode = (next: StackMode): void => {
		if (next === stackMode) return;
		const r = stackRef.current?.getBoundingClientRect();
		setStackMode(next);
		setStackMorph(r ? { from: { width: r.width, height: r.height } } : null);
		if (next === "hidden") {
			setReplyFor(null);
			setReplyText("");
		}
	};

	// Pet-window badge click → restore the fully-hidden stack (refs dodge
	// the stale closure — the listener subscribes once).
	const stackModeRef = useRef(stackMode);
	stackModeRef.current = stackMode;
	const switchModeRef = useRef(switchMode);
	switchModeRef.current = switchMode;
	useEffect(() => {
		return bridge?.onBubblesRestore?.(() => {
			if (stackModeRef.current === "hidden") switchModeRef.current("stacked");
		});
	}, []);

	// Expanded list scroll feather (transcript parity): the stack scrolls
	// inside the window, and data-top-scroll / data-bottom-scroll flip the
	// mask-image top/bottom fade on as content overflows and scrolls away
	// from an edge — no hard-cut rows at the scrollport.
	useScrollShadow(stackRef);

	useEffect(() => {
		if (!stackMorph) return;
		const el = stackRef.current;
		if (!el) {
			setStackMorph(null);
			return;
		}
		// The renderer locks the container to `from` (inline size).
		// Measuring needs the TRUE content size: scrollHeight bottoms
		// out at the locked client height and the locked width masks the
		// max-content target, so lift the lock, measure, then re-lock —
		// same frame, no paint in between.
		el.style.transition = "none";
		el.style.width = "";
		el.style.height = "";
		const toW = el.getBoundingClientRect().width;
		const toH = el.getBoundingClientRect().height;
		el.style.width = `${stackMorph.from.width}px`;
		el.style.height = `${stackMorph.from.height}px`;
		void el.offsetHeight; // commit the lock before transitioning
		if (Math.abs(toH - stackMorph.from.height) < 1 && Math.abs(toW - stackMorph.from.width) < 1) {
			setStackMorph(null);
			return;
		}
		// Spring with overshoot (cubic-bezier y > 1) — the size sweeps
		// past the target and settles back (iOS Notification-Center bounce).
		el.style.transition =
			"width 320ms cubic-bezier(0.34, 1.4, 0.64, 1), height 320ms cubic-bezier(0.34, 1.4, 0.64, 1)";
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

	/** × / ✓ on a card. Finished cards acknowledge = mark the session read
	 *  (badge 闭环); working cards just hide (the user didn't ask to stop
	 *  the run — suppress until the phase changes). */
	const dismissCard = (c: PetSessionCard): void => {
		if (c.phase === "working") hiddenSessionsRef.current.set(c.sessionId, c.phase);
		else void bridge?.petMarkRead?.(c.sessionId);
		setCards(prev => prev.filter(x => x.sessionId !== c.sessionId));
		if (replyFor === `c:${c.sessionId}`) {
			setReplyFor(null);
			setReplyText("");
		}
	};

	/** ■ stop — abort the run; hide the card (it flips to done/unread or
	 *  vanishes on the main window's next poll either way). */
	const stopCard = (c: PetSessionCard): void => {
		void bridge?.petStopSession?.(c.sessionId);
		hiddenSessionsRef.current.set(c.sessionId, c.phase);
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
				placeholder={t("pet reply placeholder")}
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
				aria-label={t("send")}
				title={t("send")}
				onClick={() => sendReply(sessionId)}
				disabled={!replyText.trim() || sending}
			>
				↑
			</button>
		</div>
	);

	const clearAll = (): void => {
		// Read 闭环 for every session card + the badge in one pass.
		for (const c of cards) {
			if (c.phase !== "working") void bridge?.petMarkRead?.(c.sessionId);
		}
		for (const b of bubbles) {
			if (b.requestId) void bridge?.petApprove?.(b.requestId, true);
		}
		void bridge?.petMarkAllRead?.();
		hiddenSessionsRef.current.clear();
		setCards([]);
		setBubbles([]);
		setReplyFor(null);
		setReplyText("");
		setStackMode("stacked");
	};

	if (itemCount === 0) return null;

	// Display order (top → bottom): question/approval bubbles first (they
	// block the agent), then the authoritative session cards (working
	// first — the main window pre-sorts them), then transient notes.
	// In the stacked view every card's body click EXPANDS the list (kimi
	// parity) — the jump-to-session click lives in the expanded list; the
	// quick-action buttons stopPropagation, so they keep working in both.
	const items: ReactNode[] = [
		...cards.map((c): ReactNode => {
			const replyKey = `c:${c.sessionId}`;
			const unread = c.phase !== "working";
			return (
				<div
					key={replyKey}
					className={`pet-bubble pet-bubble--session pet-bubble--${c.phase}${unread ? " pet-bubble--unread" : ""}`}
					onClick={() => (stackMode === "stacked" ? switchMode("expanded") : openCard(c))}
				>
					<button
						type="button"
						className="pet-bubble__dismiss"
						aria-label="dismiss"
						onClick={e => {
							e.stopPropagation();
							dismissCard(c);
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
							className={`pet-bubble__action${replyFor === replyKey ? " pet-bubble__action--active" : ""}`}
							aria-label={t("pet bubble reply")}
							title={t("pet bubble reply")}
							onClick={e => {
								e.stopPropagation();
								setReplyFor(prev => (prev === replyKey ? null : replyKey));
								setReplyText("");
							}}
						>
							💬
						</button>
						{c.phase === "working" ? (
							<button
								type="button"
								className="pet-bubble__action pet-bubble__action--stop"
								aria-label={t("pet bubble stop")}
								title={t("pet bubble stop")}
								onClick={e => {
									e.stopPropagation();
									stopCard(c);
								}}
							>
								■
							</button>
						) : (
							<button
								type="button"
								className="pet-bubble__action pet-bubble__action--primary"
								aria-label={t("pet bubble confirm")}
								title={t("pet bubble confirm")}
								onClick={e => {
									e.stopPropagation();
									dismissCard(c);
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
					onClick={() => {
						if (stackMode === "stacked") {
							switchMode("expanded");
							return;
						}
						if (b.sessionId) {
							void bridge?.petOpenSession?.(b.sessionId);
							return;
						}
						void bridge?.focusMainWindow?.();
					}}
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
						{b.sessionId && (
							<button
								type="button"
								className={`pet-bubble__action${replyFor === replyKey ? " pet-bubble__action--active" : ""}`}
								aria-label={t("pet bubble reply")}
								title={t("pet bubble reply")}
								onClick={e => {
									e.stopPropagation();
									setReplyFor(prev => (prev === replyKey ? null : replyKey));
									setReplyText("");
								}}
							>
								💬
							</button>
						)}
						<button
							type="button"
							className="pet-bubble__action pet-bubble__action--primary"
							aria-label={t("pet bubble confirm")}
							title={t("pet bubble confirm")}
							onClick={e => {
								e.stopPropagation();
								confirmBubble(b);
							}}
						>
							✓
						</button>
						{b.requestId && (
							<button
								type="button"
								className="pet-bubble__action pet-bubble__action--deny"
								aria-label={t("pet bubble deny")}
								title={t("pet bubble deny")}
								onClick={e => {
									e.stopPropagation();
									denyBubble(b);
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

	// Fully hidden: only the count badge floats by the pet (kimi parity —
	// the ⌄ fab's third state). Clicking it restores the stack.
	if (stackMode === "hidden") {
		return (
			<button
				type="button"
				className="pet-bubbles__badge"
				aria-label={t("pet bubbles count", { count: itemCount })}
				title={t("pet bubbles show")}
				onClick={() => switchMode("stacked")}
			>
				{itemCount}
			</button>
		);
	}

	// Collapse fab (⌄): one level at a time — expanded → stacked → hidden.
	const fab = (
		<button
			type="button"
			className="pet-bubbles__fab"
			aria-label={stackMode === "expanded" ? t("pet bubbles collapse") : t("pet bubbles hide")}
			title={stackMode === "expanded" ? t("pet bubbles collapse") : t("pet bubbles hide")}
			onClick={() => switchMode(stackMode === "expanded" ? "stacked" : "hidden")}
		>
			⌄
		</button>
	);

	// Expanded: header row (count + 清除全部) over the full priority list.
	if (stackMode === "expanded") {
		return (
			<>
				<div
					ref={stackRef}
					className={`pet-bubbles pet-bubbles--expanded${stackMorph ? " pet-bubbles--morphing" : ""}`}
					style={
						stackMorph
							? { width: `${stackMorph.from.width}px`, height: `${stackMorph.from.height}px` }
							: undefined
					}
					data-top-scroll="false"
					data-bottom-scroll="false"
					aria-live="polite"
				>
					<div className="pet-bubbles__head">
						<span className="pet-bubbles__count">{t("pet bubbles count", { count: itemCount })}</span>
						<button type="button" className="pet-bubbles__clear" onClick={clearAll}>
							{t("pet bubbles clear all")}
						</button>
					</div>
					{items}
				</div>
				{/* Collapse fab — ⌄ parks just above the pet, outside the
				 * scrollport so it never scrolls away. */}
				{fab}
			</>
		);
	}

	// Stacked: the top-priority card + "N more" chip; clicking the body
	// expands the list (spring morph). The card itself owns the click —
	// no wrapper interception — because its quick-action buttons already
	// stopPropagation.
	const top = items[0];
	const more = items.length - 1;
	return (
		<>
			<div
				ref={stackRef}
				className={`pet-bubbles pet-bubbles--stacked${stackMorph ? " pet-bubbles--morphing pet-bubbles--shrinking" : ""}`}
				style={
					stackMorph ? { width: `${stackMorph.from.width}px`, height: `${stackMorph.from.height}px` } : undefined
				}
				aria-live="polite"
			>
				{more > 0 && <span className="pet-bubble__more">{t("pet bubbles more", { count: more })}</span>}
				{top}
			</div>
			{fab}
		</>
	);
}
