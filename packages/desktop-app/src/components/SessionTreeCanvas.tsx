import { t } from "@musepi/client-core";
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
 * 节点 = 内容卡片(角色/工具标题 + 两行摘要 + 相对时刻),边 = 父→子贝塞尔
 * 曲线;分层 = 深度(根 0),层内 x = 叶槽位中序分配(内部节点取首末子均值)
 * —— 树无环,无需交叉最小化。滚轮缩放(光标锚定)+ 背景拖拽平移 +
 * 右下 +/−/复位。节点:单击打开详情卡,双击/右键跳转 transcript,
 * 悬停 branchAt/forkAt 动作。
 *
 * 地图不折叠链段:每个条目都渲染成自己的卡片,长会话靠缩放/平移读
 * (「链段折叠」是线性 transcript 的压缩手段,不是地图的节点表示)。
 */

const NODE_W = 208;
/** 节点卡高度(px):标题行 + 两行摘要。高度固定才能让分层网格对齐,而宽度
 *  必须容下摘要的全宽——摘要曾与时刻/悬浮操作挤在同一行,被压成省略号,
 *  节点看起来就只是一条只有时刻的宽条。 */
const NODE_H = 76;
const GAP_X = 36;
const GAP_Y = 64;
/** 轮内垂直间距(px):同一轮(user→assistant→toolResult)的节点紧凑堆叠。 */
const GAP_Y_TURN = 12;
const FIT_PADDING = 28;
/** 大树自适应缩放的下限:宁可纵向超出一屏(可平移、可滚轮缩放),也不把
 *  卡片缩到字看不清——地图要读的就是卡片内容。 */
const MIN_FIT_SCALE = 0.75;
const MIN_SCALE = 0.1;
const MAX_SCALE = 2.2;

interface CanvasNode {
	node: MessageTreeNode;
	depth: number;
	x: number;
	y: number;
	/** 轮次(按 entries 顺序:每条 user 消息开新轮,assistant/toolResult 归当前轮)。
	 *  布局用它做"轮级分组"——同轮节点垂直紧凑堆叠,轮间大间距。 */
	turn: number;
}

/** 节点标题:消息按角色(词表),其余条目用自身 type(数据,不译)。 */
function nodeTitleOf(kind: "user" | "assistant" | "toolResult" | "other", entry: unknown): string {
	if (kind === "user") return t("trajectory user");
	if (kind === "assistant") return t("trajectory assistant");
	if (kind === "toolResult") return t("trajectory tool");
	const type = (entry as { type?: unknown } | null | undefined)?.type;
	return typeof type === "string" && type !== "" ? type : t("trajectory system");
}

/**
 * 分层布局:返回定位节点 + 画布尺寸。
 *
 * 布局 = 后序叶槽位分配(叶取新槽位,内部节点取首末子均值),叠加 y 重排:
 * 每节点 y = 父节点底部 + 同轮 12px / 轮间 64px——同一轮紧凑成簇,地图按轮
 * 阅读。每个节点都参与排布,没有隐藏节点。
 */
