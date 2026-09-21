import { t } from "@musepi/client-core";
import type { CSSProperties, ReactNode } from "react";
import { memo } from "react";
import { tapFeedback } from "../lib/haptic";
import { Icon } from "../vendor/oc-icons";
import { clearSessionHover, reportSessionHover } from "./SessionHoverCard";
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

/** Full timestamp for the row tooltip — keeps both readings so the compact
 *  label can be last-activity without losing the creation date. */
function fullTime(ts: string): string {
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export interface SessionListNode {
	entry: SessionListEntry;
	children: SessionListNode[];
	label?: string;
}

/** Accent wash for a matched title fragment — the same palette language as
 *  `.gui-settings-match`, inline so row titles need no new stylesheet rule.
 *  `color` is pinned to the inherited title color because the UA `mark` style
 *  would otherwise paint the fragment black. */
const SEARCH_HIT_STYLE: CSSProperties = {
	background: "color-mix(in oklab, var(--color-accent) 22%, transparent)",
	color: "inherit",
};

/**
 * Split `text` into plain/marked segments around the first occurrence of each
 * whitespace token (case-insensitive). The filter itself is subsequence-fuzzy,
 * so a row that only matches as a scattered subsequence renders unmarked
 * instead of marking noise.
 */
function searchSegments(text: string, query: string): Array<{ text: string; hit: boolean }> {
	const q = query.trim().toLowerCase();
	if (!q || !text) return [{ text, hit: false }];
	const lower = text.toLowerCase();
	const marks = new Array<boolean>(text.length).fill(false);
	let any = false;
	for (const token of q.split(/\s+/)) {
		if (!token) continue;
		const at = lower.indexOf(token);
		if (at < 0) continue;
		any = true;
		for (let i = at; i < at + token.length; i++) marks[i] = true;
	}
	if (!any) return [{ text, hit: false }];
	const segments: Array<{ text: string; hit: boolean }> = [];
	let start = 0;
	let hit = marks[0]!;
	for (let i = 1; i <= text.length; i++) {
		const next = i < text.length ? marks[i]! : !hit;
		if (next === hit) continue;
		segments.push({ text: text.slice(start, i), hit });
		start = i;
		hit = next;
	}
	return segments;
}

/** Row title with the matched fragments marked. */
function SearchHitText({ text, query }: { text: string; query: string }): ReactNode {
	return searchSegments(text, query).map((segment, index) =>
		segment.hit ? (
			<mark key={index} className="rounded-[3px]" style={SEARCH_HIT_STYLE}>
				{segment.text}
			</mark>
		) : (
			segment.text
		),
	);
}
/** The 8-ray starburst for a running turn — built once at module scope so a
 *  memoized row never rebuilds 8 `<line>` elements on re-render. */
const WORKING_RAYS = Array.from({ length: 8 }, (_, i) => {
	const a = (i * Math.PI) / 4;
	return (
		<line
			key={i}
			x1={8 + Math.cos(a) * 2.4}
			y1={8 + Math.sin(a) * 2.4}
			x2={8 + Math.cos(a) * 6.6}
			y2={8 + Math.sin(a) * 6.6}
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			opacity={0.3 + (i / 7) * 0.7}
		/>
	);
});

/** Build the prefix (indent + connectors) for one flat node. */
function treePrefix(indent: number, showConnector: boolean, isLast: boolean): string {
	let prefix = "";
	for (let i = 0; i < indent; i++) prefix += "  ";
	if (showConnector) prefix += isLast ? "└─ " : "├─ ";
	return prefix;
}

/**
 * One session row. Memoized on **primitives only** (the parent resolves the
 * Set/Map lookups to booleans before rendering), so a sidebar re-render —
 * a 5s status poll, a streaming update, a pinned/tag change — re-renders only
 * the rows whose own props actually changed instead of the whole list.
 * `onSelect` / `onContextMenu` must be stable (useCallback) at the call site
 * for the memo to hold.
 */
const SessionRow = memo(function SessionRow({
	id,
	label,
	parentLabel,
	timestamp,
	updatedAt,
	selected,
	unread,
	paused,
	working,
	status,
	untitled,
	indent,
	showConnector,
	isLast,
	searchQuery,
	onSelect,
	onContextMenu,
}: {
	id: string;
	label: string;
	/** Fork source label, or null when the session is not a fork. */
	parentLabel: string | null;
	timestamp: string;
	/** Last-activity time; the row's compact label prefers it over `timestamp`. */
	updatedAt?: string;
	selected: boolean;
	unread: boolean;
	paused: boolean;
	working: boolean;
	status?: SessionStatus;
	untitled: boolean;
	indent: number;
	showConnector: boolean;
	isLast: boolean;
	searchQuery: string;
	onSelect(id: string): void;
	onContextMenu?(sessionId: string, x: number, y: number): void;
}): ReactNode {
	const fill = status ? STATUS_COLOR[status] : undefined;
	return (
		<li>
			<button
				type="button"
				className={`gui-session-row${selected ? " gui-session-row-active" : ""}${unread ? " gui-session-row--unread" : ""}`}
				onClick={() => {
					tapFeedback();
					// 点开即收卡:行位置随排序/状态变化,卡片锚点已失效。
					clearSessionHover();
					onSelect(id);
				}}
				onContextMenu={e => {
					e.preventDefault();
					e.stopPropagation();
					onContextMenu?.(id, e.clientX, e.clientY);
				}}
				onMouseEnter={e =>
					reportSessionHover({
						id,
						label,
						parentLabel,
						timestamp,
						updatedAt,
						anchor: e.currentTarget.getBoundingClientRect(),
					})
				}
				onMouseLeave={clearSessionHover}
				{...(untitled ? { "data-untitled": "1" } : {})}
				draggable
				onDragStart={e => {
					e.dataTransfer.setData("text/plain", id);
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
				<span className="gui-tree-prefix">{treePrefix(indent, showConnector, isLast)}</span>
				<span className="gui-session-title">
					{searchQuery.trim() ? <SearchHitText text={label} query={searchQuery} /> : label}
				</span>
				{paused && (
					<span className="gui-tree-pause" role="img" aria-label={t("paused")} title={t("paused")}>
						<Icon name="pause" className="h-3 w-3" />
					</span>
				)}
				{working && (
					<span className="gui-tree-working" role="img" aria-label={t("in progress")} title={t("in progress")}>
						{/* ZCode parity: an 8-ray starburst spinning while the
						 * agent turn runs (was a breathing dot) — opacity ramps
						 * around the ring so the rotation reads at 12px. */}
						<svg className="gui-tree-working-spin" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
							{WORKING_RAYS}
						</svg>
					</span>
				)}
				{parentLabel && (
					<span
						className="gui-tree-fork"
						role="img"
						aria-label={t("forked session")}
						title={t("forked from {name}", { name: parentLabel })}
					>
						<Icon name="git-branch" className="h-3 w-3" />
					</span>
				)}
				{/* Last activity beats creation time: a session resumed today
				 *  should not still read "3 days ago". The tooltip carries
				 *  both readings so the creation date is never lost. */}
				<span
					className="gui-session-time"
					title={
						updatedAt && updatedAt !== timestamp
							? `${t("last active")}: ${fullTime(updatedAt)} · ${t("created at")}: ${fullTime(timestamp)}`
							: fullTime(timestamp)
					}
				>
					{rowTime(updatedAt ?? timestamp)}
				</span>
			</button>
		</li>
	);
});

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
	searchQuery = "",
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
	/** Row order: "statusTime" (default) sorts by last-activity, newest
	 *  first (working/unread are visual row markers only — they must not
	 *  reorder rows under the cursor, see note above); "none" preserves the
	 *  caller's order (groups keep manual drag-reorder order). */
	sort?: "statusTime" | "none";
	/** Active session-search query — matched title fragments are marked. */
	searchQuery?: string;
}): ReactNode {
	// Hierarchical sort FIRST (roots + each sibling group by last-activity,
	// with a stable id tiebreak), THEN flatten. Sorting the flattened array
	// instead would scatter forked children out of their parent subtrees and
	// reshuffle on every poll.
	//
	// ⚠️ NO working/unread rank here (was `working?2:0 + unread?1:0` as the
	// primary key): both flags flip as a DIRECT result of clicking a row —
	// opening clears the unread mark, leaving drops `working` — so the row
	// under the cursor jumped up/down on every switch (user: 点击切换会话时
	// 排序跳动). Order is purely last-activity; working/unread stay as
	// visual-only row indicators (pulse dot, bold title).
	const ordered =
		sort !== "none"
			? sortSessionTree(nodes, (a, b) => {
					return sessionSortKey(b) - sessionSortKey(a) || b.entry.id.localeCompare(a.entry.id);
				})
			: nodes;
	const flat = flattenTree(ordered);
	if (flat.length === 0) return null;
	// Parent lookup for fork markers **at the SESSION level** (a session forked
	// from another session shows a branch glyph + the parent's label on hover).
	// Note: this is cross-session fork structure, NOT the within-session message
	// tree that TUI `/tree` navigates (see lib/message-tree.ts).
	const byId = new Map(flat.map(f => [f.node.entry.id, f.node]));
	return (
		<ul className="gui-session-list">
			{flat.map(({ node, indent, showConnector, isLast }) => {
				const parent = node.entry.parentId ? byId.get(node.entry.parentId) : null;
				// Manual status tag wins over the derived one — same precedence
				// as `statusFill`, so the chip's tooltip always matches its color.
				const status = manualTags?.get(node.entry.id) ?? statuses?.get(node.entry.id);
				return (
					<SessionRow
						key={node.entry.id}
						id={node.entry.id}
						label={node.entry.label ?? t("untitled session")}
						parentLabel={parent ? (parent.entry.label ?? t("untitled session")) : null}
						timestamp={node.entry.timestamp}
						updatedAt={node.entry.updatedAt}
						selected={node.entry.id === selectedId}
						unread={unread?.has(node.entry.id) ?? false}
						paused={pausedIds?.has(node.entry.id) ?? false}
						working={workingIds?.has(node.entry.id) ?? false}
						status={status}
						untitled={!(node.entry.label ?? "").trim()}
						indent={indent}
						showConnector={showConnector}
						isLast={isLast}
						searchQuery={searchQuery}
						onSelect={onSelect}
						onContextMenu={onContextMenu}
					/>
				);
			})}
		</ul>
	);
}
