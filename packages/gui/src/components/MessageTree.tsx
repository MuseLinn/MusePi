/**
 * Desktop message-tree navigation (TUI tree-selector parity): a floating
 * searchable panel listing the session's turns in tree form — each user
 * message is a root, its assistant replies + tool results nest beneath it.
 * Click a row to jump the transcript to that entry.
 *
 * The wire entries carry no parentId (the view flattens the SDK tree), so
 * the tree here is turn-grouped from the linear entry stream; GUI sessions
 * branch via session.fork (a NEW session), not in-place, so this matches
 * the TUI tree for everything the Desktop can produce.
 */
import { t } from "@musepi/desktop-web";
import type { SessionEntry } from "@musepi/pi-wire";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../vendor/oc-icons";

interface TurnNode {
	entry: SessionEntry;
	children: TurnNode[];
	text: string;
	kind: "user" | "assistant" | "toolResult";
}

/** 消息树可见性过滤(TUI tree-selector FilterMode 同款语义,settings-schema
 *  treeFilterMode 同型;GUI 本地 UI 不读 tuiOnly 设置)。 */
export type TreeFilterMode = "default" | "no-tools" | "user-only" | "labeled-only" | "all";

/** TUI FilterMode 语义照搬,作用于 turn 树节点可见性:
 *  - default:常规(全显示 —— GUI 树构建已排除书签/系统条目,等价 TUI default)
 *  - no-tools:隐藏 toolResult 节点
 *  - user-only:只显示 user 根节点
 *  - labeled-only:只显示有可见文本的节点(GUI 无 label 概念,文本非空即"有标签")
 *  - all:全显示(同 default;保留枚举对齐) */
function applyTreeFilter(nodes: TurnNode[], mode: TreeFilterMode): TurnNode[] {
	if (mode === "default" || mode === "all") return nodes;
	const out: TurnNode[] = [];
	for (const node of nodes) {
		if (mode === "user-only" && node.kind !== "user") continue;
		if (mode === "no-tools" && node.kind === "toolResult") continue;
		if (mode === "labeled-only" && !node.text.trim()) continue;
		out.push({
			...node,
			children: mode === "user-only" ? [] : applyTreeFilter(node.children, mode),
		});
	}
	return out;
}

function previewText(entry: SessionEntry): string {
	if (entry.type !== "message") return entry.type;
	const m = entry.message;
	if (m.role === "toolResult") {
		const toolName = "toolName" in m && typeof m.toolName === "string" ? m.toolName : "tool";
		const text = Array.isArray(m.content)
			? m.content
					.map(b => (b && typeof b === "object" && "text" in b ? String(b.text) : ""))
					.filter(Boolean)
					.join(" ")
					.trim()
			: "";
		return `[${toolName}]${text ? ` ${text.slice(0, 60)}` : ""}`;
	}
	if (m.role === "bashExecution") {
		return `$ ${m.command}`;
	}
	const content = Array.isArray(m.content) ? m.content : [];
	const text = content
		.map(b => (b && typeof b === "object" && "text" in b ? String(b.text) : ""))
		.filter(Boolean)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	if (text) return text;
	const hasTool = content.some(
		b => typeof b === "object" && b !== null && (b as { type?: string }).type === "toolCall",
	);
	return hasTool ? t("tool calls") : t("thinking");
}

/** Raw user-message text for the composer backfill (TUI navigateTree
 *  parity: re-answering a user node loads its exact text, newlines kept —
 *  previewText collapses whitespace for the tree row display only). */
function rawUserText(entry: SessionEntry): string {
	if (entry.type !== "message") return "";
	const m = entry.message;
	if (m.role !== "user") return "";
	const content = m.content;
	if (typeof content === "string") return content;
	return content
		.filter((b): b is { type: "text"; text: string } => b?.type === "text")
		.map(b => b.text)
		.join("\n");
}

/** Group the linear entry stream into turns: user message = root; the
 *  assistant/toolResult messages after it nest beneath. Compaction and
 *  other non-message entries break the chain (start a new turn context). */
