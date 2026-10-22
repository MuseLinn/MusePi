import { type TranslationKey, t } from "@musepi/client-core";
import type { CSSProperties, ReactNode } from "react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
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

/** Session status labels are keyed per status id (closed set, from
 *  session.list). */
const SESSION_STATUS_KEY: Record<string, TranslationKey> = {
	aborted: "sessions.sessionStatusAborted",
	complete: "sessions.sessionStatusComplete",
	error: "sessions.sessionStatusError",
	interrupted: "sessions.sessionStatusInterrupted",
	pending: "sessions.sessionStatusPending",
	unknown: "sessions.sessionStatusUnknown",
};

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
	/** 子代理会话（transcript 挂在父会话目录下，daemon 两层扫描合并时
	 *  打标）——行尾渲染子代理标记，与 fork 标记同级。 */
	subagent?: boolean;
	/** 顾问 transcript 行（`__advisor[.<slug>].jsonl`）——渲染顾问标记
	 *  （区别于任务子代理），打开后转录只读。 */
	advisor?: boolean;
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

/** Indent guides for one flat node: one vertical line per ancestor level
 *  (sakura-branch styling lives in CSS). Replaces the old whitespace-only
 *  prefix — width per level is still 1em so title alignment is unchanged.
 *  The deepest guide (--branch) carries the blossom dot, i.e. the flower
 *  sits on the branch the row hangs off. */
function treeGuides(indent: number): ReactNode {
	if (indent <= 0) return null;
	return (
		<span className="gui-tree-prefix" aria-hidden="true">
			{Array.from({ length: indent }, (_, i) => (
				<span key={i} className={`gui-tree-guide${i === indent - 1 ? " gui-tree-guide--branch" : ""}`} />
			))}
		</span>
	);
}

/** 折叠态持久化(openchamber 文件夹层级 parity):父行 chevron 收起后整棵
 *  子树从列表隐藏,重开客户端仍记得。默认展开(与既有行为一致)。 */
const COLLAPSE_STORAGE_KEY = "musepi-gui-session-collapse";

function readCollapsedIds(): ReadonlySet<string> {
	try {
		const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY);
		if (!raw) return new Set();
		const parsed: unknown = JSON.parse(raw);
		return new Set(Array.isArray(parsed) ? (parsed as string[]) : []);
	} catch {
		return new Set();
	}
}

function writeCollapsedIds(ids: ReadonlySet<string>): void {
	try {
		localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify([...ids]));
	} catch {
		/* 存储不可用时折叠态仅保留在内存。 */
	}
}

/** 收起/展开单行高度补间：与全局伸缩规范（use-collapse.ts / WelcomeComposer
 *  建议区）同一阶梯 —— 240ms、cubic-bezier(0.22,1,0.36,1)。子树多行同时补间，
 *  视觉上整棵子树同步收缩。 */
const SUBTREE_ANIM_MS = 240;
const SUBTREE_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

type SubtreePhase = "leaving" | "entering";
interface SubtreeSnapshot {
	collapsed: ReadonlySet<string>;
	phases: ReadonlyMap<string, SubtreePhase>;
}

/** 子树折叠共享存储：折叠态原本是每个 SessionList 实例各自的 useState，
 *  侧栏头部「全部展开/收起」按钮需要同时驱动所有实例（定时任务区、各项目
 *  块、未分组区各自渲染一份 SessionList），且持久化键本来也只有一份 ——
 *  提升为模块级存储（useSyncExternalStore 订阅），localStorage 持久化逻辑
 *  不变。 */
let subtreeCollapsed: ReadonlySet<string> = readCollapsedIds();
/** 动画中的节点：leaving = 子树行高收缩到 0、尚未从树剪除；entering = 已
 *  提交展开、行高从 0 长开。两阶段保证动画期间渲染树稳定。 */
const subtreePhases = new Map<string, SubtreePhase>();
/** 注册过的「有子会话的父行」id —— 全量收起时的目标集合。实例卸载不清理：
 *  折叠持久化在 localStorage，id 集合与会话总量同阶，留存无害。 */
const subtreeParentIds = new Set<string>();
const subtreeListeners = new Set<() => void>();
const subtreeTimers = new Map<string, ReturnType<typeof setTimeout>>();
let subtreeSnapshot: SubtreeSnapshot = { collapsed: subtreeCollapsed, phases: new Map() };

function emitSubtrees(): void {
	subtreeSnapshot = { collapsed: subtreeCollapsed, phases: new Map(subtreePhases) };
	for (const listener of subtreeListeners) listener();
}

