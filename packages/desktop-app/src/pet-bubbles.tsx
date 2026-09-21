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
 *  - collapsed = newest bubble + "N more" chip (iOS Notification-Center
 *    stack); expanded = full list + 清除全部 + a ∨ round button by the pet
 *  - hovering a bubble reveals its quick actions: ✓ confirm (approval →
 *    批准, completion/error → 标记已读并关闭, transient → 关闭), ✗ deny on
 *    approval bubbles, and 💬 回复 on session bubbles — the reply button
 *    expands an inline input that sends via petReply (no panel hop)
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
import type { PetActivity } from "./lib/pet";
import { useScrollShadow } from "./lib/use-scroll-shadow";

interface PetBubblesBridge {
	onPetActivity?(cb: (payload: PetActivity) => void): () => void;
	/** A global approval hotkey (Ctrl/Cmd+Shift+Y / N) decided a request —
	 *  drop the bubble. */
	onPetApprovalResolved?(cb: (payload: { requestId: string; approved: boolean }) => void): () => void;
	petReply?(text: string, sessionId?: string): Promise<unknown>;
	petApprove?(requestId: string, approved: boolean): Promise<unknown>;
	focusMainWindow?(): Promise<unknown>;
	petOpenSession?(sessionId: string): Promise<unknown>;
	/** Bubble × dismiss → mark that session read (the main window owns the
	 *  unread badge; dismissing the notification must clear it too). */
	petMarkRead?(sessionId: string): Promise<unknown>;
	petMarkAllRead?(): Promise<unknown>;
	/** Report the content size the window must take (CSS px). The main
	 *  process sizes the bubbles window to exactly this. */
	bubblesSetContentSize?(size: { width: number; height: number }): Promise<unknown>;
	/** Report whether any bubble is showing — empty stack hides the
	 *  window entirely. */
	bubblesSetVisible?(visible: boolean): Promise<unknown>;
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

/** Short tag shown on each card so the four notification kinds are
 *  distinguishable at a glance. The KIND is the severity signal — a finished
 *  task and a question that blocks the agent used to render identically
 *  (only `error` carried any styling at all). Unknown kinds get no tag
 *  rather than a misleading one: the daemon may add kinds before this
 *  window learns about them. */
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
	const [bubbles, setBubbles] = useState<Bubble[]>([]);
	// iOS Notification-Center style: collapsed shows the newest bubble +
	// "N more" count chip; clicking expands the full list.
	const [stackExpanded, setStackExpanded] = useState(false);
	// Size morph between the collapsed card and the expanded list (iOS
	// Notification-Center style): capture the old size on switch, render
	// the new view locked to that size, then transition to the new one.
	const [stackMorph, setStackMorph] = useState<{ from: { width: number; height: number } } | null>(null);
	const stackRef = useRef<HTMLDivElement | null>(null);
	// Inline reply: which bubble's input is open (null = none).
	const [replyFor, setReplyFor] = useState<number | null>(null);
	const [replyText, setReplyText] = useState("");
	const [sending, setSending] = useState(false);
	const bridge = (window as unknown as { electronAPI?: PetBubblesBridge }).electronAPI;

