import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	type Modifier,
	MouseSensor,
	TouchSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS as DndCSS } from "@dnd-kit/utilities";
import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SESSION_TAB_EDGE_FADE_PX, sessionTabRevealDelta } from "../lib/session-tab-reveal";
import { Icon } from "../vendor/oc-icons";
import { MenuPopup } from "./MenuPopup";

const restrictToXAxis: Modifier = ({ transform }) => ({ ...transform, y: 0 });

/** Firefox reports wheel deltas in lines rather than pixels. */
const WHEEL_LINE_PIXELS = 16;

/**
 * Mouse wheels scroll vertically, so the strip maps vertical wheel movement
 * to horizontal scrolling. Native horizontal gestures (trackpad swipes,
 * Shift+wheel) pass through, and Ctrl/Cmd+wheel stays with zoom.
 */
const scrollTabsWithWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
	if (event.shiftKey || event.ctrlKey || event.metaKey) return;
	if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
	const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * WHEEL_LINE_PIXELS : event.deltaY;
	event.currentTarget.scrollLeft += delta;
};

export interface SessionTabRow {
	id: string;
	/** Display title — already resolved from session metadata/tree. */
	label: string;
	/** Live session with a running agent turn (kimi 进行中 parity). */
	working: boolean;
	/** Completed-but-unread (sidebar unread set parity). */
	unread: boolean;
	/** Fresh draft (no messages yet) — the title renders italic. */
	draft?: boolean;
}

/**
 * One tab. The whole tab is the drag handle (the mouse sensor's 8px
 * activation distance keeps a plain click a click); the close control sits
 * in a hover-revealed overlay so the title keeps its width. Middle click
 * closes without activating.
 */
function SessionTabItem({
	tab,
	isActive,
	onSelect,
	onClose,
	onCloseOthers,
	onArchive,
	children,
}: {
	tab: SessionTabRow;
	isActive: boolean;
	onSelect: (id: string) => void;
	onClose: (id: string) => void;
	onCloseOthers?: (id: string) => void;
	onArchive?: (id: string) => void;
	children?: ReactNode;
}): ReactNode {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });
	const showDot = tab.working || (tab.unread && !isActive);
	const [menuOpen, setMenuOpen] = useState(false);
	const menuBtnRef = useRef<HTMLButtonElement | null>(null);
	return (
		<div
			ref={setNodeRef}
			style={{ transform: DndCSS.Translate.toString(transform), transition }}
			className={`gui-session-tab-slot${isDragging ? " gui-session-tab-slot--dragging" : ""}`}
			{...attributes}
			{...listeners}
		>
			<div
				role="tab"
				aria-selected={isActive}
				data-active-session-tab={isActive ? true : undefined}
				className={`gui-session-tab group/session-tab${isActive ? " gui-session-tab--active" : ""}`}
				onClick={isActive ? undefined : () => onSelect(tab.id)}
				onKeyDown={
					isActive
						? undefined
						: event => {
								if (event.key === "Enter" || event.key === " ") {
									event.preventDefault();
									onSelect(tab.id);
								}
							}
				}
				onAuxClick={event => {
					if (event.button === 1) {
						event.preventDefault();
						onClose(tab.id);
					}
				}}
			>
				{/* The active tab hosts the header's title/switcher block; an
					inactive tab is a plain title pill. */}
				{isActive ? (
					<div className="gui-session-tab-current min-w-0 flex-1">{children}</div>
				) : (
					<>
						{/* Title + status; the row shrinks on hover so the text
						 * fades under the controls instead of sliding. */}
						<span className="gui-session-tab-main">
							<span
								className={`gui-session-tab-label${tab.draft ? " gui-session-tab-label--draft" : ""}`}
								dir="auto"
								title={tab.label}
							>
								{tab.label}
							</span>
							{showDot ? (
								tab.working ? (
									<Icon
										name="loader-4"
										className="gui-session-tab-working"
										aria-label={t("session tab working")}
									/>
								) : (
									<span className="gui-session-tab-unread" aria-label={t("session tab unread")} />
								)
							) : null}
						</span>
						{/* Hover-revealed overlay at the pill's end: session menu
						 * first, close after it. Pins open while the menu is up. */}
						<span className="gui-session-tab-controls" data-open={menuOpen ? "true" : undefined}>
							<button
								type="button"
								ref={menuBtnRef}
								aria-label={t("tab menu")}
								aria-haspopup="menu"
								aria-expanded={menuOpen}
								className="gui-session-tab-ctl"
								onClick={event => {
									event.stopPropagation();
									setMenuOpen(v => !v);
								}}
								onPointerDown={event => event.stopPropagation()}
							>
								<Icon name="more" className="h-3 w-3" />
							</button>
							<button
								type="button"
								aria-label={t("close tab")}
								className="gui-session-tab-ctl"
								onClick={event => {
									event.stopPropagation();
									onClose(tab.id);
								}}
								onPointerDown={event => event.stopPropagation()}
							>
								<Icon name="close" className="h-3 w-3" />
							</button>
							<MenuPopup
								open={menuOpen}
								className="gui-session-tab-menu"
								anchor={menuBtnRef.current}
								align="right"
								onOpenChange={setMenuOpen}
							>
								<button
									type="button"
									className="gui-menu-item"
									onClick={() => {
										setMenuOpen(false);
										onClose(tab.id);
									}}
								>
									<Icon name="close" className="h-3.5 w-3.5" />
									{t("close tab")}
								</button>
								{onCloseOthers ? (
									<button
										type="button"
										className="gui-menu-item"
										onClick={() => {
											setMenuOpen(false);
											onCloseOthers(tab.id);
										}}
									>
										<Icon name="subtract" className="h-3.5 w-3.5" />
										{t("close other tabs")}
									</button>
								) : null}
								{onArchive ? (
									<>
										<div className="my-1 border-t border-[var(--border)]" role="separator" />
										<button
											type="button"
											className="gui-menu-item"
											onClick={() => {
												setMenuOpen(false);
												onArchive(tab.id);
											}}
										>
											<Icon name="archive" className="h-3.5 w-3.5" />
											{t("settings.archiveTask")}
										</button>
									</>
								) : null}
							</MenuPopup>
						</span>
					</>
				)}
			</div>
		</div>
	);
}

