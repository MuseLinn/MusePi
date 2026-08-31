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
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

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
/** 轮内垂直间距(px):同一轮(user→assistant→toolResult)的节点紧凑堆叠。 */
const GAP_Y_TURN = 12;
const FIT_PADDING = 28;
const MIN_SCALE = 0.1;
const MAX_SCALE = 2.2;
/** 单子链折叠阈值:连续单子节点超过此深度,折叠成"链段胶囊"(点击展开)。
 *  长会话(220+ 消息)是纯单子链,不折叠会生成 22k px 高的竖线画布。 */
const CHAIN_FOLD_THRESHOLD = 24;
/** 折叠段胶囊的高度(px):比普通节点矮,标注省略的节点数。 */
const CHAIN_FOLD_H = 28;

interface CanvasNode {
	node: MessageTreeNode;
	depth: number;
	x: number;
	y: number;
	/** 轮次(按 entries 顺序:每条 user 消息开新轮,assistant/toolResult 归当前轮)。
	 *  布局用它做"轮级分组"——同轮节点垂直紧凑堆叠,轮间大间距。 */
	turn: number;
	/** 折叠链段:该节点是其所在链段的"段首"(胶囊),折叠了 [node, node+len) 的 len 个节点。 */
	foldLen?: number;
}

/** 折叠段:一段连续单子链被折叠成段首胶囊。 */
export interface ChainFold {
	/** 折叠段首节点的 id(渲染胶囊;点击展开)。 */
	headId: string;
	/** 折叠的节点 id 列表(不含段首),展开时恢复。 */
	hiddenIds: string[];
	/** 折叠段深度(段首节点深度)。 */
	depth: number;
	/** 折叠段在画布上的 y 坐标(px)。 */
	y: number;
}

/**
 * 分层布局:返回定位节点 + 画布尺寸 + 折叠链段。
 *
 * 布局 = 后序叶槽位分配(与之前相同),叠加"单子链折叠":遍历树时把
 * 超过 CHAIN_FOLD_THRESHOLD 的连续单子链标记为折叠段(段首胶囊 + 段内
 * 节点不占画布高度)。折叠段可点击展开(展开后重排),信息不丢。
 *
 * 折叠只作用于"无分支的纯链"——任何分支点都会打断链段,所以折叠不会
 * 隐藏分支结构,只是压缩长会话的纵向空白。
 */