	// pet:activity — bubbles, approvals, theme/locale push.
	useEffect(() => {
		const off = bridge?.onPetActivity?.(payload => {
			if (payload.approval?.requestId) {
				// Tool approval → its own question bubble with ✓/✗ hover
				// actions (the interaction panel that used to host these is
				// gone). Duplicate requestIds collapse into one bubble.
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
				const id = Date.now();
				setBubbles(prev => {
					const next = bubble.sessionId
						? // Replace the prior bubble for this session — each session
							// shows only its latest completion/error, not an ever-growing
							// stack. Transient bubbles (no sessionId) still append.
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
									{ id, kind: bubble.kind, text: bubble.text, sessionId: bubble.sessionId, requestId: bubble.requestId, visible: "" },
								]
						: [...prev, { id, kind: bubble.kind, text: bubble.text, sessionId: bubble.sessionId, requestId: bubble.requestId, visible: "" }];
					return next.length > MAX_VISIBLE_BUBBLES ? next.slice(next.length - MAX_VISIBLE_BUBBLES) : next;
				});
				// Completion/error bubbles persist until dismissed or the
				// session is opened (the unread badge tracks them); transient
				// kinds auto-dismiss as before.
				if (bubble.kind === "completed" || bubble.kind === "error") return;
				window.setTimeout(() => {
					setBubbles(prev => prev.filter(b => b.id !== id));
				}, BUBBLE_MS);
			}
			if (typeof payload.locale === "string") setLocale(payload.locale);
			// Sessions opened in the main window are read — dismiss their
			// completion/error bubbles (read 闭环: opening a session in the
			// main window clears the pet's notification for it).
			if (Array.isArray(payload.dismissSessions) && payload.dismissSessions.length > 0) {
				const ids = new Set(payload.dismissSessions);
				setBubbles(prev => {
					const next = prev.filter(b => !(b.sessionId && ids.has(b.sessionId)));
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

	// Typewriter reveal for every bubble (one interval, all bubbles).
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
	// stack/fab layout boxes alone are what must fit.
	useEffect(() => {
		if (!bridge?.bubblesSetContentSize) return;
		const report = (): void => {
			let w = 0;
			let h = 0;
			for (const el of document.querySelectorAll<HTMLElement>(".pet-bubbles, .pet-bubbles__fab")) {
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
			for (const el of document.querySelectorAll<HTMLElement>(".pet-bubbles, .pet-bubbles__fab")) {
				el.addEventListener("animationend", report, { once: true });
			}
		};
		const ro = new ResizeObserver(report);
		for (const el of document.querySelectorAll<HTMLElement>(".pet-bubbles, .pet-bubbles__fab")) ro.observe(el);
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
	// transparent body never blocks the desktop.
	const bubbleCount = bubbles.length;
	useEffect(() => {
		void bridge?.bubblesSetVisible?.(bubbleCount > 0);
	}, [bubbleCount]);

	// Report the interactive card union — the main process keeps the
	// transparent padding ring and the gaps click-through. Window-relative
	// coords: the cards live inside the body's padding box, and
	// getBoundingClientRect is viewport-relative (this window == viewport).
	useEffect(() => {
		if (!bridge?.bubblesSetHitbox) return;
		const report = (): void => {
			let left = Infinity;
			let top = Infinity;
			let right = -Infinity;
			let bottom = -Infinity;
			for (const el of document.querySelectorAll<HTMLElement>(".pet-bubble")) {
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
					: { x: Math.round(left), y: Math.round(top), width: Math.round(right - left), height: Math.round(bottom - top) },
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

	// Collapsed ⇄ expanded with a size morph: capture the old size,
	// swap the view (renderer locks the container to `from` via the
	// inline style), then measure the target size and transition.
	const switchStack = (next: boolean): void => {
		if (next === stackExpanded) return;
		const r = stackRef.current?.getBoundingClientRect();
		setStackExpanded(next);
		setStackMorph(r ? { from: { width: r.width, height: r.height } } : null);
	};

	// Expanded list scroll feather (transcript parity): the stack scrolls
	// inside the window, and data-top-scroll / data-bottom-scroll flip the
	// mask-image top/bottom fade on as content overflows and scrolls away
	// from an edge — no hard-cut rows at the scrollport.
	useScrollShadow(stackRef);

	useEffect(() => {
		if (!stackMorph) return;
		const el = stackRef.current;
		if (!el) return;
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

	const dismissBubble = (b: Bubble): void => {
		// Dismissing a completion/error notification also clears its unread
		// badge in the main window — bubble and badge track the same signal.
		if ((b.kind === "completed" || b.kind === "error") && b.sessionId) {
			void bridge?.petMarkRead?.(b.sessionId);
		}
		setBubbles(prev => prev.filter(x => x.id !== b.id));
		if (replyFor === b.id) {
			setReplyFor(null);
			setReplyText("");
		}
	};

	/** ✓ confirm — the meaning follows the bubble kind: a tool approval is
	 *  批准'd, a completion/error is marked read and closed, anything else
	 *  just closes. */
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

	const sendReply = (b: Bubble): void => {
		const text = replyText.trim();
		if (!text || sending || !b.sessionId) return;
		setSending(true);
		void bridge?.petReply?.(text, b.sessionId).finally(() => {
			setSending(false);
			setReplyText("");
			setReplyFor(null);
		});
	};

	const clearAll = (): void => {
		// Read 闭环 for every session notification + the badge in one pass.
		for (const b of bubbles) {
			if ((b.kind === "completed" || b.kind === "error") && b.sessionId) {
				void bridge?.petMarkRead?.(b.sessionId);
			}
			if (b.requestId) void bridge?.petApprove?.(b.requestId, true);
		}
		void bridge?.petMarkAllRead?.();
		setBubbles([]);
		setReplyFor(null);
		setReplyText("");
		setStackExpanded(false);
	};

	if (bubbles.length === 0) return null;

	// One bubble card — kind tag as the bold title row, typewriter text,
	// hover quick actions (✓ confirm / ✗ deny / 💬 reply) and the optional
	// inline reply row.
	const renderBubble = (b: Bubble): ReactNode => (
		<div
			key={b.id}
			className={`pet-bubble pet-bubble--${b.kind}`}
			onClick={() => {
				// Completion/error bubbles carry their session: click opens
				// it in the main window (that's the "read" action) and
				// dismisses them. Plain notifications just focus.
				if (b.sessionId && (b.kind === "completed" || b.kind === "error")) {
					void bridge?.petOpenSession?.(b.sessionId);
					setBubbles(prev => prev.filter(x => x.sessionId !== b.sessionId));
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
			{/* Hover quick actions (kimi-work bubble parity): every bubble
			 * gets ✓ confirm; approvals also get ✗ deny; session bubbles
			 * get 💬 reply, which expands the inline input below. */}
			<div className="pet-bubble__actions">
				{b.sessionId && (
					<button
						type="button"
						className={`pet-bubble__action${replyFor === b.id ? " pet-bubble__action--active" : ""}`}
						aria-label={t("pet bubble reply")}
						title={t("pet bubble reply")}
						onClick={e => {
							e.stopPropagation();
							setReplyFor(prev => (prev === b.id ? null : b.id));
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
			{replyFor === b.id && (
				<div
					className="pet-bubble__reply"
					// Clicking into the input must not focus the main window
					// through the card's own click handler.
					onClick={e => e.stopPropagation()}
				>
					<input
						className="pet-bubble__reply-input"
						placeholder={t("pet reply placeholder")}
						value={replyText}
						autoFocus
						onChange={e => setReplyText(e.target.value)}
						onKeyDown={e => {
							if (e.key === "Enter") sendReply(b);
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
						onClick={() => sendReply(b)}
						disabled={!replyText.trim() || sending}
					>
						↑
					</button>
				</div>
			)}
		</div>
	);

	// iOS Notification-Center stack: collapsed shows only the newest
	// bubble (count chip when more pending); expanded shows the full list
	// with 清除全部 and a ∨ round button by the pet (kimi parity).
	if (stackExpanded) {
		return (
			<>
				<div
					ref={stackRef}
					className={`pet-bubbles pet-bubbles--expanded${stackMorph ? " pet-bubbles--morphing" : ""}`}
					style={stackMorph ? { width: `${stackMorph.from.width}px`, height: `${stackMorph.from.height}px` } : undefined}
					data-top-scroll="false"
					data-bottom-scroll="false"
					aria-live="polite"
				>
					<div className="pet-bubbles__head">
						<span className="pet-bubbles__count">{t("pet bubbles count", { count: bubbles.length })}</span>
						<button type="button" className="pet-bubbles__clear" onClick={clearAll}>
							{t("pet bubbles clear all")}
						</button>
					</div>
					{[...bubbles].reverse().map(renderBubble)}
				</div>
				{/* Collapse fab — the ∨ round button floating just above the
				 * pet (kimi parity), outside the scrollport. */}
				<button
					type="button"
					className="pet-bubbles__fab"
					aria-label={t("pet bubbles collapse")}
					title={t("pet bubbles collapse")}
					onClick={() => switchStack(false)}
				>
					∨
				</button>
			</>
		);
	}

	return (
		<div
			ref={stackRef}
			className={`pet-bubbles pet-bubbles--stacked${stackMorph ? " pet-bubbles--morphing pet-bubbles--shrinking" : ""}`}
			style={stackMorph ? { width: `${stackMorph.from.width}px`, height: `${stackMorph.from.height}px` } : undefined}
			aria-live="polite"
		>
			{(() => {
				const top = bubbles[bubbles.length - 1];
				const more = bubbles.length - 1;
				return (
					<div
						className={`pet-bubble pet-bubble--${top.kind}${more > 0 ? " pet-bubble--stacked" : ""}`}
						// Clicking the stacked card EXPANDS the list.
						onClick={() => switchStack(true)}
					>
						{more > 0 && <span className="pet-bubble__more">{t("pet bubbles more", { count: more })}</span>}
						<button
							type="button"
							className="pet-bubble__dismiss"
							aria-label="dismiss"
							onClick={e => {
								e.stopPropagation();
								dismissBubble(top);
							}}
						>
							×
						</button>
						{bubbleKindLabel(top.kind) && <span className="pet-bubble__kind">{bubbleKindLabel(top.kind)}</span>}
						<div className="pet-bubble__text">{top.visible}</div>
						<div className="pet-bubble__actions">
							{top.sessionId && (
								<button
									type="button"
									className={`pet-bubble__action${replyFor === top.id ? " pet-bubble__action--active" : ""}`}
									aria-label={t("pet bubble reply")}
									title={t("pet bubble reply")}
									onClick={e => {
										e.stopPropagation();
										setReplyFor(prev => (prev === top.id ? null : top.id));
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
									confirmBubble(top);
								}}
							>
								✓
							</button>
							{top.requestId && (
								<button
									type="button"
									className="pet-bubble__action pet-bubble__action--deny"
									aria-label={t("pet bubble deny")}
									title={t("pet bubble deny")}
									onClick={e => {
										e.stopPropagation();
										denyBubble(top);
									}}
								>
									✗
								</button>
							)}
						</div>
						{replyFor === top.id && (
							<div className="pet-bubble__reply" onClick={e => e.stopPropagation()}>
								<input
									className="pet-bubble__reply-input"
									placeholder={t("pet reply placeholder")}
									value={replyText}
									autoFocus
									onChange={e => setReplyText(e.target.value)}
									onKeyDown={e => {
										if (e.key === "Enter") sendReply(top);
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
									onClick={() => sendReply(top)}
									disabled={!replyText.trim() || sending}
								>
									↑
								</button>
							</div>
						)}
					</div>
				);
			})()}
		</div>
	);
}
