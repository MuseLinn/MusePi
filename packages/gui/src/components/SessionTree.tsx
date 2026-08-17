import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { tapFeedback } from "../lib/haptic";
import { Icon } from "../vendor/oc-icons";
import { flattenTree } from "./session-tree-shared";

/**
 * Session tree node — mirrors the OMP `/tree` SessionTreeNode contract
 * (entry id/parentId hierarchy, children, optional label).
 */
export interface GuiTreeEntry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
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

/** Row's left-square fill: a manual status tag wins over the derived
 *  status, both resolved through the same STATUS_COLOR map. */
function statusFill(status: SessionStatus | undefined, manualTag: SessionStatus | undefined): string | undefined {
	return manualTag ? STATUS_COLOR[manualTag] : status ? STATUS_COLOR[status] : undefined;
}

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

export interface GuiTreeNode {
	entry: GuiTreeEntry;
	children: GuiTreeNode[];
	label?: string;
}

/** Build the prefix (indent + connectors) for one flat node. */
function treePrefix(indent: number, showConnector: boolean, isLast: boolean): string {
	let prefix = "";
	for (let i = 0; i < indent; i++) prefix += "  ";
	if (showConnector) prefix += isLast ? "└─ " : "├─ ";
	return prefix;
}

export function SessionTree({
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
	nodes: GuiTreeNode[];
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
	const flat = flattenTree(nodes);
	if (flat.length === 0) return null;
	if (sort !== "none") {
		const rank = (id: string): number => (workingIds?.has(id) ? 2 : 0) + (unread?.has(id) ? 1 : 0);
		flat.sort(
			(a, b) =>
				rank(b.node.entry.id) - rank(a.node.entry.id) ||
				Date.parse(b.node.entry.timestamp) - Date.parse(a.node.entry.timestamp),
		);
	}
	// Parent lookup for fork markers (OMP /tree parity: sessions forked from
	// another session show a branch glyph + the parent's label on hover).
	const byId = new Map(flat.map(f => [f.node.entry.id, f.node]));
	return (
		<ul className="gui-session-list">
			{flat.map(({ node, ...flatProps }) => {
				const parent = node.entry.parentId ? byId.get(node.entry.parentId) : null;
				const fill = statusFill(statuses?.get(node.entry.id), manualTags?.get(node.entry.id));
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
							/>
							<span className="gui-tree-prefix">
								{treePrefix(flatProps.indent, flatProps.showConnector, flatProps.isLast)}
							</span>
							<span className="gui-session-title">{node.entry.label ?? t("untitled session")}</span>
							{pausedIds?.has(node.entry.id) && (
								<span className="gui-tree-pause" aria-label={t("paused")} title={t("paused")}>
									<Icon name="pause" className="h-3 w-3" />
								</span>
							)}
							{workingIds?.has(node.entry.id) && (
								<span className="gui-tree-working" aria-label={t("in progress")} title={t("in progress")}>
									<span className="gui-tree-working-dot" aria-hidden />
								</span>
							)}
							{parent && (
								<span
									className="gui-tree-fork"
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
