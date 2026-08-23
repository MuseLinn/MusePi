import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { tapFeedback } from "../lib/haptic";
import { Icon } from "../vendor/oc-icons";
import { flattenTree, sessionSortKey, sortSessionTree } from "./session-list-shared";

/**
 * 会话列表节点(命名来源:本组件渲染的是左侧栏的**会话列表** — 每个节点
 * 是一个会话记录,可按 分组/项目/日期 聚合,行上带生命周期状态/置顶/工作脉动)。
 *
 * ⚠️ 命名陷阱:这里的 "SessionList" 与 TUI 的 `/tree`(**会话内消息树**:
 * entry id/parentId 层级、分支导航)是**两个不同的概念**。本组件仅在"会话
 * 由另一会话 fork 而来"时借用 /tree 的父子结构画分支标记(见 fork 标记处),
 * 它本身不是消息树。消息树的 GUI 侧载体见 `lib/message-tree.ts`(buildMessageTree),
 * 对应 TUI `/tree` / 未来 `/trace`。
 */
export interface SessionListEntry {
	type: string;
	id: string;
	/** 会话级父会话 id(fork 来源;消息树场景对应 entry 父节点,见 message-tree)。 */
	parentId: string | null;
	timestamp: string;
	/** Last-activity time (openchamber `time.updated` parity) — the session
	 *  tree orders by this so a resumed session rises; falls back to
	 *  `timestamp` (createdAt) when the daemon predates the field. */
	updatedAt?: string;
	label?: string;
	/** Session origin — "cron" for scheduled-task runs (grouped apart). */
	source?: string;
}

/** Session lifecycle status (TUI session-list parity). */
export type SessionStatus = "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";

/**
 * Status → color token (kimiwork 状态色 parity): the row's left square uses
 * this. Interrupted = warning (orange) so unfinished work pops; complete =
 * success (green); error = danger; aborted = muted; pending = accent.
 */
const STATUS_COLOR: Record<SessionStatus, string | undefined> = {
	complete: "var(--color-ok)",
	interrupted: "var(--color-warning)",
	aborted: "var(--color-text-faint)",
	error: "var(--color-danger)",
	pending: "var(--color-accent)",
	unknown: undefined,
};

/** Row's left-square fill: manual tag wins over derived status, both
 *  resolved through the same STATUS_COLOR map. (Logic inlined in the
 *  render — `const status = manualTags?.get(id) ?? statuses?.get(id)`) */

/** Compact row time (openchamber: 0.72rem muted right-aligned). */
function rowTime(ts: string): string {
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return "";
	const now = new Date();
	const sameDay = d.toDateString() === now.toDateString();
	return sameDay
		? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
		: d.toLocaleDateString([], { month: "short", day: "numeric" });
}

export interface SessionListNode {
	entry: SessionListEntry;
	children: SessionListNode[];
	label?: string;
}

/** Build the prefix (indent + connectors) for one flat node. */
function treePrefix(indent: number, showConnector: boolean, isLast: boolean): string {
	let prefix = "";
	for (let i = 0; i < indent; i++) prefix += "  ";
	if (showConnector) prefix += isLast ? "└─ " : "├─ ";
	return prefix;
}

