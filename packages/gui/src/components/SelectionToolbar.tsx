import { t } from "@musepi/collab-web";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { tapFeedback } from "../lib/haptic";
import { useTwoPhaseEnter } from "../lib/use-two-phase-enter";
import { Icon, type IconName } from "../vendor/oc-icons";
import { MENU_ANIM_MS } from "./Pop";

/**
 * Floating actions for in-message text selection (openchamber parity):
 * selecting text inside the transcript pops a small glass toolbar above
 * the selection with 引用 (quote to composer) / 复制 / 基于选择新建会话 /
 * 添加到笔记. Dismisses on outside click, scroll, or Escape.
 */
export function SelectionToolbar({
	containerRef,
	onQuote,
	onAsk,
	onCopy,
	onNewSession,
	onAddNote,
}: {
	/** The transcript scroll container — selections outside it are ignored. */
	containerRef: React.RefObject<HTMLElement | null>;
	onQuote(text: string): void;
	/** Open the selection→ask popover for this selection (throws away the
	 * answer — never recorded to the transcript). */
	onAsk(text: string, x: number, y: number): void;
	onCopy(text: string): void;
	onNewSession(text: string): void;
	onAddNote(text: string): void;
}): ReactNode {
	const [pop, setPop] = useState<{ x: number; y: number; text: string } | null>(null);
	// Exit: keep the toolbar mounted through gui-select-pop-out before
	// unmounting (Pop parity); the frosted chip also needs the two-phase
	// enter so its backdrop composites before the fade-in plays.
	const [closing, setClosing] = useState(false);
	const enteredCls = useTwoPhaseEnter(pop !== null);
	// dismiss is bound once inside the effect — read state through refs so
	// it always sees the latest pop/closing.
	const popRef = useRef(pop);
	popRef.current = pop;
	const closingRef = useRef(closing);
	closingRef.current = closing;
	const hideTimer = useRef(0);
	// Stable identity (only refs in deps) so the effect below binds the
	// listeners once; it reads fresh pop/closing through the refs.
	const dismiss = useCallback((): void => {
		if (!popRef.current || closingRef.current) return;
		setClosing(true);
		window.clearTimeout(hideTimer.current);
		hideTimer.current = window.setTimeout(() => {
			setPop(null);
			setClosing(false);
		}, MENU_ANIM_MS);
	}, []);
	// Group expansion: hovering ANY button expands ALL of them at once, so
	// the icons stop drifting while the cursor travels between buttons
	// (per-button expand shoved its neighbours mid-move and made them
	// hard to hit).
	const [expanded, setExpanded] = useState(false);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;

		const onMouseUp = (): void => {
			// Let the browser settle the selection (click-drag releases
			// before the range is final).
			window.clearTimeout(hideTimer.current);
			hideTimer.current = window.setTimeout(() => {
				const sel = window.getSelection();
				if (!sel || sel.isCollapsed) {
					dismiss();
					return;
				}
				const text = sel.toString().trim();
				if (!text || !sel.anchorNode || !el.contains(sel.anchorNode)) {
					dismiss();
					return;
				}
				const range = sel.getRangeAt(0);
				const rect = range.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) {
					dismiss();
					return;
				}
				// A fresh selection while the old toolbar is fading out:
				// cancel the pending unmount and re-show at the new spot.
				window.clearTimeout(hideTimer.current);
				setClosing(false);
				setPop({
					x: Math.round(rect.left + rect.width / 2),
					y: Math.round(rect.top),
					text: text.length > 400 ? `${text.slice(0, 400)}…` : text,
				});
			}, 10);
		};
		const onDown = (e: MouseEvent): void => {
			// A click outside the toolbar itself dismisses it.
			const target = e.target as HTMLElement | null;
			if (target?.closest(".gui-select-pop")) return;
			dismiss();
		};
		const onScroll = (): void => dismiss();
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") dismiss();
		};
		el.addEventListener("mouseup", onMouseUp);
		window.addEventListener("mousedown", onDown);
		el.addEventListener("scroll", onScroll, true);
		window.addEventListener("keydown", onKey);
		return () => {
			window.clearTimeout(hideTimer.current);
			el.removeEventListener("mouseup", onMouseUp);
			window.removeEventListener("mousedown", onDown);
			el.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("keydown", onKey);
		};
	}, [containerRef, dismiss]);

	if (!pop) return null;
	const actions: Array<{ icon: IconName; label: string; run(): void }> = [
		{ icon: "chat-1", label: t("quote to chat"), run: () => onQuote(pop.text) },
		{ icon: "sparkling", label: t("ask about selection"), run: () => onAsk(pop.text, pop.x, pop.y) },
		{ icon: "file-copy-2", label: t("copy"), run: () => onCopy(pop.text) },
		{ icon: "chat-new", label: t("new session from selection"), run: () => onNewSession(pop.text) },
		{ icon: "sticky-note", label: t("add to notes"), run: () => onAddNote(pop.text) },
	];
	return (
		<div
			className={`gui-select-pop${enteredCls ? " gui-select-pop--entered" : ""}${closing ? " gui-select-pop--closing" : ""}${expanded ? " gui-select-pop--expanded" : ""}`}
			role="toolbar"
			style={{
				left: pop.x,
				top: pop.y - 38,
				transform: "translateX(-50%)",
			}}
			onMouseDown={e => e.preventDefault()} // keep the selection
			onMouseEnter={() => setExpanded(true)}
			onMouseLeave={() => setExpanded(false)}
		>
			{actions.map(a => (
				<button
					key={a.label}
					type="button"
					className="gui-select-pop-btn"
					title={a.label}
					aria-label={a.label}
					onClick={() => {
						tapFeedback();
						a.run();
						dismiss();
					}}
				>
					<Icon name={a.icon} className="h-3.5 w-3.5" />
					<span className="gui-select-pop-label">{a.label}</span>
				</button>
			))}
		</div>
	);
}