/**
 * The header's horizontal working set of sessions. Every session the user
 * opens joins the strip once; the active tab renders `children` — the
 * header's title/switcher block — inside its pill. Closing a tab only
 * removes it from the strip; closing the active one activates its neighbour
 * (handled by the caller via onClose). Tabs whose session is not in `tabs`
 * stay stored upstream and simply do not render here.
 */
export function SessionTabsStrip({
	tabs,
	activeId,
	onSelect,
	onClose,
	onCloseOthers,
	onArchive,
	onReorder,
	children,
}: {
	tabs: SessionTabRow[];
	activeId: string | null;
	onSelect: (id: string) => void;
	onClose: (id: string) => void;
	onCloseOthers?: (id: string) => void;
	onArchive?: (id: string) => void;
	onReorder: (activeId: string, overId: string) => void;
	children: ReactNode;
}): ReactNode {
	const sensors = useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
		useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
	);

	const handleDragEnd = useCallback(
		(event: DragEndEvent): void => {
			const { active, over } = event;
			if (over && active.id !== over.id) onReorder(String(active.id), String(over.id));
		},
		[onReorder],
	);

	// Soft fade at the edges while more tabs hide behind them.
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const [edges, setEdges] = useState({ left: false, right: false });
	const updateEdges = useCallback((): void => {
		const node = scrollRef.current;
		if (!node) return;
		const max = node.scrollWidth - node.clientWidth;
		const left = node.scrollLeft > 2;
		const right = node.scrollLeft < max - 2;
		setEdges(prev => (prev.left === left && prev.right === right ? prev : { left, right }));
	}, []);
	useEffect(() => {
		updateEdges();
		const node = scrollRef.current;
		if (!node || !globalThis.ResizeObserver) return;
		const observer = new ResizeObserver(updateEdges);
		observer.observe(node);
		return () => observer.disconnect();
	}, [updateEdges, tabs.length]);

	// Keep the active tab in view when it changes, stopping short of the edge
	// fades so the tab's own controls stay readable.
	useEffect(() => {
		const node = scrollRef.current;
		const tab = node?.querySelector<HTMLElement>("[data-active-session-tab]");
		if (!node || !tab) return;
		const delta = sessionTabRevealDelta(node.getBoundingClientRect(), tab.getBoundingClientRect());
		if (delta === 0) return;
		node.scrollLeft += delta;
		updateEdges();
	}, [activeId, updateEdges]);

	const maskImage =
		edges.left && edges.right
			? `linear-gradient(to right, transparent, black ${SESSION_TAB_EDGE_FADE_PX}px, black calc(100% - ${SESSION_TAB_EDGE_FADE_PX}px), transparent)`
			: edges.left
				? `linear-gradient(to right, transparent, black ${SESSION_TAB_EDGE_FADE_PX}px)`
				: edges.right
					? `linear-gradient(to right, black calc(100% - ${SESSION_TAB_EDGE_FADE_PX}px), transparent)`
					: undefined;

	return (
		<div className="gui-session-tabs" role="tablist" aria-label={t("session tabs")}>
			<div
				ref={scrollRef}
				onScroll={updateEdges}
				onWheel={scrollTabsWithWheel}
				className="gui-session-tabs-scroll"
				style={maskImage ? { maskImage, WebkitMaskImage: maskImage } : undefined}
			>
				<DndContext
					sensors={sensors}
					collisionDetection={closestCenter}
					modifiers={[restrictToXAxis]}
					onDragEnd={handleDragEnd}
				>
					<SortableContext items={tabs.map(tab => tab.id)} strategy={horizontalListSortingStrategy}>
						{tabs.map(tab => (
							<SessionTabItem
								key={tab.id}
								tab={tab}
								isActive={tab.id === activeId}
								onSelect={onSelect}
								onClose={onClose}
								onCloseOthers={onCloseOthers}
								onArchive={onArchive}
							>
								{tab.id === activeId ? children : null}
							</SessionTabItem>
						))}
					</SortableContext>
				</DndContext>
			</div>
		</div>
	);
}
