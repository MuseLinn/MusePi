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
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

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
	cwd?: string;
}

interface SessionTabActions {
	onSelect(id: string): void;
	onKeepOpen(id: string): void;
	onRename(id: string): void;
	onCopyId(id: string): void;
	onExport(id: string): void;
	onOpenMiniChat(id: string): void;
	onMoveToWorktree(id: string): void;
	onArchive(id: string): void;
	onDelete(id: string): void;
	onCloseOthers(id: string): void;
	onClose(id: string): void;
}

function tabMenuItems(tab: SessionTabRow, isPreview: boolean, actions: SessionTabActions): ContextMenuItem[] {
	return [
		...(isPreview
			? [{ label: t("keep tab open"), icon: "pushpin", onSelect: () => actions.onKeepOpen(tab.id) }]
			: []),
		{ label: t("settings.renameSession"), icon: "pencil", onSelect: () => actions.onRename(tab.id) },
		{ label: t("transcript.copySessionId"), icon: "clipboard", onSelect: () => actions.onCopyId(tab.id) },
		{ label: t("general.exportMarkdown"), icon: "download", onSelect: () => actions.onExport(tab.id) },
		{ label: t("general.openMiniChat"), icon: "chat-1", onSelect: () => actions.onOpenMiniChat(tab.id) },
		{
			label: t("general.moveNewWorktree"),
			icon: "folder-shared",
			onSelect: () => actions.onMoveToWorktree(tab.id),
		},
		{ label: t("settings.archiveTask"), icon: "archive", onSelect: () => actions.onArchive(tab.id) },
		{
			label: t("general.deleteSession"),
			icon: "delete-bin",
			danger: true,
			onSelect: () => actions.onDelete(tab.id),
		},
		{
			label: t("close other tabs"),
			icon: "subtract",
			divider: true,
			onSelect: () => actions.onCloseOthers(tab.id),
		},
		{ label: t("close tab"), icon: "close", onSelect: () => actions.onClose(tab.id) },
	];
}

function SessionTabItem({
	tab,
	isActive,
	isPreview,
	menuOpen,
	onOpenMenu,
	actions,
}: {
	tab: SessionTabRow;
	isActive: boolean;
	isPreview: boolean;
	menuOpen: boolean;
	onOpenMenu(id: string, x: number, y: number): void;
	actions: SessionTabActions;
}): ReactNode {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: tab.id });
	const showDot = tab.working || (tab.unread && !isActive);
	const select = (): void => {
		if (isPreview) actions.onKeepOpen(tab.id);
		if (!isActive) actions.onSelect(tab.id);
	};
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
				onClick={select}
				onDoubleClick={() => {
					if (isPreview) actions.onKeepOpen(tab.id);
				}}
				onKeyDown={event => {
					if (event.key === "Enter" || event.key === " ") {
						event.preventDefault();
						select();
					}
				}}
				onContextMenu={event => {
					event.preventDefault();
					event.stopPropagation();
					onOpenMenu(tab.id, event.clientX, event.clientY);
				}}
				onAuxClick={event => {
					if (event.button === 1) {
						event.preventDefault();
						actions.onClose(tab.id);
					}
				}}
			>
				<span className="gui-session-tab-main">
					<span
						className={`gui-session-tab-label${tab.draft ? " gui-session-tab-label--draft" : ""}${isPreview ? " gui-session-tab-label--preview" : ""}`}
						dir="auto"
						title={tab.label}
					>
						{tab.label}
					</span>
					{showDot ? (
						tab.working ? (
							<Icon name="loader-4" className="gui-session-tab-working" aria-label={t("session tab working")} />
						) : (
							<span className="gui-session-tab-unread" aria-label={t("session tab unread")} />
						)
					) : null}
				</span>
				<span className="gui-session-tab-controls" data-open={menuOpen ? "true" : undefined}>
					<button
						type="button"
						aria-label={t("tab menu")}
						aria-haspopup="menu"
						aria-expanded={menuOpen}
						className="gui-session-tab-ctl"
						onClick={event => {
							event.stopPropagation();
							const rect = event.currentTarget.getBoundingClientRect();
							onOpenMenu(tab.id, rect.right, rect.bottom);
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
							actions.onClose(tab.id);
						}}
						onPointerDown={event => event.stopPropagation()}
					>
						<Icon name="close" className="h-3 w-3" />
					</button>
				</span>
			</div>
		</div>
	);
}

/**
 * The header's horizontal working set of sessions. Every session the user
 * opens joins the strip once; every tab uses the same title structure.
 * Closing a tab only
 * removes it from the strip; closing the active one activates its neighbour
 * (handled by the caller via onClose). Tabs whose session is not in `tabs`
 * stay stored upstream and simply do not render here.
 */
export interface SessionTabsStripProps extends SessionTabActions {
	tabs: SessionTabRow[];
	activeId: string | null;
	previewTabId: string | null;
	onReorder(activeId: string, overId: string): void;
}

export function SessionTabsStrip(props: SessionTabsStripProps): ReactNode {
	const { tabs, activeId, previewTabId, onReorder } = props;
	const sensors = useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
		useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
	);
	const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
	const openMenu = useCallback((id: string, x: number, y: number): void => setMenu({ id, x, y }), []);
	const menuTab = menu ? tabs.find(tab => tab.id === menu.id) : undefined;

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
								isPreview={tab.id === previewTabId}
								menuOpen={menu?.id === tab.id}
								onOpenMenu={openMenu}
								actions={props}
							/>
						))}
					</SortableContext>
				</DndContext>
			</div>
			<ContextMenu
				open={menuTab !== undefined}
				x={menu?.x ?? 0}
				y={menu?.y ?? 0}
				items={menuTab ? tabMenuItems(menuTab, menuTab.id === previewTabId, props) : []}
				onClose={() => setMenu(null)}
			/>
		</div>
	);
}