function buildTurnTree(entries: readonly SessionEntry[]): TurnNode[] {
	const roots: TurnNode[] = [];
	let current: TurnNode | null = null;
	for (const entry of entries) {
		if (entry.type !== "message") {
			current = null;
			continue;
		}
		const node: TurnNode = {
			entry,
			children: [],
			text: previewText(entry),
			kind:
				entry.message.role === "user" ? "user" : entry.message.role === "toolResult" ? "toolResult" : "assistant",
		};
		if (node.kind === "user") {
			roots.push(node);
			current = node;
		} else if (current) {
			current.children.push(node);
		} else {
			// Assistant work without a preceding user message in the window
			// (resumed mid-run) — still navigable as its own row.
			roots.push(node);
			current = node;
		}
	}
	return roots;
}

function matches(node: TurnNode, q: string): boolean {
	const needle = q.trim().toLowerCase();
	if (!needle) return true;
	return node.text.toLowerCase().includes(needle) || node.children.some(c => c.text.toLowerCase().includes(needle));
}

function filterTree(nodes: TurnNode[], q: string): TurnNode[] {
	if (!q.trim()) return nodes;
	const out: TurnNode[] = [];
	for (const node of nodes) {
		if (!matches(node, q)) continue;
		out.push({ ...node, children: node.children.filter(c => c.text.toLowerCase().includes(q.trim().toLowerCase())) });
	}
	return out;
}