function subscribeSubtrees(listener: () => void): () => void {
	subtreeListeners.add(listener);
	return () => subtreeListeners.delete(listener);
}

function getSubtreesSnapshot(): SubtreeSnapshot {
	return subtreeSnapshot;
}

function armSubtreeTimer(id: string, fn: () => void): void {
	const prev = subtreeTimers.get(id);
	if (prev !== undefined) clearTimeout(prev);
	subtreeTimers.set(
		id,
		setTimeout(() => {
			subtreeTimers.delete(id);
			fn();
		}, SUBTREE_ANIM_MS + 40),
	);
}

function setSubtreePhase(id: string, phase: SubtreePhase | null): void {
	if (phase === null) subtreePhases.delete(id);
	else subtreePhases.set(id, phase);
	emitSubtrees();
}

function commitSubtreeCollapsed(next: ReadonlySet<string>): void {
	subtreeCollapsed = next;
	writeCollapsedIds(next);
	emitSubtrees();
}

/** 收起/展开某一棵子树（父行 chevron）。收起先播收缩动画再剪枝；展开先
 *  提交再播长高动画。动画期间忽略重复点击，避免相位互相打断。 */
function toggleSubtreeCollapse(id: string): void {
	if (subtreePhases.has(id)) return;
	if (subtreeCollapsed.has(id)) {
		const next = new Set(subtreeCollapsed);
		next.delete(id);
		commitSubtreeCollapsed(next);
		setSubtreePhase(id, "entering");
		armSubtreeTimer(id, () => setSubtreePhase(id, null));
	} else {
		setSubtreePhase(id, "leaving");
		armSubtreeTimer(id, () => {
			const next = new Set(subtreeCollapsed);
			next.add(id);
			commitSubtreeCollapsed(next);
			setSubtreePhase(id, null);
		});
	}
}

/** 当前是否存在已收起的子树（头部「全部展开/收起」判断切换方向用）。 */
export function hasCollapsedSubtrees(): boolean {
	return subtreeCollapsed.size > 0;
}

/** 全量收起/展开所有已注册的父行。逐棵走 toggleSubtreeCollapse 的动画
 *  路径，视觉与单棵 chevron 折叠一致（多棵同时补间）。 */
export function setAllSubtreesCollapsed(collapse: boolean): void {
	if (collapse) {
		for (const id of subtreeParentIds) {
			if (!subtreeCollapsed.has(id)) toggleSubtreeCollapse(id);
		}
	} else {
		for (const id of [...subtreeCollapsed]) toggleSubtreeCollapse(id);
	}
}

function registerSubtreeParents(ids: ReadonlySet<string>): void {
	for (const id of ids) subtreeParentIds.add(id);
}

/** 折叠剪枝:被收起节点的整棵子树从渲染树剔除(返回新树,输入不变)。 */
function pruneCollapsedNodes(nodes: SessionListNode[], collapsed: ReadonlySet<string>): SessionListNode[] {
	return nodes.map(n => {
		if (!collapsed.has(n.entry.id)) {
			return n.children.length > 0 ? { ...n, children: pruneCollapsedNodes(n.children, collapsed) } : n;
		}
		return { ...n, children: [] };
	});
}

/** 每节点的直接子会话数(渲染折叠 chevron 用,取自剪枝前的树)。 */
function childCountMap(nodes: SessionListNode[]): Map<string, number> {
	const map = new Map<string, number>();
	const walk = (list: SessionListNode[]): void => {
		for (const n of list) {
			map.set(n.entry.id, n.children.length);
			walk(n.children);
		}
	};
	walk(nodes);
	return map;
}

