import { t } from "@musepi/collab-web";
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
}): ReactNode {
	const flat = flattenTree(nodes);
	if (flat.length === 0) return null;
	// Parent lookup for fork markers (OMP /tree parity: sessions forked from
	// another session show a branch glyph + the parent's label on hover).
	const byId = new Map(flat.map(f => [f.node.entry.id, f.node]));
	return (
		<ul className="gui-session-list">
			{flat.map(({ node, ...flatProps }) => {
				const parent = node.entry.parentId ? byId.get(node.entry.parentId) : null;
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
								onContextMenu?.(node.entry.id, e.clientX, e.clientY);
							}}
							title={
								parent
									? `${t("forked from")}: ${parent.entry.label ?? t("untitled session")} · ${node.entry.id}`
									: node.entry.id
							}
							{...((node.entry.label ?? "").trim() ? {} : { "data-untitled": "1" })}
							draggable
							onDragStart={e => {
								e.dataTransfer.setData("text/plain", node.entry.id);
								e.dataTransfer.effectAllowed = "copy";
							}}
						>
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
