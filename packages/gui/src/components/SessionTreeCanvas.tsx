import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../vendor/oc-icons";
import {
	buildMessageTree,
	TREE_ICON,
	treeKindOf,
	treeTextOf,
	type MessageTreeNode,
} from "../lib/message-tree";

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
		? (e.message.content as Array<{ type?: string; text?: string; name?: string; arguments?: unknown; thinking?: string }>)
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
	// 单击/双击消歧:单击 = 聚焦详情卡,双击 = 跳转 transcript。
	const singleClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [focusedId, setFocusedId] = useState<string | null>(null);
	// 搜索定位。
	const [searchQuery, setSearchQuery] = useState("");
	const [searchMatchIds, setSearchMatchIds] = useState<ReadonlySet<string>>(new Set());
	const [searchCurrentIdx, setSearchCurrentIdx] = useState(0);

	const { nodes, width, height } = useMemo(() => layoutTree(buildMessageTree(entries)), [entries]);

	// 首次有内容时适配视口(居中 + 缩放至可见)。
	const fittedFor = useRef("");
	useEffect(() => {
		const key = `${width}x${height}`;
		const wrap = wrapRef.current;
		if (!wrap || width === 0 || fittedFor.current === key) return;
		fittedFor.current = key;
		const scale = Math.min(
			MAX_SCALE,
			Math.max(MIN_SCALE, Math.min((wrap.clientWidth - FIT_PADDING * 2) / width, (wrap.clientHeight - FIT_PADDING * 2) / height, 1)),
		);
		const scaledW = width * scale;
		const scaledH = height * scale;
		const rootX = nodes.find(n => n.depth === 0)?.x ?? 0;
		setView({
			scale,
			// Whole map fits → center it; else center on the ROOT (the flow
			// start) so it's always in view and branches grow rightward —
			// centering an overflowing tree hides the root off-screen left.
			x:
				scaledW > wrap.clientWidth
					? wrap.clientWidth / 2 - (rootX + NODE_W / 2) * scale
					: (wrap.clientWidth - scaledW) / 2,
			y: scaledH > wrap.clientHeight ? FIT_PADDING : (wrap.clientHeight - scaledH) / 2,
		});
	}, [width, height]);

	const centerOnNode = useCallback(
		(nodeId: string, targetScale?: number): void => {
			const wrap = wrapRef.current;
			const n = nodes.find(m => m.node.id === nodeId);
			if (!wrap || !n) return;
			const scale = targetScale ?? Math.max(0.6, Math.min(1.2, wrap.clientWidth / (NODE_W + GAP_X * 2)));
			setView({
				scale,
				x: wrap.clientWidth / 2 - (n.x + NODE_W / 2) * scale,
				y: wrap.clientHeight / 2 - (n.y + NODE_H / 2) * scale,
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

	const onPointerDown = useCallback((e: React.PointerEvent) => {
		// 背景左键拖拽 = 平移;节点上的拖拽也平移(单击仍触发跳转,拖动超阈值则吞掉 click)。
		if (e.button !== 0) return;
		dragRef.current = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y, moved: false };
		setDragging(true);
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}, [view.x, view.y]);

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

	// 单击 = 聚焦详情;双击 = 跳转 transcript(220ms 消歧)。
	const handleClick = useCallback((nodeId: string) => {
		if (suppressClick.current) return;
		if (singleClickTimer.current !== null) clearTimeout(singleClickTimer.current);
		singleClickTimer.current = setTimeout(() => {
			setFocusedId(prev => (prev === nodeId ? null : nodeId));
		}, 220);
	}, []);

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
			if (e.key === "Escape") setFocusedId(null);
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
					{nodes.flatMap(n =>
						n.node.children.map(c => {
							const child = nodes.find(m => m.node.id === c.id);
							if (!child) return null;
							const x1 = n.x + NODE_W / 2;
							const y1 = n.y + NODE_H;
							const x2 = child.x + NODE_W / 2;
							// Leave room so the arrowhead lands at the child top edge.
							const y2 = child.y + 4;
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
						}),
					)}
	</svg>
					{nodes.map(n => {
						const kind = treeKindOf(n.node.entry);
						const isLeaf = leafId != null && n.node.id === leafId;
						const onPath = !activePathIds || activePathIds.has(n.node.id);
						const childCount = n.node.children.length;
						const searchMatch = hasSearch && searchMatchIds.has(n.node.id);
						const isSearchCurrent = hasSearch && searchMatchArray[searchCurrentIdx]?.node.id === n.node.id;
						const searchDim = hasSearch && !searchMatch;
						return (
							<div
								key={n.node.id}
								className={`stc-node stc-node--${kind}${isLeaf ? " stc-node--leaf" : ""}${onPath ? " stc-node--active" : " stc-node--off"}${searchMatch ? " stc-node--search-match" : ""}${isSearchCurrent ? " stc-node--search-current" : ""}${searchDim ? " stc-node--search-dim" : ""}`}
								style={{ left: n.x, top: n.y, width: NODE_W, height: NODE_H }}
								onClick={() => handleClick(n.node.id)}
								onDoubleClick={() => handleDblClick(n.node.id)}
								title={treeTextOf(n.node.entry)}
							>
								<Icon
									name={(TREE_ICON[kind] ?? "file-list-2") as Parameters<typeof Icon>[0]["name"]}
									className={`h-3 w-3 flex-shrink-0 gui-mtree-icon gui-mtree-icon--${kind}`}
								/>
								<span className="stc-node-text">{treeTextOf(n.node.entry)}</span>
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
			{focusedId !== null && focusedEntry ? (
				<div className="stc-focus-overlay" onClick={() => setFocusedId(null)}>
					<div className="stc-focus-card" onClick={e => e.stopPropagation()}>
						<div className="stc-focus-head">
							<Icon
								name={((focusedKind ? TREE_ICON[focusedKind] : undefined) ?? "file-list-2") as Parameters<typeof Icon>[0]["name"]}
								className={`h-3.5 w-3.5 flex-shrink-0 gui-mtree-icon gui-mtree-icon--${focusedKind ?? "other"}`}
							/>
							<span className="stc-focus-label">
								{focusedKind === "user"
									? t("trajectory user")
									: focusedKind === "assistant"
										? "ASSISTANT"
										: focusedKind === "toolResult"
											? "TOOL"
											: "SYSTEM"}
							</span>
							<button
								type="button"
								className="stc-focus-close"
								onClick={() => setFocusedId(null)}
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
						fittedFor.current = "";
						const wrap = wrapRef.current;
						if (!wrap) return;
						const scale = Math.min(
							MAX_SCALE,
							Math.max(MIN_SCALE, Math.min((wrap.clientWidth - FIT_PADDING * 2) / width, (wrap.clientHeight - FIT_PADDING * 2) / height, 1)),
						);
						setView({
							scale,
							x: (wrap.clientWidth - width * scale) / 2,
							y: (wrap.clientHeight - height * scale) / 2,
						});
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