export function layoutTree(
	roots: readonly MessageTreeNode[],
	entries?: readonly unknown[],
): {
	nodes: CanvasNode[];
	width: number;
	height: number;
} {
	const nodes: CanvasNode[] = [];
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
			y: 0,
			turn: turnById.get(node.id) ?? 0,
		});
		return cx;
	};
	for (const root of roots) place(root, 0);
	// O(1) 查找表:长会话(220+ 节点)下按 id 找父子节点,线性扫描叠加成 O(n²)。
	const idToNode = new Map(nodes.map(n => [n.node.id, n]));
	// y 重排(关键):每节点 y = 父节点底部 + (同轮?轮内紧凑间距:轮间大间距)。
	// 注意:间距必须含 NODE_H(卡片不重叠)——同轮 12px 是"卡片间 12px 空隙",
	// 不是"起点差 12px"(后者重叠 64px,文字糊一起)。分支子节点从父的 y 继承
	// 推进;按树递归天然隔离多根,不用全局累计。
	const walk = (cn: CanvasNode, parentBottom: number | null, parentTurn: number): void => {
		const gap = parentBottom === null ? 0 : cn.turn === parentTurn ? GAP_Y_TURN : GAP_Y;
		cn.y = (parentBottom ?? 0) + gap;
		for (const child of cn.node.children) {
			const childNode = idToNode.get(child.id);
			if (childNode) walk(childNode, cn.y + NODE_H, cn.turn);
		}
	};
	for (const root of roots) {
		const rootNode = idToNode.get(root.id);
		if (rootNode) walk(rootNode, null, -1);
	}
	// 画布尺寸:由实际节点位置决定(所有节点都可见)。
	const maxY = nodes.reduce((acc, n) => Math.max(acc, n.y), 0);
	const width = Math.max(nextSlot, 1) * (NODE_W + GAP_X);
	const height = maxY + NODE_H + GAP_Y;
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
	focusRequest,
	activePathIds,
	onJump,
	onSwitch,
	onBranchTo,
	onForkAt,
}: {
	entries: readonly unknown[];
	/** 当前叶子(view key id;null = 尾部)。 */
	leafId?: string | null;
	/** External "focus this node" request (map-mode prompt rail): center the
	 *  viewport on the node and open its focus card — a NAVIGATION gesture, so
	 *  it must not touch the session leaf (branchAt belongs to the branch
	 *  switcher and the tree navigations, which intentionally move it). */
	focusRequest?: { id: string; nonce: number } | null;
	/** 活动路径 id 集;路径外节点淡显。 */
	activePathIds?: ReadonlySet<string>;
	/** 单击节点 = 聚焦详情卡片;双击/右键跳转 = 切换会话节点(对齐 /tree)。 */
	onJump(id: string): void;
	/** 双击/右键切换会话节点(同 /tree branchAt);缺省回退到 onJump(纯滚动)。 */
	onSwitch?(id: string): void;
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

	const { nodes, width, height } = useMemo(() => {
		const laid = layoutTree(roots, entries);
		let w = laid.width;
		let h = laid.height;
		for (const [id, p] of Object.entries(positions)) {
			if (!laid.nodes.some(n => n.node.id === id)) continue;
			w = Math.max(w, p.x + NODE_W + GAP_X);
			h = Math.max(h, p.y + NODE_H + GAP_Y);
		}
		return { nodes: laid.nodes, width: w, height: h };
	}, [roots, positions, entries]);

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
			// Whole map fits on an axis → center that axis. When an axis
			// OVERFLOWS, center on the CURRENT node instead of the root: this
			// branch used to snap to the root (the docstring above promised the
			// current node), so on a wide tree the highlighted node — often the
			// one in a bottom branch row — sat outside the viewport. The offset
			// is clamped so centering cannot scroll past the map edges.
			const focus =
				(currentNodeId != null ? nodes.find(n => n.node.id === currentNodeId) : undefined) ??
				nodes.find(n => n.depth === 0) ??
				null;
			const fx = (focus?.x ?? 0) + NODE_W / 2;
			const fy = (focus?.y ?? 0) + NODE_H / 2;
			const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));
			setView({
				scale: fullScale,
				x: scaledW > cw ? clamp(cw / 2 - fx * fullScale, cw - scaledW, 0) : (cw - scaledW) / 2,
				y: scaledH > ch ? clamp(ch / 2 - fy * fullScale, ch - scaledH, 0) : (ch - scaledH) / 2,
			});
			return;
		}
		// Huge tree: readable scale, centered on the current position. 纵向超出
		// 一屏就交给平移——按高度强行适配会把卡片缩成看不清的细条。宽度适配
		// (分支多到横向也放不下时)才真正压小,并保底 MIN_FIT_SCALE。
		const focus =
			(currentNodeId != null ? nodes.find(n => n.node.id === currentNodeId) : undefined) ??
			nodes.find(n => n.depth === 0) ??
			nodes[0] ??
			null;
		const fx = focus ? focus.x + NODE_W / 2 : width / 2;
		const fy = focus ? focus.y + NODE_H / 2 : height / 2;
		const widthFit = (cw - FIT_PADDING * 2) / width;
		const scale = Math.min(1, Math.max(MIN_FIT_SCALE, widthFit));
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

	// Follow EXTERNAL node switches. The leaf moves from outside this component
	// all the time — the branch bar, the prompt rail, a breadcrumb, the map
	// jump — and without this the map stayed put, so "navigate to that message"
	// changed the data and the transcript but moved nothing on screen. The
	// first observed leaf is the mount value (fitView already owned that
	// framing), so only later changes recenter.
	const followedLeafRef = useRef<string | null>(null);
	useEffect(() => {
		if (!leafId) return;
		const previous = followedLeafRef.current;
		followedLeafRef.current = leafId;
		if (previous === null || previous === leafId) return;
		if (!nodes.some(n => n.node.id === leafId)) return;
		centerOnNode(leafId);
	}, [leafId, nodes, centerOnNode]);

	// Prompt-rail focus (map mode): center on the requested node and open its
	// focus card. Deliberately NOT a branch change — the rail is a "take me
	// there" control, while moving the leaf belongs to the branch switcher and
	// the tree navigations (which branchAt on purpose).
	useEffect(() => {
		if (!focusRequest) return;
		if (!nodes.some(n => n.node.id === focusRequest.id)) return;
		setFocusClosing(false);
		setFocusedId(focusRequest.id);
		centerOnNode(focusRequest.id);
		// Keyed on the request nonce: a repeat click on the same row must
		// re-focus, and unrelated re-renders must not.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [focusRequest?.nonce]);

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

	const onWheel = useCallback((e: WheelEvent) => {
		// Native non-passive listener (so preventDefault can stop the page
		// scrolling behind the canvas).
		const wrap = wrapRef.current;
		if (!wrap) return;
		// Scrollable content INSIDE the canvas owns its wheel: the focused
		// node's card (long thinking text / tool output) and any overflowing
		// node body must scroll, not zoom the map. Walking the ancestors up to
		// the wrap means new scrollable surfaces are covered automatically.
		for (let el = e.target as HTMLElement | null; el && el !== wrap; el = el.parentElement) {
			const overflowY = getComputedStyle(el).overflowY;
			if (/(auto|scroll|overlay)/.test(overflowY) && el.scrollHeight > el.clientHeight + 1) return;
		}
		e.preventDefault();
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
			// 画布拖拽只在"空白处"启动——点在任何可交互元素(节点卡片、聚焦卡、
			// 缩放按钮、搜索框、右键菜单)上都不该平移画布,否则拖拽抢占 pointer
			// capture 会吞掉那些交互(用户: 进入聚焦了鼠标还是拖动,只有按 esc 能退出)。
			if (e.button !== 0) return;
			const target = e.target as HTMLElement;
			if (
				target.closest(".stc-node, .stc-focus-overlay, .stc-focus-card, .stc-zoom, .stc-search, .gui-context-menu")
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
			// onSwitch 优先:对齐 /tree 的 branchAt 切换节点语义;
			// 缺省回退到 onJump(纯滚动跳转)。
			(onSwitch ?? onJump)(nodeId);
		},
		[onJump, onSwitch],
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
		];
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [ctxMenu, onBranchTo, onForkAt, fitView, handleDblClick]);

	const focusedEntry = useMemo(() => {
		if (focusedId === null) return null;
		return entries.find(e => typeof e === "object" && e !== null && (e as { id?: unknown }).id === focusedId);
	}, [focusedId, entries]);

	// Esc 关闭聚焦卡 —— 并且必须 CLAIM 该按键(见 lib/escape-stop):未认领
	// 的 bare Esc 会穿透到窗口级的「中断回合」绑定,于是「按 Esc 关掉卡片」
	// 会把正在跑的回合一起打断(用户完全没打算停)。只在卡片开着时挂监听,
	// 免得卡片未开也去吞 Esc(那时它不拥有这个键)。
	useEffect(() => {
		if (focusedId === null && !focusClosing) return;
		const onKey = (e: KeyboardEvent): void => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			closeFocus();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [focusedId, focusClosing]);
	const focusedKind = useMemo(() => (focusedEntry ? treeKindOf(focusedEntry) : null), [focusedEntry]);

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
								aria-label={t("trajectory search previous")}
							>
								<Icon name="arrow-up-s" className="h-3 w-3" />
							</button>
							<button
								type="button"
								className="stc-search-nav-btn"
								disabled={searchCurrentIdx >= searchMatchArray.length - 1}
								onClick={() => scrollSearch(1)}
								aria-label={t("trajectory search next")}
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
						// 卡片 = 标题行(角色 · 工具名 + 判定徽标 + 时刻)+ 两行摘要;
						// 摘要单独占一行才能读——与时刻/悬浮操作挤在同一行时会被
						// 压成省略号,节点看起来只剩时刻。全文在详情卡(talk-map
						// 「卡片简历面」+ maze「确定性判定」的并集)。
						const toolName = kind === "toolResult" ? treeToolNameOf(n.node.entry) : null;
						const verdict = kind === "toolResult" ? treeVerdictOf(n.node.entry) : null;
						const summary = treeTextOf(n.node.entry);
						const title = `${nodeTitleOf(kind, n.node.entry)}${toolName ? ` · ${toolName}` : ""}`;
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
								onContextMenu={e => onNodeContextMenu(e, n.node.id)}
								title={summary}
							>
								<div className="stc-node-head">
									<Icon
										name={(TREE_ICON[kind] ?? "file-list-2") as Parameters<typeof Icon>[0]["name"]}
										className={`h-3 w-3 flex-shrink-0 gui-mtree-icon gui-mtree-icon--${kind}`}
									/>
									<span className="stc-node-title">{title}</span>
									{childCount > 1 && <span className="stc-node-badge">{childCount}</span>}
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
								</div>
								<div className="stc-node-text">{summary}</div>
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