const EMPTY_IDS: ReadonlySet<string> = new Set();

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
	searchQuery,
	subagent,
	advisor,
	childCount,
	collapsed,
	anim,
	onToggleCollapse,
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
	searchQuery: string;
	/** 子代理会话行（父会话的子树行）——渲染子代理标记。 */
	subagent: boolean;
	/** 顾问 transcript 行——渲染顾问标记（区别于任务子代理）。 */
	advisor: boolean;
	/** 直接子会话数（>0 = 父行,渲染折叠 chevron）。 */
	childCount: number;
	/** 子树当前是否收起。 */
	collapsed: boolean;
	/** 折叠补间相位：自身或某位祖先的子树正在收起/展开，本行行高跟随补间。 */
	anim: SubtreePhase | null;
	onToggleCollapse?(id: string): void;
	onSelect(id: string): void;
	onContextMenu?(sessionId: string, x: number, y: number): void;
}): ReactNode {
	const fill = status ? STATUS_COLOR[status] : undefined;
	const itemRef = useRef<HTMLLIElement | null>(null);
	// 子树折叠的高度补间（use-collapse.ts 同一规范的行级版）：收起把行高锁
	// 到当前值再补到 0px，展开反方向；结束时清掉内联样式回归自然布局。用
	// useLayoutEffect 避免新挂载的展开行在首帧以全高闪现再塌缩。
	useLayoutEffect(() => {
		const li = itemRef.current;
		if (!li || anim === null) return;
		li.style.overflow = "hidden";
		li.style.transition = "none";
		li.style.height = anim === "leaving" ? `${li.scrollHeight}px` : "0px";
		// 强制回流，让起点高度在启用补间前生效。
		void li.offsetHeight;
		li.style.transition = `height ${SUBTREE_ANIM_MS}ms ${SUBTREE_EASING}`;
		li.style.height = anim === "leaving" ? "0px" : `${li.scrollHeight}px`;
		const settle = (): void => {
			if (anim === "entering") {
				li.style.height = "";
				li.style.overflow = "";
			}
		};
		const timer = setTimeout(settle, SUBTREE_ANIM_MS + 60);
		const onEnd = (): void => {
			clearTimeout(timer);
			settle();
		};
		li.addEventListener("transitionend", onEnd, { once: true });
		return () => {
			clearTimeout(timer);
			li.removeEventListener("transitionend", onEnd);
		};
	}, [anim]);
	return (
		<li ref={itemRef}>
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
				{childCount > 0 ? (
					<button
						type="button"
						className="gui-tree-fold"
						aria-label={t(collapsed ? "general.expandSubtree" : "general.collapseSubtree")}
						aria-expanded={!collapsed}
						title={t(collapsed ? "general.expandSubtree" : "general.collapseSubtree")}
						onClick={e => {
							e.stopPropagation();
							onToggleCollapse?.(id);
						}}
					>
						<Icon
							name="arrow-right-s"
							className={`h-3 w-3 gui-tree-fold-arrow${collapsed ? "" : " gui-tree-fold-arrow--open"}`}
						/>
					</button>
				) : (
					<span className="gui-tree-fold gui-tree-fold--leaf" aria-hidden="true" />
				)}
				<span
					className="gui-session-status"
					aria-hidden="true"
					style={fill ? { background: fill } : undefined}
					title={status ? t(SESSION_STATUS_KEY[status] ?? status) : undefined}
				/>
				{treeGuides(indent)}
				<span className="gui-session-title">
					{searchQuery.trim() ? <SearchHitText text={label} query={searchQuery} /> : label}
				</span>
				{paused && (
					<span className="gui-tree-pause" role="img" aria-label={t("tools.paused")} title={t("tools.paused")}>
						<Icon name="pause" className="h-3 w-3" />
					</span>
				)}
				{working && (
					<span
						className="gui-tree-working"
						role="img"
						aria-label={t("settings.inProgress")}
						title={t("settings.inProgress")}
					>
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
						aria-label={t("general.forkedSession")}
						title={t("general.forkedFromWithName", { name: parentLabel })}
					>
						<Icon name="git-branch" className="h-3 w-3" />
					</span>
				)}
				{subagent && (
					<span
						className="gui-tree-fork"
						role="img"
						aria-label={t("general.subagentSession")}
						title={t("general.subagentSession")}
					>
						<Icon name="ai-agent-fill" className="h-3 w-3" />
					</span>
				)}
				{advisor && (
					<span
						className="gui-tree-advisor"
						role="img"
						aria-label={t("general.advisorSession")}
						title={t("general.advisorSession")}
					>
						<Icon name="sparkling" className="h-3 w-3" />
					</span>
				)}
				{/* Last activity beats creation time: a session resumed today
				 *  should not still read "3 days ago". The tooltip carries
				 *  both readings so the creation date is never lost. */}
				<span
					className="gui-session-time"
					title={
						updatedAt && updatedAt !== timestamp
							? `${t("general.lastActive")}: ${fullTime(updatedAt)} · ${t("general.createdAt")}: ${fullTime(timestamp)}`
							: fullTime(timestamp)
					}
				>
					{rowTime(updatedAt ?? timestamp)}
				</span>
			</button>
		</li>
	);
});