export function SessionList({
	nodes,
	selectedId,
	onSelect,
	onContextMenu,
	unread,
	pausedIds,
	workingIds,
	statuses,
	manualTags,
	sort = "statusTime",
}: {
	nodes: SessionListNode[];
	selectedId: string | null;
	onSelect(id: string): void;
	/** Right-click a session row (ZCode task menu). */
	onContextMenu?(sessionId: string, x: number, y: number): void;
	/** Session ids with the 未读 marker. */
	unread?: ReadonlySet<string>;
	/** Paused session ids — render a pause chip so frozen sessions are
	 *  visible in the sidebar (per-session pause, TUI `/pause` parity). */
	pausedIds?: ReadonlySet<string>;
	/** Live sessions with a running agent turn (kimi 进行中 parity) —
	 *  pulsing accent dot on the row. */
	workingIds?: ReadonlySet<string>;
	/** Lifecycle status per session id (TUI session-list parity: complete /
	 *  interrupted / aborted / error / pending) — tints the row's left
	 *  square so unfinished history reads at a glance without grouping. */
	statuses?: ReadonlyMap<string, SessionStatus>;
	/** User-assigned status TAG per session id (ContextMenu #完成/#中断/
	 *  #错误…) — persisted locally, wins over the derived status. */
	manualTags?: ReadonlyMap<string, SessionStatus>;
	/** Row order: "statusTime" (default) pins working, then unread
	 *  sessions to the top and sorts the rest newest-first; "none"
	 *  preserves the caller's order (groups keep manual drag-reorder
	 *  order below their own status pins). */
	sort?: "statusTime" | "none";
}): ReactNode {
	// Hierarchical sort FIRST (roots + each sibling group by last-activity,
	// with the working/unread rank as a primary key within each group), THEN
	// flatten. Sorting the flattened array instead would scatter forked
	// children out of their parent subtrees and reshuffle on every poll.
	const ordered = sort !== "none" ? sortSessionTree(nodes, (a, b) => {
		const rank = (id: string): number => (workingIds?.has(id) ? 2 : 0) + (unread?.has(id) ? 1 : 0);
		const rDelta = rank(b.entry.id) - rank(a.entry.id);
		if (rDelta !== 0) return rDelta;
		return sessionSortKey(b) - sessionSortKey(a) || b.entry.id.localeCompare(a.entry.id);
	}) : nodes;
	const flat = flattenTree(ordered);
	if (flat.length === 0) return null;
	// Parent lookup for fork markers **at the SESSION level** (a session forked
	// from another session shows a branch glyph + the parent's label on hover).
	// Note: this is cross-session fork structure, NOT the within-session message
	// tree that TUI `/tree` navigates (see lib/message-tree.ts).
	const byId = new Map(flat.map(f => [f.node.entry.id, f.node]));
	return (
		<ul className="gui-session-list">
			{flat.map(({ node, ...flatProps }) => {
				const parent = node.entry.parentId ? byId.get(node.entry.parentId) : null;
				// Manual status tag wins over the derived one — same precedence
				// as `statusFill`, so the chip's tooltip always matches its color.
				const status = manualTags?.get(node.entry.id) ?? statuses?.get(node.entry.id);
				const fill = status ? STATUS_COLOR[status] : undefined;
				return (
					<li key={node.entry.id}>
						<button
							type="button"
							className={`gui-session-row${node.entry.id === selectedId ? " gui-session-row-active" : ""}${unread?.has(node.entry.id) ? " gui-session-row--unread" : ""}`}
							onClick={() => {
								tapFeedback();
								onSelect(node.entry.id);
							}}
							onContextMenu={e => {
								e.preventDefault();
								e.stopPropagation();
								onContextMenu?.(node.entry.id, e.clientX, e.clientY);
							}}
							title={
								parent
									? `${t("forked from")}: ${parent.entry.label ?? t("untitled session")} · ${node.entry.id}`
									: (node.entry.label ?? t("untitled session"))
							}
							{...((node.entry.label ?? "").trim() ? {} : { "data-untitled": "1" })}
							draggable
							onDragStart={e => {
								e.dataTransfer.setData("text/plain", node.entry.id);
								e.dataTransfer.effectAllowed = "copy";
							}}
						>
							{/* Lifecycle status square (TUI session-list parity): a
							 * per-session color chip that survives without grouping —
							 * interrupted (warning) / complete (success) / error /
							 * aborted / pending, or the user's manual color. */}
							<span
								className="gui-session-status"
								aria-hidden="true"
								style={fill ? { background: fill } : undefined}
								title={status ? t(`session status ${status}` as const) : undefined}
							/>
							<span className="gui-tree-prefix">
								{treePrefix(flatProps.indent, flatProps.showConnector, flatProps.isLast)}
							</span>
							<span className="gui-session-title">{node.entry.label ?? t("untitled session")}</span>
							{pausedIds?.has(node.entry.id) && (
								<span className="gui-tree-pause" role="img" aria-label={t("paused")} title={t("paused")}>
									<Icon name="pause" className="h-3 w-3" />
								</span>
							)}
							{workingIds?.has(node.entry.id) && (
								<span className="gui-tree-working" role="img" aria-label={t("in progress")} title={t("in progress")}>
									<span className="gui-tree-working-dot" aria-hidden />
								</span>
							)}
							{parent && (
								<span
									className="gui-tree-fork"
									role="img"
									aria-label={t("forked session")}
									title={t("forked from {name}", { name: parent.entry.label ?? t("untitled session") })}
								>
									<Icon name="git-branch" className="h-3 w-3" />
								</span>
							)}
							<span className="gui-session-time">{rowTime(node.entry.timestamp)}</span>
						</button>
					</li>
				);
			})}
		</ul>
	);
}