export function MessageTreeButton({
	entries,
	onJump,
	onNavigateTo,
	onFork,
	onRevertTo,
	activePathIds,
}: {
	entries: readonly SessionEntry[];
	/** Jump the transcript to this entry (Transcript jumpRequest): the
	 *  transcript expands its window/compaction fold until the row mounts,
	 *  then scrolls + flashes. */
	onJump(timestamp: string): void;
	/** Row click switches the session leaf to this node (TUI /tree parity,
	 *  session.branchAt): user messages backfill the composer for re-answer;
	 *  assistant/toolResult nodes continue from the node. Falls back to
	 *  onJump (pure scroll) when absent. */
	onNavigateTo?(entry: SessionEntry): void;
	/** Fork a NEW session starting from this node (TUI navigateTree parity):
	 *  user messages truncate before the node and backfill the composer with
	 *  its text (re-answer); assistant/toolResult nodes keep the node as the
	 *  new session's last record (continue from there). */
	onFork?(entry: SessionEntry, text: string | undefined, includeTarget: boolean): void;
	/** 撤回到此消息(TUI /tree 切换的 GUI 对应原语):user 节点截断该消息
	 *  之后的会话尾部(daemon 备份,撤回 dock 可还原)。 */
	onRevertTo?(entry: SessionEntry): void;
	/** 活动路径 id 集(与画布/ContextPanel 同源);存在时替代"末子节点下行"
	 *  作为"当前位置"高亮,对齐 branchAt 后的真实 leaf 位置。 */
	activePathIds?: ReadonlySet<string>;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const [q, setQ] = useState("");
	const [filterMode, setFilterMode] = useState<TreeFilterMode>("default");
	const inputRef = useRef<HTMLInputElement | null>(null);
	const toggleRef = useRef<HTMLButtonElement | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const tree = useMemo(() => buildTurnTree(entries), [entries]);
	const filtered = useMemo(() => filterTree(applyTreeFilter(tree, filterMode), q), [tree, filterMode, q]);
	// 当前位置链(TUI currentLeafId/activePath parity):优先用父组件传入的
	// activePathIds(与画布同源,反映 branchAt 后的真实 leaf 路径);未提供时
	// 回退到"末子节点下行"推导的线性尾部链。
	const currentIds = useMemo(() => {
		if (activePathIds) return new Set(activePathIds);
		const ids = new Set<string>();
		let node: TurnNode | undefined = tree[tree.length - 1];
		while (node) {
			ids.add(node.entry.id);
			node = node.children[node.children.length - 1];
		}
		return ids;
	}, [tree, activePathIds]);

	useEffect(() => {
		if (!open) return;
		setQ("");
		requestAnimationFrame(() => inputRef.current?.focus());
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") setOpen(false);
		};
		const onPointerDown = (e: PointerEvent): void => {
			const target = e.target as Node;
			const panel = panelRef.current;
			if (!panel || panel.contains(target)) return;
			if (toggleRef.current?.contains(target)) return;
			setOpen(false);
		};
		window.addEventListener("keydown", onKey);
		document.addEventListener("pointerdown", onPointerDown);
		return () => {
			window.removeEventListener("keydown", onKey);
			document.removeEventListener("pointerdown", onPointerDown);
		};
	}, [open]);

	const jump = (node: TurnNode): void => {
		// 切换节点优先(对齐 /tree):onNavigateTo 存在时行点击切换 leaf
		// 而非仅滚动;缺省回退纯滚动跳转。
		if (onNavigateTo) onNavigateTo(node.entry);
		else onJump(node.entry.timestamp);
		setOpen(false);
	};

	const renderNode = (node: TurnNode, depth: number): ReactNode => (
		<div key={node.entry.id}>
			<div
				className={`gui-mtree-row${currentIds.has(node.entry.id) ? " gui-mtree-row--current" : ""}`}
				style={{ paddingLeft: 8 + depth * 14 }}
			>
				<button type="button" className="gui-mtree-row-btn" onClick={() => jump(node)} title={node.entry.timestamp}>
					{node.kind === "user" ? (
						<Icon name="user" className="h-3 w-3 flex-shrink-0 gui-mtree-icon gui-mtree-icon--user" />
					) : node.kind === "toolResult" ? (
						<Icon name="hammer" className="h-3 w-3 flex-shrink-0 gui-mtree-icon gui-mtree-icon--tool" />
					) : (
						<Icon name="sparkling" className="h-3 w-3 flex-shrink-0 gui-mtree-icon gui-mtree-icon--agent" />
					)}
					<span className={`gui-mtree-text${node.kind === "toolResult" ? " gui-mtree-text--tool" : ""}`}>
						{node.text || "…"}
					</span>
				</button>
				{onRevertTo && node.kind === "user" && (
					<button
						type="button"
						className="gui-mtree-fork"
						title={t("revert message")}
						aria-label={t("revert message")}
						onClick={() => onRevertTo(node.entry)}
					>
						<Icon name="arrow-go-back" className="h-3 w-3" />
					</button>
				)}
				{onFork && (
					<button
						type="button"
						className="gui-mtree-fork"
						title={t("continue from this point in a new session")}
						aria-label={t("continue from this point in a new session")}
						onClick={() => {
							const isUser = node.kind === "user";
							onFork(node.entry, isUser ? rawUserText(node.entry) : undefined, !isUser);
						}}
					>
						<Icon name="git-fork" className="h-3 w-3" />
					</button>
				)}
			</div>
			{node.children.map(child => renderNode(child, depth + 1))}
		</div>
	);

	return (
		<>
			<button
				type="button"
				ref={toggleRef}
				className="gui-mtree-toggle"
				title={t("message tree")}
				aria-label={t("message tree")}
				aria-expanded={open}
				onClick={() => setOpen(v => !v)}
			>
				<Icon name="node-tree" className="h-4 w-4" />
			</button>
			{/* Always mounted so the enter/exit transitions play both ways;
			 * the open class drives them (visibility+pointer-events gate
			 * interaction and the a11y tree while closed). */}
			<div
				className={`gui-mtree-panel${open ? " gui-mtree-panel--open" : ""}`}
				ref={panelRef}
				role="dialog"
				aria-label={t("message tree")}
				aria-hidden={!open}
			>
				<div className="gui-mtree-search">
					<Icon name="search" className="h-3.5 w-3.5 flex-shrink-0" />
					<input
						ref={inputRef}
						value={q}
						onChange={e => setQ(e.target.value)}
						placeholder={t("search messages…")}
					/>
					<button type="button" className="gui-mtree-close" aria-label={t("close")} onClick={() => setOpen(false)}>
						<Icon name="close" className="h-3 w-3" />
					</button>
				</div>
				{/* TUI treeFilterMode 同款过滤(tuiOnly 设置 GUI 本地不读,默认 default) */}
				<div className="gui-mtree-filters" role="group" aria-label={t("message tree filter")}>
					{(["default", "no-tools", "user-only", "labeled-only", "all"] as const).map(mode => (
						<button
							key={mode}
							type="button"
							className={`gui-mtree-filter${filterMode === mode ? " gui-mtree-filter--active" : ""}`}
							onClick={() => setFilterMode(mode)}
						>
							{mode}
						</button>
					))}
				</div>
				<div className="gui-mtree-scroll">
					{filtered.length === 0 ? (
						<div className="gui-mtree-empty">{t("no matches")}</div>
					) : (
						filtered.map(node => renderNode(node, 0))
					)}
				</div>
			</div>
		</>
	);
}
