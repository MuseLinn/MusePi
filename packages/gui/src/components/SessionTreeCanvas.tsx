import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	buildMessageTree,
	type MessageTreeNode,
	TREE_ICON,
	treeKindOf,
	treeTextOf,
	treeToolNameOf,
	treeVerdictOf,
} from "../lib/message-tree";
import { Icon } from "../vendor/oc-icons";

/**
 * 第三层:会话树地图画布(dagre 式分层布局的零依赖手写版)。
 * 节点 = 消息卡片(kind 图标 + 预览),边 = 父→子贝塞尔曲线;
 * 分层 = 深度(根 0),层内 x = 叶槽位中序分配(内部节点取首末子均值)
 * —— 树无环,无需交叉最小化。滚轮缩放(光标锚定)+ 背景拖拽平移 +
 * 右下 +/−/复位。节点:单击跳转 transcript,悬停 branchAt/forkAt 动作。
 */

const NODE_W = 168;
const NODE_H = 40;
const GAP_X = 36;
const GAP_Y = 64;
const FIT_PADDING = 28;
const MIN_SCALE = 0.1;
const MAX_SCALE = 2.2;

interface CanvasNode {
	node: MessageTreeNode;
	depth: number;
	x: number;
	y: number;
}

/** 分层布局:返回定位节点 + 画布尺寸。 */
function layoutTree(roots: readonly MessageTreeNode[]): { nodes: CanvasNode[]; width: number; height: number } {
	const nodes: CanvasNode[] = [];
	let nextSlot = 0;
	let maxDepth = 0;
	// 后序:叶取新槽位,内部节点取首末子均值(紧凑无重叠)。
	const place = (node: MessageTreeNode, depth: number): number => {
		maxDepth = Math.max(maxDepth, depth);
		let cx: number;
		if (node.children.length === 0) {
			cx = nextSlot++;
		} else {
			const childXs = node.children.map(c => place(c, depth + 1));
			cx = (childXs[0]! + childXs[childXs.length - 1]!) / 2;
		}
		nodes.push({ node, depth, x: cx * (NODE_W + GAP_X), y: depth * (NODE_H + GAP_Y) });
		return cx;
	};
	for (const root of roots) place(root, 0);
	const width = Math.max(nextSlot, 1) * (NODE_W + GAP_X);
	const height = (maxDepth + 1) * (NODE_H + GAP_Y);
	return { nodes, width, height };
}

/** 聚焦卡片的完整消息内容(文本/思考/工具调用拼接)。 */
function entryTextOf(entry: unknown): string {
	if (!entry || typeof entry !== "object") return "";
	const e = entry as { type?: string; message?: { role?: string; content?: unknown } };
	if (e.type !== "message" || !e.message) return "…";
	const parts = Array.isArray(e.message.content)
		? (e.message.content as Array<{
				type?: string;
				text?: string;
				name?: string;
				arguments?: unknown;
				thinking?: string;
			}>)
		: [];
	const texts: string[] = [];
	for (const p of parts) {
		if (p?.type === "text" && p.text) texts.push(p.text);
		else if (p?.type === "thinking" && p.thinking) texts.push(`💭 ${p.thinking}`);
		else if (p?.type === "toolCall" && p.name) {
			texts.push(`🔧 ${p.name}(${JSON.stringify(p.arguments) ?? ""})`);
		}
	}
	return texts.join("\n") || "…";
}

/** 自由摆位网格对齐粒度(dsh-talk-map 16px grid snap parity)。 */
const GRID_SNAP = 16;

/** Spatial-memory store: [nodeId → {x,y}] 自由摆位覆盖,按会话根 id 分键。
 *  布局是投影,删掉这份存储只丢排列、不丢消息树(synapse/talk-map 的
 *  「永不重排我的卡片」边界)。 */
const CANVAS_POS_PREFIX = "musepi.canvas.";
type CanvasPositions = Record<string, { x: number; y: number }>;

