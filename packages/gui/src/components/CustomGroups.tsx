import { t } from "@musepi/desktop-web";
import type { DragEvent, KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../vendor/oc-icons";
import { Reveal } from "./Reveal";
import { SessionList, type SessionListNode, type SessionStatus } from "./SessionList";

export interface CustomGroup {
	name: string;
	sessions: string[];
	/** Accent color token (right-click → 更改颜色). */
	color?: string;
}

/** Folder-icon tints, one per GROUP_COLORS token (same values as gui-dot-*). */
const FOLDER_COLORS: Record<string, string> = {
	accent: "var(--color-accent)",
	green: "#34d399",
	orange: "#fb923c",
	blue: "#60a5fa",
	purple: "#a78bfa",
	pink: "#f472b6",
};

/**
 * User-created session groups (ZCode groups tab): named containers with a
 * session count and an empty-state "new task or drag here" row. Sessions are
 * dragged from the session tree (any tab) onto a group container to join it.
 * Clicking the header collapses/expands the group; right-click opens a menu.
 */
export function CustomGroups({
	groups,
	nodes,
	selectedId,
	onSelect,
	onSessionContextMenu,
	allOverride,
	onOverrideClear,
	onAddGroup,
	onNewSession,
	onDropSession,
	onContextMenu,
	onReorder,
	editIndex,
	onEditStart,
	onRename,
	onReorderMember,
	unread,
	pausedIds,
	workingIds,
	statuses,
	manualTags,
}: {
	groups: CustomGroup[];
	/** Session tree for rendering each group's members. */
	nodes: SessionListNode[];
	selectedId: string | null;
	onSelect(id: string): void;
	onSessionContextMenu?(sessionId: string, x: number, y: number): void;
	/** Tab-row quick toggle: true = all open, false = all closed, null = per group. */
	allOverride?: boolean | null;
	onOverrideClear?(): void;
	onAddGroup(): void;
	/** Empty-group placeholder click starts a new task (label says so). */
	onNewSession(): void;
	onDropSession(groupIndex: number, sessionId: string): void;
	onContextMenu(groupIndex: number, x: number, y: number): void;
	/** Drag the group header onto another header to reorder. */
	onReorder?(from: number, to: number): void;
	/** Group whose name is being edited inline (double-click / context menu). */
	editIndex?: number | null;
	onEditStart?(index: number): void;
	onRename?(index: number, name: string): void;
	/** Reorder one member session within its group (drag to a new row). */
	onReorderMember?(groupIndex: number, sessionId: string, to: number): void;
	/** Session ids with the 未读 marker. */
	unread?: ReadonlySet<string>;
	/** Paused session ids — pause chip on rows. */
	pausedIds?: ReadonlySet<string>;
	/** Live sessions with a running agent turn — pulsing dot on rows. */
	workingIds?: ReadonlySet<string>;
	/** Lifecycle status per session id — tints member rows' left square. */
	statuses?: ReadonlyMap<string, SessionStatus>;
	/** User-assigned color per session id (manual override of status). */
	manualTags?: ReadonlyMap<string, SessionStatus>;
}): ReactNode {
	const dropSession = (index: number) => (e: DragEvent<HTMLDivElement>) => {
		e.preventDefault();
		const id = e.dataTransfer.getData("text/plain");
		// Group-header drags carry a `group:` payload — never add them as members.
		if (id && !id.startsWith("group:")) onDropSession(index, id);
	};
	// Group member status pin: working sessions first, unread next. Stable
	// sort — the manual drag-reorder order survives within each rank.
	const statusRank = (id: string): number => (workingIds?.has(id) ? 2 : 0) + (unread?.has(id) ? 1 : 0);
	return (
		<div className="gui-groups">
			{groups.length === 0 && (
				<button type="button" className="gui-group-add" onClick={onAddGroup}>
					<Icon name="add-circle" className="h-4 w-4" />
					<span>{t("new group")}</span>
				</button>
			)}
			{groups.map((g, i) => (
				// Group order is reorderable but names are the display identity — the
				// index key keeps collapse state stable across renames.
				<GroupBlock
					key={i}
					index={i}
					group={g}
					openOverride={allOverride ?? null}
					onUserToggle={onOverrideClear}
					memberNodes={g.sessions
						.map(id => nodes.find(n => n.entry.id === id))
						.filter((n): n is SessionListNode => n !== undefined)
						.sort((a, b) => statusRank(b.entry.id) - statusRank(a.entry.id))}
					selectedId={selectedId}
					onSelect={onSelect}
					onSessionContextMenu={onSessionContextMenu}
					onDrop={dropSession(i)}
					onContextMenu={(e: MouseEvent) => {
						e.preventDefault();
						e.stopPropagation();
						onContextMenu(i, e.clientX, e.clientY);
					}}
					onAddGroup={onAddGroup}
					onNewSession={onNewSession}
					onReorder={onReorder}
					editIndex={editIndex}
					onEditStart={onEditStart}
					onRename={onRename}
					onReorderMember={onReorderMember}
					unread={unread}
					pausedIds={pausedIds}
					workingIds={workingIds}
					statuses={statuses}
					manualTags={manualTags}
				/>
			))}
		</div>
	);
}

function GroupBlock({
	group,
	index,
	memberNodes,
	selectedId,
	onSelect,
	onSessionContextMenu,
	openOverride,
	onUserToggle,
	onDrop,
	onContextMenu,
	onAddGroup,
	onNewSession,
	onReorder,
	editIndex,
	onEditStart,
	onRename,
	onReorderMember,
	unread,
	pausedIds,
	workingIds,
	statuses,
	manualTags,
}: {
	group: CustomGroup;
	index: number;
	memberNodes: SessionListNode[];
	selectedId: string | null;
	onSelect(id: string): void;
	onSessionContextMenu?(sessionId: string, x: number, y: number): void;
	/** When set (tab-row quick toggle), it wins over the per-group state. */
	openOverride?: boolean | null;
	onUserToggle?(): void;
	onDrop(e: DragEvent<HTMLDivElement>): void;
	onContextMenu(e: MouseEvent): void;
	onAddGroup(): void;
	/** Empty-group placeholder click starts a new task (label says so). */
	onNewSession(): void;
	onReorder?(from: number, to: number): void;
	editIndex?: number | null;
	onEditStart?(index: number): void;
	onRename?(index: number, name: string): void;
	/** Reorder one member session within this group (drag to a new row). */
	onReorderMember?(groupIndex: number, sessionId: string, to: number): void;
	/** Session ids with the 未读 marker. */
	unread?: ReadonlySet<string>;
	/** Paused session ids — pause chip on rows. */
	pausedIds?: ReadonlySet<string>;
	/** Live sessions with a running agent turn — pulsing dot on rows. */
	workingIds?: ReadonlySet<string>;
	/** Lifecycle status per session id — tints member rows' left square. */
	statuses?: ReadonlyMap<string, SessionStatus>;
	/** User-assigned color per session id (manual override of status). */
	manualTags?: ReadonlyMap<string, SessionStatus>;
}): ReactNode {
	const [localOpen, setLocalOpen] = useStateOpen(group.name);
	const open = openOverride ?? localOpen;
	const [dragOver, setDragOver] = useState(false);
	// Inline rename: a draft input replaces the name span while editing.
	const editing = editIndex === index;
	const [draft, setDraft] = useState(group.name);
	const draftRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		if (editing) setDraft(group.name);
	}, [editing, group.name]);
	useEffect(() => {
		if (editing) draftRef.current?.select();
	}, [editing]);
	const commitRename = (): void => {
		if (editing && draft.trim() && draft.trim() !== group.name) onRename?.(index, draft.trim());
		onEditStart?.(-1);
	};
	return (
		<div
			className={`gui-group${dragOver ? " gui-group--dragover" : ""}`}
			onDragOver={e => {
				e.preventDefault();
				e.dataTransfer.dropEffect = "copy";
				// Session drags onto the whole block highlight the group (the
				// head shares the same state) — feedback without hunting the head.
				if (!e.dataTransfer.getData("text/plain").startsWith("group:")) setDragOver(true);
			}}
			onDragLeave={e => {
				if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false);
			}}
			onDrop={e => {
				setDragOver(false);
				onDrop(e);
			}}
			onContextMenu={onContextMenu}
		>
			<div
				className={`gui-group-head${dragOver ? " gui-group-head--dragover" : ""}`}
				role="button"
				tabIndex={0}
				draggable={!!onReorder}
				onDragStart={e => {
					e.dataTransfer.setData("text/plain", `group:${index}`);
					e.dataTransfer.effectAllowed = "move";
				}}
				onDragOver={e => {
					e.preventDefault();
					setDragOver(true);
				}}
				onDragLeave={() => setDragOver(false)}
				onDrop={e => {
					setDragOver(false);
					const data = e.dataTransfer.getData("text/plain");
					if (data.startsWith("group:")) {
						// Group-header drag (reorder) — handled here, never a member.
						e.preventDefault();
						e.stopPropagation();
						const from = Number(data.slice(6));
						if (Number.isInteger(from) && from !== index) onReorder?.(from, index);
					} else {
						// Session drag onto the header row — join the group, same as
						// the member list area (the outer block's add-drop).
						onDrop(e);
					}
				}}
				onClick={() => {
					onUserToggle?.();
					setLocalOpen(v => !v);
				}}
				onKeyDown={e => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						onUserToggle?.();
						setLocalOpen(v => !v);
					}
				}}
			>
				<Icon name="arrow-down-s" className={`h-3.5 w-3.5 transition-transform ${open ? "" : "-rotate-90"}`} />
				{/* One folder glyph for every group, tinted by its color token. */}
				<Icon
					name="folder-3"
					className="h-3.5 w-3.5 flex-shrink-0"
					style={group.color ? { color: FOLDER_COLORS[group.color] } : undefined}
				/>
				{editing ? (
					<input
						ref={draftRef}
						className="gui-group-edit min-w-0 flex-1"
						value={draft}
						onChange={e => setDraft(e.target.value)}
						onBlur={commitRename}
						onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
							if (e.key === "Enter") commitRename();
							else if (e.key === "Escape") onEditStart?.(-1);
						}}
						onClick={e => e.stopPropagation()}
						onDoubleClick={e => e.stopPropagation()}
					/>
				) : (
					<span
						className="min-w-0 flex-1 truncate text-[13px] font-medium"
						title={t("double click to rename")}
						onDoubleClick={e => {
							e.stopPropagation();
							onEditStart?.(index);
						}}
					>
						{group.name}
					</span>
				)}
				<span className="text-[13px] text-[var(--color-text-faint)]">{group.sessions.length}</span>
				<button
					type="button"
					className="gui-group-act"
					title={t("add to group")}
					aria-label={t("add to group")}
					onClick={e => {
						e.stopPropagation();
						onAddGroup();
					}}
				>
					<Icon name="add" className="h-3 w-3" />
				</button>
			</div>
			<Reveal open={open}>
				{memberNodes.length > 0 && (
					<div
						onDragOver={e => {
							// Accept member drags (sort) — foreign sessions fall
							// through to the group container's add-drop.
							e.preventDefault();
						}}
						onDrop={e => {
							const id = e.dataTransfer.getData("text/plain");
							if (!id || !onReorderMember) return;
							const from = memberNodes.findIndex(n => n.entry.id === id);
							if (from < 0) return; // not a member — group add-drop handles it
							e.preventDefault();
							e.stopPropagation();
							// Insert before the row under the cursor (or at the end).
							const rows = [...e.currentTarget.querySelectorAll(".gui-session-row")];
							let to = rows.length;
							for (let i = 0; i < rows.length; i++) {
								const r = rows[i]!.getBoundingClientRect();
								if (e.clientY < r.top + r.height / 2) {
									to = i;
									break;
								}
							}
							onReorderMember(index, id, to);
						}}
					>
						<SessionList
							nodes={memberNodes}
							selectedId={selectedId}
							onSelect={onSelect}
							onContextMenu={onSessionContextMenu}
							unread={unread}
							pausedIds={pausedIds}
							workingIds={workingIds}
							statuses={statuses}
							manualTags={manualTags}
							sort="none"
						/>
					</div>
				)}
				{memberNodes.length === 0 && (
					<button type="button" className="gui-group-empty" onClick={onNewSession}>
						{t("new task, or drag here")}
					</button>
				)}
			</Reveal>
		</div>
	);
}

/** Per-group collapse state persisted by group name (musepi-gui-group-open). */
function useStateOpen(name: string): [boolean, (v: (prev: boolean) => boolean) => void] {
	const key = `musepi-gui-group-open:${name}`;
	const [open, setOpen] = useState(() => {
		try {
			return localStorage.getItem(key) !== "0";
		} catch {
			return true;
		}
	});
	const set = (v: (prev: boolean) => boolean): void => {
		setOpen(prev => {
			const next = v(prev);
			try {
				localStorage.setItem(key, next ? "1" : "0");
			} catch {
				// storage unavailable
			}
			return next;
		});
	};
	return [open, set];
}