export function layoutTree(
	roots: readonly MessageTreeNode[],
	entries?: readonly unknown[],
): {
	nodes: CanvasNode[];
	width: number;
	height: number;
	folds: ChainFold[];
} {
	const nodes: CanvasNode[] = [];
	const folds: ChainFold[] = [];
	let nextSlot = 0;
	// 轮次表:按 entries 顺序,每条 user 消息开新轮(turn+1),assistant/
	// toolResult 归当前轮。地图"轮级分组"用——同轮节点垂直紧凑堆叠。
	// 无 entries(纯结构调用)时全部归 turn 0(退化为无分组)。
	const turnById = new Map<string, number>();
	if (entries) {
		let turn = 0;
		for (const raw of entries) {
			if (!raw || typeof raw !== "object") continue;
			const e = raw as { id?: unknown; type?: unknown; message?: { role?: unknown } };
			if (typeof e.id !== "string" || e.type !== "message") continue;
			const role = e.message?.role;
			if (role === "user") turn += 1;
			turnById.set(e.id, turn);
		}
	}
	// 后序:叶取新槽位,内部节点取首末子均值(紧凑无重叠)。
	const place = (node: MessageTreeNode, depth: number): number => {
		let cx: number;
		if (node.children.length === 0) {
			cx = nextSlot++;
		} else {
			const childXs = node.children.map(c => place(c, depth + 1));
			cx = (childXs[0]! + childXs[childXs.length - 1]!) / 2;
		}
		nodes.push({
			node,
			depth,
			x: cx * (NODE_W + GAP_X),
			y: depth * (NODE_H + GAP_Y),
			turn: turnById.get(node.id) ?? 0,
		});
		return cx;
	};
	for (const root of roots) place(root, 0);
	// 折叠链段检测:找连续单子链(每个节点唯一父 + 唯一子),从链顶向下
	// 把超过阈值的部分切成段。任何分支点打断链段——折叠不隐藏分支,
	// 只压缩长链纵向空白。
	//
	// nodes 是后序(叶在前、根在后),遍历按深度降序;每个折叠段只处理一次
	// (段首设 foldLen,段内节点通过 foldLen 检查跳过)。
	const chainTopOf = (n: CanvasNode): CanvasNode => {
		// 向上回溯到链顶(首个"唯一父 + 唯一子"断链处)。
		let cur: CanvasNode = n;
		while (true) {
			const parent = nodes.find(m => m.node.children.some(c => c.id === cur.node.id));
			const parentSingle = parent && parent.node.children.length === 1;
			const selfSingle = cur.node.children.length === 1;
			if (!parentSingle || !selfSingle) break; // 链在此结束
			cur = parent!;
		}
		return cur;
	};
	for (const n of nodes) {
		// 只从"链顶"开始折叠:自身是单子节点,且父不是单子(父不存在 =
		// 根;父多子 = 分支点) → 一段新链的起点。
		if (n.foldLen !== undefined) continue;
		const parent = nodes.find(m => m.node.children.some(c => c.id === n.node.id));
		const parentSingle = parent !== undefined && parent.node.children.length === 1;
		const selfSingle = n.node.children.length === 1;
		const isChainTop = selfSingle && !parentSingle;
		if (!isChainTop) continue;
		// 收集整条链(从链顶向下)。
		const seg: CanvasNode[] = [];
		let cur: CanvasNode | undefined = n;
		while (cur && cur.node.children.length === 1) {
			seg.push(cur);
			cur = nodes.find(m => m.node.id === cur!.node.children[0]!.id);
		}
		// 切段:链上超过阈值的部分,每段段首 depth >= 阈值。
		// 段从"第一个 depth >= 阈值的节点"开始,每段最多 CHAIN_FOLD_THRESHOLD 个。
		const startIdx = seg.findIndex(m => m.depth >= CHAIN_FOLD_THRESHOLD);
		if (startIdx === -1) continue;
		for (let s = startIdx; s < seg.length; s += CHAIN_FOLD_THRESHOLD) {
			const head = seg[s]!;
			const hidden = seg.slice(s + 1, s + CHAIN_FOLD_THRESHOLD);
			if (hidden.length === 0) continue; // 段尾不足一段,不折叠
			head.foldLen = hidden.length + 1;
			const headY = head.y;
			folds.push({
				headId: head.node.id,
				hiddenIds: hidden.map(h => h.node.id),
				depth: head.depth,
				y: headY,
			});
			// 段内节点标记已处理(后序数组里它们在前,设置 foldLen 防止
			// 它们作为链顶被再次处理——虽然段内节点不满足 isChainTop,
			// 但保险起见显式标记)。
			for (const h of hidden) h.foldLen = hidden.length + 1;
		}
	}
	// y 重排(关键):折叠段内节点被胶囊替代后,后续节点的 y 必须上移。
	// 每节点 y = 父节点 y + (同轮?轮内紧凑间距:轮间大间距)——同一轮
	// (user→assistant→toolResult)的节点垂直紧凑堆叠成簇,轮间拉开,
	// 地图按"轮"阅读(用户: 应该以每一轮的 User/ASSISTANT 堆叠)。
	// 分支子节点从父的 y 继承推进;全局 hiddenBefore 累计对多根是错的,
	// 这里按树递归天然隔离。
	{
		const hiddenSet = new Set<string>();
		for (const f of folds) for (const h of f.hiddenIds) hiddenSet.add(h);
		const idToNode = new Map(nodes.map(n => [n.node.id, n]));
		const walk = (node: MessageTreeNode, parentY: number | null, parentTurn: number): void => {
			const cn = idToNode.get(node.id)!;
			// 隐藏节点:不占位置,其子从父的 y 继承(跳过它)。
			if (hiddenSet.has(node.id)) {
				for (const child of node.children) walk(child, parentY, cn.turn);
				return;
			}
			const gap = parentY === null ? 0 : cn.turn === parentTurn ? GAP_Y_TURN : GAP_Y;
			cn.y = (parentY ?? 0) + gap;
			for (const child of node.children) walk(child, cn.y, cn.turn);
		};
		for (const root of roots) walk(root, null, -1);
	}
	// 第二遍:段内节点堆叠到"重排后的段首"下方(段首已重排)。
	for (const n of nodes) {
		const foldFor = folds.find(f => f.hiddenIds.includes(n.node.id));
		if (!foldFor) continue;
		const headNode = nodes.find(m => m.node.id === foldFor.headId);
		if (headNode) n.y = headNode.y + CHAIN_FOLD_H;
	}
	// 画布高度:由重排后的实际节点位置决定(折叠段内节点渲染时隐藏,
	// 不计入)。不能用 `maxDepth - totalHidden` 公式——多分支/多折叠段
	// 场景下不同链的隐藏数不同,全局相减会算错(段首 y 超过 height 被裁剪)。
	const visibleMaxY = nodes.reduce((acc, n) => {
		if (folds.some(f => f.hiddenIds.includes(n.node.id))) return acc;
		return Math.max(acc, n.y);
	}, 0);
	const width = Math.max(nextSlot, 1) * (NODE_W + GAP_X);
	const height = visibleMaxY + NODE_H + GAP_Y;
	return { nodes, width, height, folds };
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
	const singleClickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const [focusedId, setFocusedId] = useState<string | null>(null);
	// focusedId 的 ref 镜像:handleClick 的 220ms 消歧 timer 读最新值,
	// 避免闭包捕获旧 focusedId(点 A 开卡 → 点 B 时 timer 仍拿 A,误判)。
	const focusedIdRef = useRef<string | null>(null);
	useEffect(() => {
		focusedIdRef.current = focusedId;
	}, [focusedId]);
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
	// 折叠链段展开/收起:展开后该段节点参与布局与交互,收起回到胶囊。
	const toggleFold = useCallback((headId: string): void => {
		setExpandedFolds(prev => {
			const next = new Set(prev);
			if (next.has(headId)) next.delete(headId);
			else next.add(headId);
			return next;
		});
	}, []);
	// 右键菜单:节点 → 跳转/重答/分叉;空白 → 重置视图/折叠全部链段。
	const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; nodeId: string | null } | null>(null);
	const closeCtxMenu = useCallback((): void => setCtxMenu(null), []);
	const onNodeContextMenu = useCallback((e: React.MouseEvent, nodeId: string): void => {
		e.preventDefault();
		e.stopPropagation();
		setCtxMenu({ x: e.clientX, y: e.clientY, nodeId });
	}, []);
	const onBlankContextMenu = useCallback((e: React.MouseEvent): void => {
		e.preventDefault();
		setCtxMenu({ x: e.clientX, y: e.clientY, nodeId: null });
	}, []);
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

	// 折叠链段的展开状态:key = fold.headId;展开后该段节点重新布局并显示。
	// 折叠是"视觉压缩"——展开/收起只影响画布,不丢消息(与 Transcript 窗口化
	// 同哲学:折叠是渲染层,数据全量)。初始全部折叠(长会话默认可读)。
	const [expandedFolds, setExpandedFolds] = useState<ReadonlySet<string>>(new Set());

	const { nodes, width, height, folds } = useMemo(() => {
		const laid = layoutTree(roots, entries);
		let w = laid.width;
		let h = laid.height;
		for (const [id, p] of Object.entries(positions)) {
			if (!laid.nodes.some(n => n.node.id === id)) continue;
			w = Math.max(w, p.x + NODE_W + GAP_X);
			h = Math.max(h, p.y + NODE_H + GAP_Y);
		}
		return { nodes: laid.nodes, width: w, height: h, folds: laid.folds };
	}, [roots, positions]);
	// 折叠段内节点:折叠时隐藏(不渲染);展开时显示。段首胶囊始终渲染。
	const hiddenNodeIds = useMemo(() => {
		const hidden = new Set<string>();
		for (const f of folds) {
			if (expandedFolds.has(f.headId)) continue;
			for (const id of f.hiddenIds) hidden.add(id);
		}
		return hidden;
	}, [folds, expandedFolds]);
	// 折叠段内节点不参与交互定位(点击/搜索/跳转跳过它们)。
	const interactiveNodes = useMemo(() => nodes.filter(n => !hiddenNodeIds.has(n.node.id)), [nodes, hiddenNodeIds]);
	// 有效节点坐标 = 自由摆位覆盖 ?? 自动布局(render 用;回调走 positionsRef
	// 以免把 positions 拖进 centerOnNode/fitView 依赖,引起拖拽中反复重建)。
	const posOf = (n: CanvasNode): { x: number; y: number } => positions[n.node.id] ?? { x: n.x, y: n.y };

	// 当前位置节点:显式 leaf(回看历史时)或活动路径的最深节点(尾部跟随
	// 时 leafId 为 null,不标记会让地图失去"我在哪"的锚点)。声明在 fitView
	// 之前 — 智能适配以它为焦点。
	const currentNodeId = useMemo(() => {
		// 显式 leaf:若 leaf 是折叠段内节点(不可见),回退到它的段首胶囊——
		// 否则"回到当前位置"定位到隐藏节点,看起来没效果(用户: 似乎没有任何效果)。
		if (leafId != null) {
			if (nodes.some(n => n.node.id === leafId && !hiddenNodeIds.has(leafId))) return leafId;
			const fold = folds.find(f => f.hiddenIds.includes(leafId));
			if (fold) return fold.headId;
			if (nodes.some(n => n.node.id === leafId)) return leafId;
		}
		let deepest: CanvasNode | undefined;
		for (const n of nodes) {
			// 折叠段内节点不可见,不参与"我在哪"定位(否则回到当前位置会
			// 定到隐藏节点上)。
			if (hiddenNodeIds.has(n.node.id)) continue;
			if (activePathIds && !activePathIds.has(n.node.id)) continue;
			if (!deepest || n.depth > deepest.depth || (n.depth === deepest.depth && n.x > deepest.x)) deepest = n;
		}
		return deepest?.node.id ?? null;
	}, [leafId, activePathIds, nodes, hiddenNodeIds, folds]);

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
		// 用能放下整棵树的缩放(至少 0.5,不至于小到不可读)——折叠后画布
		// 矮很多,fullScale 会明显变大,固定 0.7 反而浪费。
		const focus =
			(currentNodeId != null ? nodes.find(n => n.node.id === currentNodeId) : undefined) ??
			nodes.find(n => n.depth === 0) ??
			nodes[0] ??
			null;
		const fx = focus ? focus.x + NODE_W / 2 : width / 2;
		const fy = focus ? focus.y + NODE_H / 2 : height / 2;
		const fitScale = Math.max(0.5, Math.min((cw - FIT_PADDING * 2) / width, (ch - FIT_PADDING * 2) / height));
		const scale = Math.min(1, fitScale);
		setView({ scale, x: cw / 2 - fx * scale, y: ch / 2 - fy * scale });
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
		// 只搜可见节点(折叠段内节点不参与定位——搜到也看不见,白跳)。
		return interactiveNodes.filter(n => treeTextOf(n.node.entry).toLowerCase().includes(q));
	}, [searchQuery, interactiveNodes]);

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

	const onWheel = useCallback((e: WheelEvent) => {
		// 原生非 passive 监听(preventDefault 才生效,阻止画布下方页面滚动)。
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
	// React 的 onWheel 在 root 上注册为 passive(preventDefault 无效并报
	// "Unable to preventDefault inside passive event listener"),所以滚轮
	// 缩放必须走原生 addEventListener({ passive: false })。effect 挂在
	// wrap 上,卸载时移除。
	useEffect(() => {
		const wrap = wrapRef.current;
		if (!wrap) return;
		wrap.addEventListener("wheel", onWheel, { passive: false });
		return () => wrap.removeEventListener("wheel", onWheel);
	}, [onWheel]);

	const onPointerDown = useCallback(
		(e: React.PointerEvent) => {
			// 画布拖拽只在"空白处"启动——点在任何可交互元素(节点卡片、
			// 折叠胶囊、聚焦卡、缩放按钮、搜索框、右键菜单)上都不该平移
			// 画布,否则拖拽抢占 pointer capture 会吞掉那些交互(用户:
			// 进入聚焦了鼠标还是拖动,只有按 esc 能退出)。
			if (e.button !== 0) return;
			const target = e.target as HTMLElement;
			if (
				target.closest(
					".stc-node, .stc-fold, .stc-focus-overlay, .stc-focus-card, .stc-zoom, .stc-search, .gui-context-menu",
				)
			) {
				return;
			}
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
		if (Math.abs(dx) + Math.abs(dy) > 6) d.moved = true;
		setView(v => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
	}, []);

	const suppressClick = useRef(false);
	const onPointerUp = useCallback(() => {
		suppressClick.current = dragRef.current?.moved ?? false;
		dragRef.current = null;
		setDragging(false);
	}, []);

	// 节点自由拖拽(空间记忆):节点上按下 = 记录起点(不立即 capture——
	// 单击打开聚焦卡不应抢占指针,否则聚焦后鼠标移动还在拖节点);
	// 超过阈值确认拖动后才 capture + 平移,松手 16px 网格吸附 + 持久化。
	const onNodePointerDown = useCallback(
		(e: React.PointerEvent, nodeId: string): void => {
			if (e.button !== 0) return;
			const n = nodes.find(m => m.node.id === nodeId);
			if (!n) return;
			e.stopPropagation();
			const p = positionsRef.current[nodeId] ?? { x: n.x, y: n.y };
			nodeDragRef.current = { id: nodeId, px: e.clientX, py: e.clientY, ox: p.x, oy: p.y, moved: false };
		},
		[nodes],
	);

	const onNodePointerMove = useCallback((e: React.PointerEvent): void => {
		const d = nodeDragRef.current;
		if (!d) return;
		const dx = e.clientX - d.px;
		const dy = e.clientY - d.py;
		// 超过阈值才算拖动:此刻才 capture 指针(单击不 capture,聚焦卡/其他
		// 交互不被拖拽抢占)。
		if (!d.moved && Math.abs(dx) + Math.abs(dy) > 6) {
			d.moved = true;
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		}
		if (!d.moved) return;
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
	const handleClick = useCallback((nodeId: string) => {
		// 拖拽吞掉的 click 只吞一次,消费后复位——否则拖过一次节点后
		// 所有点击永久被吞(聚焦卡点了关不掉)。
		const suppressed = suppressClick.current;
		suppressClick.current = false;
		if (suppressed) return;
		clearTimeout(singleClickTimer.current);
		singleClickTimer.current = setTimeout(() => {
			singleClickTimer.current = undefined;
			// 读 ref 而非闭包 focusedId:连续点不同节点时,比较的是"当前
			// 打开的卡"而非 timer 创建时捕获的旧值。
			if (focusedIdRef.current === nodeId) closeFocus();
			else openFocus(nodeId);
		}, 220);
	}, []);

	const handleDblClick = useCallback(
		(nodeId: string) => {
			// 拖动移动卡片后不触发双击跳转(拖动已设 suppressClick)。
			const suppressed = suppressClick.current;
			suppressClick.current = false;
			if (suppressed) return;
			clearTimeout(singleClickTimer.current);
			singleClickTimer.current = undefined;
			// 双击跳转:立即卸载聚焦卡(不等退场动画,跳转是即时导航)。
			setFocusClosing(false);
			setFocusedId(null);
			onJump(nodeId);
		},
		[onJump],
	);

	// 右键菜单项:节点 → 跳转/重答/分叉;空白 → 视图控制。定义在
	// handleDblClick/fitView 之后(它们被引用)。description 说明动作
	// 的具体效果(右键菜单动词简短,描述消除歧义)。
	const ctxItems = useMemo<ContextMenuItem[]>(() => {
		if (!ctxMenu) return [];
		if (ctxMenu.nodeId !== null) {
			const items: ContextMenuItem[] = [
				{
					label: t("trajectory jump"),
					description: t("context jump desc"),
					icon: "arrow-go-forward",
					onSelect: () => handleDblClick(ctxMenu.nodeId!),
				},
			];
			if (onBranchTo) {
				items.push({
					label: t("branch re-answer here"),
					description: t("context branch desc"),
					icon: "git-branch",
					onSelect: () => onBranchTo(ctxMenu.nodeId!),
				});
			}
			if (onForkAt) {
				items.push({
					label: t("fork session here"),
					description: t("context fork desc"),
					icon: "git-fork",
					onSelect: () => onForkAt(ctxMenu.nodeId!),
				});
			}
			return items;
		}
		// 空白处右键:视图控制。
		return [
			{
				label: t("canvas reset view"),
				description: t("context reset desc"),
				icon: "align-justify",
				onSelect: () => {
					needsFitRef.current = true;
					fitView();
				},
			},
			{
				label: t("collapse all chains"),
				description: t("context collapse desc"),
				icon: "arrow-up-s",
				onSelect: () => setExpandedFolds(new Set()),
			},
		];
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ctxMenu, onBranchTo, onForkAt, fitView, handleDblClick]);

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
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
			onContextMenu={onBlankContextMenu}
			data-dragging={dragging || undefined}
		>
			{/* 搜索定位条 */}
			<div
				className="stc-search"
				role="search"
				onClick={e => e.stopPropagation()}
				onPointerDown={e => e.stopPropagation()}
			>
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
							// 折叠段内节点不画边(它们的进出边由段首胶囊接管)。
							if (hiddenNodeIds.has(n.node.id)) return [];
							const p = posOf(n);
							return n.node.children.map(c => {
								const child = nodes.find(m => m.node.id === c.id);
								if (!child) return null;
								// 子节点在折叠段内:边画到胶囊下沿即可(箭头指向折叠段)。
								const childHidden = hiddenNodeIds.has(child.node.id);
								const pc = childHidden ? posOf(n) : posOf(child);
								const x1 = p.x + NODE_W / 2;
								const y1 = p.y + NODE_H;
								const x2 = pc.x + NODE_W / 2;
								const y2 = childHidden ? pc.y + CHAIN_FOLD_H : pc.y + 4;
								const my = (y1 + y2) / 2;
								const onPath = !activePathIds || (activePathIds.has(n.node.id) && activePathIds.has(c.id));
								return (
									<path
										key={`${n.node.id}-${c.id}`}
										className={`stc-edge${onPath ? "" : " stc-edge--off"}${childHidden ? " stc-edge--fold" : ""}`}
										markerEnd={onPath ? "url(#stc-arrow)" : undefined}
										d={`M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`}
									/>
								);
							});
						})}
					</svg>
					{nodes.map(n => {
						// 折叠段内节点:折叠时完全隐藏(不渲染)。
						if (hiddenNodeIds.has(n.node.id)) return null;
						const fold = folds.find(f => f.headId === n.node.id);
						const isFoldHead = fold !== undefined;
						const foldExpanded = isFoldHead && expandedFolds.has(n.node.id);
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
						// 折叠段首:胶囊样式 + 折叠计数 + 点击展开/收起。
						if (isFoldHead) {
							const hiddenCount = fold!.hiddenIds.length;
							return (
								<div
									key={n.node.id}
									className={`stc-fold${foldExpanded ? " stc-fold--open" : ""}${onPath ? " stc-fold--active" : " stc-fold--off"}`}
									style={{ left: p.x, top: p.y, width: NODE_W, height: CHAIN_FOLD_H }}
									onClick={e => {
										e.stopPropagation();
										toggleFold(n.node.id);
									}}
									title={
										foldExpanded
											? t("collapse chain segment")
											: t("expand chain segment", { count: hiddenCount })
									}
									role="button"
									tabIndex={0}
									onKeyDown={e => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault();
											toggleFold(n.node.id);
										}
									}}
								>
									<Icon
										name={foldExpanded ? "arrow-up-s" : "arrow-down-s"}
										className="h-3 w-3 flex-shrink-0"
									/>
									<span className="stc-fold-text">
										{foldExpanded ? t("chain expanded") : t("chain collapsed", { count: hiddenCount })}
									</span>
								</div>
							);
						}
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
								onContextMenu={e => onNodeContextMenu(e, n.node.id)}
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
										<button
											type="button"
											className="stc-node-action"
											title={t("trajectory jump")}
											aria-label={t("trajectory jump")}
											onPointerDown={e => e.stopPropagation()}
											onClick={e => {
												e.stopPropagation();
												handleDblClick(n.node.id);
											}}
										>
											<Icon name="arrow-go-forward" className="h-3 w-3" />
										</button>
										{onBranchTo && (
											<button
												type="button"
												className="stc-node-action"
												title={t("branch re-answer here")}
												aria-label={t("branch re-answer here")}
												onPointerDown={e => e.stopPropagation()}
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
												onPointerDown={e => e.stopPropagation()}
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
					onPointerDown={e => e.stopPropagation()}
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
			<div className="stc-zoom" onPointerDown={e => e.stopPropagation()}>
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

			{/* 右键菜单(节点操作 / 空白视图控制)。 */}
			{ctxMenu && <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxItems} open onClose={closeCtxMenu} />}
		</div>
	);
}