function loadPositions(sessionKey: string): CanvasPositions {
	try {
		const raw = localStorage.getItem(`${CANVAS_POS_PREFIX}${sessionKey}`);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as CanvasPositions;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function savePositions(sessionKey: string, positions: CanvasPositions): void {
	try {
		localStorage.setItem(`${CANVAS_POS_PREFIX}${sessionKey}`, JSON.stringify(positions));
	} catch {
		// Quota / storage disabled — spatial memory degrades to in-session only.
	}
}

export function SessionTreeCanvas({
	entries,
	leafId,
	activePathIds,
	onJump,
	onBranchTo,
	onForkAt,
}: {
	entries: readonly unknown[];
	/** 当前叶子(view key id;null = 尾部)。 */
	leafId?: string | null;
	/** 活动路径 id 集;路径外节点淡显。 */
	activePathIds?: ReadonlySet<string>;
	/** 单击节点 = 跳转 transcript。 */
	onJump(id: string): void;
	onBranchTo?(id: string): void;
	onForkAt?(id: string): void;
}): ReactNode {
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
	// 拖拽平移锚点(null = 未拖拽)。
	const dragRef = useRef<{ px: number; py: number; vx: number; vy: number; moved: boolean } | null>(null);
	const [dragging, setDragging] = useState(false);
	// 节点自由拖拽锚点(null = 未拖节点;ox/oy = 起拖时的有效坐标)。
	const nodeDragRef = useRef<{ id: string; px: number; py: number; ox: number; oy: number; moved: boolean } | null>(
		null,
	);
	// 单击/双击消歧:单击 = 聚焦详情卡,双击 = 跳转 transcript。
	const singleClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [focusedId, setFocusedId] = useState<string | null>(null);
	// 聚焦详情卡显隐:closeFocus 只播退场,动画结束才真卸载(--closing 语义,
	// 与 DialogFrame/Pop 一致)。
	const [focusClosing, setFocusClosing] = useState(false);
	const closeFocus = (): void => setFocusClosing(true);
	const openFocus = (nodeId: string): void => {
		setFocusClosing(false);
		setFocusedId(nodeId);
	};
	const finishFocusClose = (): void => {
		setFocusClosing(false);
		setFocusedId(null);
	};
	// 搜索定位。
	const [searchQuery, setSearchQuery] = useState("");
	const [searchMatchIds, setSearchMatchIds] = useState<ReadonlySet<string>>(new Set());
	const [searchCurrentIdx, setSearchCurrentIdx] = useState(0);

	// 会话根 id 作 spatial-memory 存储键(会话内稳定,重载可复用);自由摆位
	// 覆盖放在自动布局之上,删掉存储即回到自动布局。
	const roots = useMemo(() => buildMessageTree(entries), [entries]);
	const sessionKey = roots[0]?.id ?? "";
	const [positions, setPositions] = useState<CanvasPositions>(() => (sessionKey ? loadPositions(sessionKey) : {}));
	const positionsRef = useRef<CanvasPositions>(positions);
	useEffect(() => {
		positionsRef.current = positions;
	}, [positions]);
	// 切会话(entries 变化)→ 重载该会话的摆位。
	useEffect(() => {
		setPositions(sessionKey ? loadPositions(sessionKey) : {});
	}, [sessionKey]);

	const { nodes, width, height } = useMemo(() => {
		const laid = layoutTree(roots);
		let w = laid.width;
		let h = laid.height;
		for (const [id, p] of Object.entries(positions)) {
			if (!laid.nodes.some(n => n.node.id === id)) continue;
			w = Math.max(w, p.x + NODE_W + GAP_X);
			h = Math.max(h, p.y + NODE_H + GAP_Y);
		}
		return { nodes: laid.nodes, width: w, height: h };
	}, [roots, positions]);
	// 有效节点坐标 = 自由摆位覆盖 ?? 自动布局(render 用;回调走 positionsRef
	// 以免把 positions 拖进 centerOnNode/fitView 依赖,引起拖拽中反复重建)。
	const posOf = (n: CanvasNode): { x: number; y: number } => positions[n.node.id] ?? { x: n.x, y: n.y };

	// 当前位置节点:显式 leaf(回看历史时)或活动路径的最深节点(尾部跟随
	// 时 leafId 为 null,不标记会让地图失去"我在哪"的锚点)。声明在 fitView
	// 之前 — 智能适配以它为焦点。
	const currentNodeId = useMemo(() => {
		if (leafId != null && nodes.some(n => n.node.id === leafId)) return leafId;
		let deepest: CanvasNode | undefined;
		for (const n of nodes) {
			if (activePathIds && !activePathIds.has(n.node.id)) continue;
			if (!deepest || n.depth > deepest.depth || (n.depth === deepest.depth && n.x > deepest.x)) deepest = n;
		}
		return deepest?.node.id ?? null;
	}, [leafId, activePathIds, nodes]);

	// Fit-to-viewport: runs once per canvas mount (the component only renders
	// in canvas view mode) and re-runs when the wrap leaves a degenerate size
	// (pane animating open → the old width×height latch computed the fit once
	// against a 0px wrap and never re-ran: nodes landed off-view in a corner,
	// user: 地图视图显示的内容不合适). Trees too big to full-fit center on the
	// CURRENT node instead — "where am I" beats showing the root of a chain
	// the user scrolled far past. Pan/zoom afterwards is untouched; the reset
	// button re-runs the same smart fit.
	const needsFitRef = useRef(true);
	const fitView = useCallback((): void => {
		const wrap = wrapRef.current;
		if (!wrap || width === 0 || height === 0) return;
		const cw = wrap.clientWidth;
		const ch = wrap.clientHeight;
		if (cw < 80 || ch < 80) return;
		needsFitRef.current = false;
		const fullScale = Math.min((cw - FIT_PADDING * 2) / width, (ch - FIT_PADDING * 2) / height, 1);
		if (fullScale >= 0.55) {
			const scaledW = width * fullScale;
			const scaledH = height * fullScale;
			const rootX = nodes.find(n => n.depth === 0)?.x ?? 0;
			setView({
				scale: fullScale,
				// Whole map fits → center it; else center on the ROOT (the flow
				// start) so it's always in view and branches grow rightward.
				x: scaledW > cw ? cw / 2 - (rootX + NODE_W / 2) * fullScale : (cw - scaledW) / 2,
				y: scaledH > ch ? FIT_PADDING : (ch - scaledH) / 2,
			});
			return;
		}
		// Huge tree: readable scale, centered on the current position.
		const focus =
			(currentNodeId != null ? nodes.find(n => n.node.id === currentNodeId) : undefined) ??
			nodes.find(n => n.depth === 0) ??
			nodes[0] ??
			null;
		const fx = focus ? focus.x + NODE_W / 2 : width / 2;
		const fy = focus ? focus.y + NODE_H / 2 : height / 2;
		setView({ scale: 0.7, x: cw / 2 - fx * 0.7, y: ch / 2 - fy * 0.7 });
	}, [width, height, nodes, currentNodeId]);
	useEffect(() => {
		const wrap = wrapRef.current;
		if (!wrap) return;
		const ro = new ResizeObserver(() => {
			if (needsFitRef.current) fitView();
		});
		ro.observe(wrap);
		if (needsFitRef.current) fitView();
		return () => ro.disconnect();
	}, [fitView]);

	const centerOnNode = useCallback(
		(nodeId: string, targetScale?: number): void => {
			const wrap = wrapRef.current;
			const n = nodes.find(m => m.node.id === nodeId);
			if (!wrap || !n) return;
			const p = positionsRef.current[nodeId] ?? { x: n.x, y: n.y };
			const scale = targetScale ?? Math.max(0.6, Math.min(1.2, wrap.clientWidth / (NODE_W + GAP_X * 2)));
			setView({
				scale,
				x: wrap.clientWidth / 2 - (p.x + NODE_W / 2) * scale,
				y: wrap.clientHeight / 2 - (p.y + NODE_H / 2) * scale,
			});
		},
		[nodes],
	);

	// 搜索匹配集 + 首个匹配定位。
	const searchMatchArray = useMemo(() => {
		if (!searchQuery.trim()) return [] as CanvasNode[];
		const q = searchQuery.toLowerCase();
		return nodes.filter(n => treeTextOf(n.node.entry).toLowerCase().includes(q));
	}, [searchQuery, nodes]);

	useEffect(() => {
		setSearchMatchIds(new Set(searchMatchArray.map(n => n.node.id)));
		setSearchCurrentIdx(0);
		if (searchMatchArray.length > 0) centerOnNode(searchMatchArray[0]!.node.id, 1.2);
	}, [searchMatchArray, centerOnNode]);

	const scrollSearch = useCallback(
		(dir: 1 | -1): void => {
			const idx = searchCurrentIdx + dir;
			if (idx < 0 || idx >= searchMatchArray.length) return;
			setSearchCurrentIdx(idx);
			centerOnNode(searchMatchArray[idx]!.node.id, 1.2);
		},
		[searchCurrentIdx, searchMatchArray, centerOnNode],
	);

	const onWheel = useCallback((e: React.WheelEvent) => {
		e.preventDefault();
		const wrap = wrapRef.current;
		if (!wrap) return;
		const rect = wrap.getBoundingClientRect();
		const mx = e.clientX - rect.left;
		const my = e.clientY - rect.top;
		setView(v => {
			const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
			const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
			const k = scale / v.scale;
			return { scale, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k };
		});
	}, []);

	const onPointerDown = useCallback(
		(e: React.PointerEvent) => {
			// 背景左键拖拽 = 平移;节点上的拖拽也平移(单击仍触发跳转,拖动超阈值则吞掉 click)。
			if (e.button !== 0) return;
			dragRef.current = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y, moved: false };
			setDragging(true);
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		},
		[view.x, view.y],
	);

	const onPointerMove = useCallback((e: React.PointerEvent) => {
		const d = dragRef.current;
		if (!d) return;
		const dx = e.clientX - d.px;
		const dy = e.clientY - d.py;
		if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
		setView(v => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
	}, []);

	const suppressClick = useRef(false);
	const onPointerUp = useCallback(() => {
		suppressClick.current = dragRef.current?.moved ?? false;
		dragRef.current = null;
		setDragging(false);
	}, []);

	// 节点自由拖拽(空间记忆):节点上按下 = 拖节点(阻断背景平移),拖动
	// 超阈值即吞掉后续 click(避免拖完又触发聚焦),松手 16px 网格吸附 + 持久化。
	const onNodePointerDown = useCallback(
		(e: React.PointerEvent, nodeId: string): void => {
			if (e.button !== 0) return;
			const n = nodes.find(m => m.node.id === nodeId);
			if (!n) return;
			e.stopPropagation();
			const p = positionsRef.current[nodeId] ?? { x: n.x, y: n.y };
			nodeDragRef.current = { id: nodeId, px: e.clientX, py: e.clientY, ox: p.x, oy: p.y, moved: false };
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		},
		[nodes],
	);

	const onNodePointerMove = useCallback((e: React.PointerEvent): void => {
		const d = nodeDragRef.current;
		if (!d) return;
		const dx = e.clientX - d.px;
		const dy = e.clientY - d.py;
		if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
		const next = { ...positionsRef.current, [d.id]: { x: d.ox + dx, y: d.oy + dy } };
		positionsRef.current = next;
		setPositions(next);
	}, []);

	const onNodePointerUp = useCallback((): void => {
		const d = nodeDragRef.current;
		if (!d) return;
		nodeDragRef.current = null;
		const p = positionsRef.current[d.id];
		if (d.moved && p) {
			suppressClick.current = true;
			const snapped = { x: Math.round(p.x / GRID_SNAP) * GRID_SNAP, y: Math.round(p.y / GRID_SNAP) * GRID_SNAP };
			const next = { ...positionsRef.current, [d.id]: snapped };
			positionsRef.current = next;
			setPositions(next);
			if (sessionKey) savePositions(sessionKey, next);
		}
	}, [sessionKey]);

	// 单击 = 聚焦详情;双击 = 跳转 transcript(220ms 消歧)。
	const handleClick = useCallback(
		(nodeId: string) => {
			if (suppressClick.current) return;
			if (singleClickTimer.current !== null) clearTimeout(singleClickTimer.current);
			singleClickTimer.current = setTimeout(() => {
				if (focusedId === nodeId) closeFocus();
				else openFocus(nodeId);
			}, 220);
		},
		[focusedId],
	);

	const handleDblClick = useCallback(
		(nodeId: string) => {
			if (singleClickTimer.current !== null) {
				clearTimeout(singleClickTimer.current);
				singleClickTimer.current = null;
			}
			suppressClick.current = true;
			setFocusedId(null);
			onJump(nodeId);
		},
		[onJump],
	);

	const focusedEntry = useMemo(() => {
		if (focusedId === null) return null;
		return entries.find(e => typeof e === "object" && e !== null && (e as { id?: unknown }).id === focusedId);
	}, [focusedId, entries]);

	const focusedKind = useMemo(() => (focusedEntry ? treeKindOf(focusedEntry) : null), [focusedEntry]);

	// Esc 关闭聚焦卡。
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") closeFocus();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const hasSearch = searchQuery.trim().length > 0;

	return (
		<div
			ref={wrapRef}
			className="stc-wrap"
			onWheel={onWheel}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
			data-dragging={dragging || undefined}
		>
			{/* 搜索定位条 */}
			<div className="stc-search" role="search" onClick={e => e.stopPropagation()}>
				<Icon name="search" className="h-3 w-3 shrink-0 text-[var(--color-text-muted)]" />
				<input
					className="stc-search-input"
					type="text"
					placeholder={t("trajectory search placeholder")}
					value={searchQuery}
					onChange={e => setSearchQuery(e.target.value)}
					onKeyDown={e => {
						if (e.key === "Enter") scrollSearch(1);
						else if (e.key === "ArrowUp") {
							e.preventDefault();
							scrollSearch(-1);
						} else if (e.key === "ArrowDown") {
							e.preventDefault();
							scrollSearch(1);
						}
					}}
				/>
				{searchMatchArray.length > 0 && (
					<>
						<span className="stc-search-count">
							{searchCurrentIdx + 1}/{searchMatchArray.length}
						</span>
						<span className="stc-search-nav">
							<button
								type="button"
								className="stc-search-nav-btn"
								disabled={searchCurrentIdx <= 0}
								onClick={() => scrollSearch(-1)}
								aria-label={t("trajectory clear filter")}
							>
								<Icon name="arrow-up-s" className="h-3 w-3" />
							</button>
							<button
								type="button"
								className="stc-search-nav-btn"
								disabled={searchCurrentIdx >= searchMatchArray.length - 1}
								onClick={() => scrollSearch(1)}
								aria-label={t("trajectory clear filter")}
							>
								<Icon name="arrow-down-s" className="h-3 w-3" />
							</button>
						</span>
					</>
				)}
			</div>

			{nodes.length === 0 ? (
				<p className="stc-empty">{t("trajectory empty")}</p>
			) : (
				<div
					className="stc-world"
					style={{
						width,
						height,
						transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
					}}
				>
					<svg className="stc-edges" width={width} height={height}>
						<defs>
							<marker
								id="stc-arrow"
								viewBox="0 0 10 10"
								refX="9"
								refY="5"
								markerWidth="7"
								markerHeight="7"
								orient="auto-start-reverse"
							>
								<path d="M 0 0 L 10 5 L 0 10 z" className="stc-arrow-head" />
							</marker>
						</defs>
						{nodes.flatMap(n => {
							const p = posOf(n);
							return n.node.children.map(c => {
								const child = nodes.find(m => m.node.id === c.id);
								if (!child) return null;
								const pc = posOf(child);
								const x1 = p.x + NODE_W / 2;
								const y1 = p.y + NODE_H;
								const x2 = pc.x + NODE_W / 2;
								// Leave room so the arrowhead lands at the child top edge.
								const y2 = pc.y + 4;
								const my = (y1 + y2) / 2;
								const onPath = !activePathIds || (activePathIds.has(n.node.id) && activePathIds.has(c.id));
								return (
									<path
										key={`${n.node.id}-${c.id}`}
										className={`stc-edge${onPath ? "" : " stc-edge--off"}`}
										markerEnd={onPath ? "url(#stc-arrow)" : undefined}
										d={`M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`}
									/>
								);
							});
						})}
					</svg>
					{nodes.map(n => {
						const kind = treeKindOf(n.node.entry);
						const p = posOf(n);
						const isLeaf = leafId != null && n.node.id === leafId;
						const isCurrent = currentNodeId === n.node.id;
						const onPath = !activePathIds || activePathIds.has(n.node.id);
						const childCount = n.node.children.length;
						const searchMatch = hasSearch && searchMatchIds.has(n.node.id);
						const isSearchCurrent = hasSearch && searchMatchArray[searchCurrentIdx]?.node.id === n.node.id;
						const searchDim = hasSearch && !searchMatch;
						// 工具结果节点:工名作主标签 + 判定徽标(✓/✗/·),结果全文在详情
						// 卡(talk-map「卡片简历面」+ maze「确定性判定」的并集);其余节
						// 点沿用文本预览。相对时刻统一右缀(HH:MM:SS)。
						const toolName = kind === "toolResult" ? treeToolNameOf(n.node.entry) : null;
						const verdict = kind === "toolResult" ? treeVerdictOf(n.node.entry) : null;
						const label = kind === "toolResult" ? (toolName ?? "tool") : treeTextOf(n.node.entry);
						const clockText = n.node.timestamp
							? new Date(n.node.timestamp).toLocaleTimeString(undefined, { hour12: false })
							: "";
						return (
							<div
								key={n.node.id}
								className={`stc-node stc-node--${kind}${isLeaf ? " stc-node--leaf" : ""}${isCurrent ? " stc-node--current" : ""}${onPath ? " stc-node--active" : " stc-node--off"}${searchMatch ? " stc-node--search-match" : ""}${isSearchCurrent ? " stc-node--search-current" : ""}${searchDim ? " stc-node--search-dim" : ""}`}
								style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
								onPointerDown={e => onNodePointerDown(e, n.node.id)}
								onPointerMove={onNodePointerMove}
								onPointerUp={onNodePointerUp}
								onClick={() => handleClick(n.node.id)}
								onDoubleClick={() => handleDblClick(n.node.id)}
								title={treeTextOf(n.node.entry)}
							>
								<Icon
									name={(TREE_ICON[kind] ?? "file-list-2") as Parameters<typeof Icon>[0]["name"]}
									className={`h-3 w-3 flex-shrink-0 gui-mtree-icon gui-mtree-icon--${kind}`}
								/>
								<span className="stc-node-text">{label}</span>
								{verdict && (
									<span className={`stc-node-verdict stc-node-verdict--${verdict}`} aria-hidden="true">
										{verdict === "error" ? "✗" : verdict === "empty" ? "·" : "✓"}
									</span>
								)}
								{clockText && <span className="stc-node-clock">{clockText}</span>}
								{(onBranchTo || onForkAt) && (
									<span className="traj-trow-actions">
										{onBranchTo && (
											<button
												type="button"
												className="stc-node-action"
												title={t("branch re-answer here")}
												aria-label={t("branch re-answer here")}
												onClick={e => {
													e.stopPropagation();
													onBranchTo(n.node.id);
												}}
											>
												<Icon name="git-branch" className="h-3 w-3" />
											</button>
										)}
										{onForkAt && (
											<button
												type="button"
												className="stc-node-action"
												title={t("fork session here")}
												aria-label={t("fork session here")}
												onClick={e => {
													e.stopPropagation();
													onForkAt(n.node.id);
												}}
											>
												<Icon name="git-fork" className="h-3 w-3" />
											</button>
										)}
									</span>
								)}
								{childCount > 1 && <span className="stc-node-badge">{childCount}</span>}
							</div>
						);
					})}
				</div>
			)}
			{/* 聚焦详情卡(单击节点):focusedEntry 是 unknown(entries.find),
			 * 必须显式判空——`focusedEntry &&` 会把整个表达式推成 unknown。 */}
			{focusClosing || (focusedId !== null && focusedEntry) ? (
				<div
					className={`stc-focus-overlay${focusClosing ? " stc-focus-overlay--closing" : ""}`}
					onClick={closeFocus}
					onAnimationEnd={() => {
						if (focusClosing) finishFocusClose();
					}}
				>
					<div className="stc-focus-card" onClick={e => e.stopPropagation()}>
						<div className="stc-focus-head">
							<Icon
								name={
									((focusedKind ? TREE_ICON[focusedKind] : undefined) ?? "file-list-2") as Parameters<
										typeof Icon
									>[0]["name"]
								}
								className={`h-3.5 w-3.5 flex-shrink-0 gui-mtree-icon gui-mtree-icon--${focusedKind ?? "other"}`}
							/>
							<span className="stc-focus-label">
								{focusedKind === "user"
									? t("trajectory user")
									: focusedKind === "assistant"
										? t("trajectory assistant")
										: focusedKind === "toolResult"
											? t("trajectory tool")
											: t("trajectory system")}
							</span>
							<button
								type="button"
								className="stc-focus-close"
								onClick={closeFocus}
								aria-label={t("trajectory close")}
							>
								<Icon name="close" className="h-3 w-3" />
							</button>
						</div>
						<div className="stc-focus-body">{entryTextOf(focusedEntry) || "…"}</div>
					</div>
				</div>
			) : null}

			{/* 右下缩放控件(滚轮之外的精确入口)。 */}
			<div className="stc-zoom">
				<button
					type="button"
					className="stc-zoom-btn"
					title={t("locate current")}
					aria-label={t("locate current")}
					disabled={currentNodeId === null}
					onClick={() => currentNodeId && centerOnNode(currentNodeId)}
				>
					<Icon name="target" className="h-3 w-3" />
				</button>
				<button
					type="button"
					className="stc-zoom-btn"
					title={t("canvas zoom in")}
					aria-label={t("canvas zoom in")}
					onClick={() =>
						setView(v => {
							const scale = Math.min(MAX_SCALE, v.scale * 1.2);
							const k = scale / v.scale;
							const wrap = wrapRef.current;
							const cx = (wrap?.clientWidth ?? 0) / 2;
							const cy = (wrap?.clientHeight ?? 0) / 2;
							return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
						})
					}
				>
					<Icon name="add" className="h-3 w-3" />
				</button>
				<button
					type="button"
					className="stc-zoom-btn"
					title={t("canvas reset view")}
					aria-label={t("canvas reset view")}
					onClick={() => {
						needsFitRef.current = true;
						fitView();
					}}
				>
					<Icon name="align-justify" className="h-3 w-3" />
				</button>
				<button
					type="button"
					className="stc-zoom-btn"
					title={t("canvas zoom out")}
					aria-label={t("canvas zoom out")}
					onClick={() =>
						setView(v => {
							const scale = Math.max(MIN_SCALE, v.scale / 1.2);
							const k = scale / v.scale;
							const wrap = wrapRef.current;
							const cx = (wrap?.clientWidth ?? 0) / 2;
							const cy = (wrap?.clientHeight ?? 0) / 2;
							return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
						})
					}
				>
					<Icon name="subtract" className="h-3 w-3" />
				</button>
			</div>
		</div>
	);
}