function SessionListComponent({
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
	//
	// The sort/flatten pipeline is memoized on the inputs it derives from:
	// a sidebar re-render for unrelated state (menu open, hover chip) must
	// not re-sort every group. Row elements below are memoized separately.
	const ordered = useMemo(
		() =>
			sort !== "none"
				? sortSessionTree(nodes, (a, b) => {
						return sessionSortKey(b) - sessionSortKey(a) || b.entry.id.localeCompare(a.entry.id);
					})
				: nodes,
		[nodes, sort],
	);
	// 折叠态：模块级共享存储（定义在文件上方 store 区），跨 SessionList
	// 实例同步 —— 侧栏头部的「全部展开/收起」按钮要同时驱动定时任务区/
	// 各项目块/未分组区的所有子树。leaving 相位的子树尚未剪除（行高补间
	// 到 0 后才提交），因此剪枝仍只认 collapsedIds，渲染树在动画全程稳定。
	const { collapsed: collapsedIds, phases } = useSyncExternalStore(
		subscribeSubtrees,
		getSubtreesSnapshot,
		// renderToString 测试路径（无 hydration）用同一快照。
		getSubtreesSnapshot,
	);
	// 搜索期间强制展开:命中行可能藏在收起的子树里,剪枝会让命中不可见。
	const effectiveCollapsed = searchQuery.trim() ? EMPTY_IDS : collapsedIds;
	const childCounts = useMemo(() => childCountMap(ordered), [ordered]);
	// 把「有子会话的父行」注册进共享存储 —— 侧栏头部「全部展开/收起」按这个
	// 集合全量收起。
	useEffect(() => {
		const parents = new Set<string>();
		for (const [id, count] of childCounts) {
			if (count > 0) parents.add(id);
		}
		registerSubtreeParents(parents);
	}, [childCounts]);
	const flat = useMemo(
		() => flattenTree(pruneCollapsedNodes(ordered, effectiveCollapsed)),
		[ordered, effectiveCollapsed],
	);
	// 行级补间相位：自身或最近一位带相位祖先决定本行是 leaving 还是
	// entering。父链取自剪枝前的树，leaving 子树的行才能在剪除前拿到相位。
	const parentOf = useMemo(() => {
		const map = new Map<string, string>();
		const walk = (list: SessionListNode[]): void => {
			for (const n of list) {
				for (const c of n.children) map.set(c.entry.id, n.entry.id);
				walk(n.children);
			}
		};
		walk(ordered);
		return map;
	}, [ordered]);
	const animFor = (id: string): SubtreePhase | null => {
		let current: string | undefined = id;
		while (current !== undefined) {
			const phase = phases.get(current);
			if (phase !== undefined) return phase;
			current = parentOf.get(current);
		}
		return null;
	};
	if (flat.length === 0) return null;
	// Parent lookup for fork markers **at the SESSION level** (a session forked
	// from another session shows a branch glyph + the parent's label on hover).
	// Note: this is cross-session fork structure, NOT the within-session message
	// tree that TUI `/tree` navigates (see lib/message-tree.ts).
	const byId = new Map(flat.map(f => [f.node.entry.id, f.node]));
	return (
		<ul className="gui-session-list">
			{flat.map(({ node, indent }) => {
				const parent = node.entry.parentId ? byId.get(node.entry.parentId) : null;
				// Manual status tag wins over the derived one — same precedence
				// as `statusFill`, so the chip's tooltip always matches its color.
				const status = manualTags?.get(node.entry.id) ?? statuses?.get(node.entry.id);
				return (
					<SessionRow
						key={node.entry.id}
						id={node.entry.id}
						label={node.entry.label ?? t("transcript.untitledSession")}
						parentLabel={parent ? (parent.entry.label ?? t("transcript.untitledSession")) : null}
						timestamp={node.entry.timestamp}
						updatedAt={node.entry.updatedAt}
						selected={node.entry.id === selectedId}
						unread={unread?.has(node.entry.id) ?? false}
						paused={pausedIds?.has(node.entry.id) ?? false}
						working={workingIds?.has(node.entry.id) ?? false}
						status={status}
						untitled={!(node.entry.label ?? "").trim()}
						indent={indent}
						searchQuery={searchQuery}
						subagent={node.entry.subagent === true}
						advisor={node.entry.advisor === true}
						childCount={childCounts.get(node.entry.id) ?? 0}
						collapsed={collapsedIds.has(node.entry.id) || phases.get(node.entry.id) === "leaving"}
						anim={animFor(node.entry.id)}
						onToggleCollapse={toggleSubtreeCollapse}
						onSelect={onSelect}
						onContextMenu={onContextMenu}
					/>
				);
			})}
		</ul>
	);
}

/**
 * Memoized shell around the list body: callers pass useMemo'd Sets/Maps and
 * stable callbacks, so a sidebar re-render that doesn't move any prop (menu
 * toggles, hover state) skips the whole list — the sort/flatten memos inside
 * already guard the pipeline, and the row elements are memoized on their
 * own primitive props below this.
 */
export const SessionList = memo(SessionListComponent);
