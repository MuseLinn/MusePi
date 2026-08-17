import { t } from "@musepi/collab-web";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Icon, type IconName } from "../vendor/oc-icons";

/**
 * Floating actions for in-message text selection (openchamber parity):
 * selecting text inside the transcript pops a small glass toolbar above
 * the selection with 引用 (quote to composer) / 复制 / 基于选择新建会话 /
 * 添加到笔记. Dismisses on outside click, scroll, or Escape.
 */
export function SelectionToolbar({
	containerRef,
	onQuote,
	onCopy,
	onNewSession,
	onAddNote,
}: {
	/** The transcript scroll container — selections outside it are ignored. */
	containerRef: React.RefObject<HTMLElement | null>;
	onQuote(text: string): void;
	onCopy(text: string): void;
	onNewSession(text: string): void;
	onAddNote(text: string): void;
}): ReactNode {
	const [pop, setPop] = useState<{ x: number; y: number; text: string } | null>(null);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		let hideTimer = 0;

		const onMouseUp = (): void => {
			// Let the browser settle the selection (click-drag releases
			// before the range is final).
			window.clearTimeout(hideTimer);
			hideTimer = window.setTimeout(() => {
				const sel = window.getSelection();
				if (!sel || sel.isCollapsed) {
					setPop(null);
					return;
				}
				const text = sel.toString().trim();
				if (!text || !sel.anchorNode || !el.contains(sel.anchorNode)) {
					setPop(null);
					return;
				}
				const range = sel.getRangeAt(0);
				const rect = range.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) {
					setPop(null);
					return;
				}
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
			setPop(null);
		};
		const onScroll = (): void => setPop(null);
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") setPop(null);
		};
		el.addEventListener("mouseup", onMouseUp);
		window.addEventListener("mousedown", onDown);
		el.addEventListener("scroll", onScroll, true);
		window.addEventListener("keydown", onKey);
		return () => {
			window.clearTimeout(hideTimer);
			el.removeEventListener("mouseup", onMouseUp);
			window.removeEventListener("mousedown", onDown);
			el.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("keydown", onKey);
		};
	}, [containerRef]);

	if (!pop) return null;
	const actions: Array<{ icon: IconName; label: string; run(): void }> = [
		{ icon: "chat-1", label: t("quote to chat"), run: () => onQuote(pop.text) },
		{ icon: "file-copy-2", label: t("copy"), run: () => onCopy(pop.text) },
		{ icon: "chat-new", label: t("new session from selection"), run: () => onNewSession(pop.text) },
		{ icon: "sticky-note", label: t("add to notes"), run: () => onAddNote(pop.text) },
	];
	return (
		<div
			className="gui-select-pop"
			role="toolbar"
			style={{
				left: pop.x,
				top: pop.y - 38,
				transform: "translateX(-50%)",
			}}
			onMouseDown={e => e.preventDefault()} // keep the selection
		>
			{actions.map(a => (
				<button
					key={a.label}
					type="button"
					className="gui-select-pop-btn"
					title={a.label}
					aria-label={a.label}
					onClick={() => {
						a.run();
						setPop(null);
					}}
				>
					<Icon name={a.icon} className="h-3.5 w-3.5" />
				</button>
			))}
		</div>
	);
}
