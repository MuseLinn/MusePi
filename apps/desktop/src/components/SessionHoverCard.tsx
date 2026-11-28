import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type ModeLabelEntry, resolveModeLabel } from "../lib/mode-label";
import { useTwoPhaseEnter } from "../lib/use-two-phase-enter";
import { Icon } from "../vendor/oc-icons";

/**
 * 会话悬浮卡：鼠标停在侧栏会话行上 ~350ms 后,在该行右侧浮出一张玻璃卡片,
 * 展示标题 / 模式 / 任务工作空间 / 最后活跃 / 创建时间。
 *
 * 表面、字号阶梯、行盒与入场来自 `gui-chrome.css` 的 hover-card 配方
 * （`.gui-hover-card`），本组件只决定会话内容怎么排。
 *
 * 数据分两半,由 bus 消息 + meta map 拼合:
 * - 行侧(SessionRow)只上报它手里有的展示字段(id/label/分叉来源/时间戳)
 *   和锚点矩形 — 不给 SessionRow 加任何 props,保住 memo 契约;
 * - 侧栏(sessionMeta map)持有 cwd/agentPreset,卡片渲染时按 id 现查。
 *
 * 卡片本体 portal 到 document.body:侧栏链路上有 backdrop-filter/transform,
 * fixed 定位会被最近的含 transform 祖先劫持,portal 出去才稳。
 */

/** 会话行的血缘字段(`session.tree` 行 / `session.list` 行的交集)。 */
export interface ForkProvenance {
	/** 会话级父 id。子代理与顾问 transcript 也带它——是磁盘产物目录的
	 *  父子关系,不是用户分叉。 */
	parentId?: string | null;
	/** `session.tree`/`session.list` 的 task/vibe 子代理标记。 */
	subagent?: boolean;
	/** 顾问 transcript 标记(`__advisor[.<slug>].jsonl`)。 */
	advisor?: boolean;
}

/**
 * 这一行是不是用户分叉出的新会话——侧栏分支标记与悬浮卡「分叉自」行的
 * 唯一判据。
 *
 * `parentId` 非空只说明"有父",三种行都满足:用户分叉(`session.forkAt`
 * 写入 header.parentSession)、子代理 transcript、顾问 transcript。后两者
 * 的父链接是产物归属(文件落在父会话目录下),它们已有自己的身份标记
 * (子代理名 chip / 顾问 chip),再挂分叉标记等于说"主会话的顾问是主会话
 * 的分叉"。只有真正由用户分叉出来的会话才画分支。
 *
 * 层级归属不受影响:`session.tree`/`SessionList` 仍按原始 `parentId` 挂
 * 子树,只有标记与文案改由本函数决定。
 */
export function isUserFork(entry: ForkProvenance): boolean {
	return Boolean(entry.parentId) && entry.subagent !== true && entry.advisor !== true;
}

export interface SessionHoverPayload {
	id: string;
	/** 行显示标题(已含"未命名会话"回落)。 */
	label: string;
	/** 这行是否由用户分叉而来——列表侧用 {@link isUserFork} 判定一次,行
	 *  标记与卡片「分叉自」行读同一份结论。 */
	forked: boolean;
	/** 分叉来源会话标题;父行缺席时为 null。 */
	parentLabel: string | null;
	timestamp: string;
	updatedAt?: string;
	/** 触发行的几何 — 卡片贴其右侧排布。 */
	anchor: DOMRect;
}

// 模块级单监听 bus:同一时刻只可能悬浮一行。行侧经这两个模块函数上报,
// 引用恒稳定,memo 不受影响;监听端是侧栏挂的唯一一张卡片。
let hoverListener: ((payload: SessionHoverPayload | null) => void) | null = null;

/** SessionRow mouseenter — 上报本行的悬浮数据(带锚点矩形)。 */
export function reportSessionHover(payload: SessionHoverPayload): void {
	hoverListener?.(payload);
}

/** SessionRow mouseleave / 点击 — 请求收卡。 */
export function clearSessionHover(): void {
	hoverListener?.(null);
}

/** 行上悬浮多久才出卡(避免扫过列表时卡片乱闪)。 */
const SHOW_DELAY_MS = 350;
/** 离行后的宽限期:跨行移动(mouseleave→下一行 mouseenter)不闪灭。 */
const HIDE_GRACE_MS = 120;
const CARD_WIDTH = 288;
/** 垂直夹取用的估算高度(真实高度随内容浮动,夹取只需防溢出)。 */
const CARD_EST_HEIGHT = 210;

function baseName(p: string): string {
	const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
	return parts[parts.length - 1] || p;
}

/** 完整时间戳(与 SessionList 行 tooltip 同一读法)。 */
function fullTime(ts: string): string {
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function SessionHoverCard({
	meta,
	modeCatalog,
}: {
	meta: Map<string, { cwd?: string; agentPreset?: string }>;
	/** modes.list catalog — 命名链尾段：用户创建的预设没有 `mode {id}` 词表
	 *  键，真名只在 catalog 里（与 ContextPanel 共用 lib/mode-label.ts）。 */
	modeCatalog?: readonly ModeLabelEntry[] | null;
}): ReactNode {
	const [hover, setHover] = useState<SessionHoverPayload | null>(null);
	// 两阶段入场（`useTwoPhaseEnter`，全仓浮层的同一形状）：卡片先以
	// opacity 0 挂载、合成毛玻璃背景，下一帧才翻 `--entered` 并只动
	// transform。见 gui-chrome.css 配方注释——在 backdrop-filter 上连续
	// 动画 opacity 会让真实屏幕合成器跳过 backdrop 采样。
	const enteredCls = useTwoPhaseEnter(hover !== null);
	const visibleRef = useRef(false);
	const showTimer = useRef<number | null>(null);
	const hideTimer = useRef<number | null>(null);

	// 接上 bus。可见中换行立即换内容(不再吃 350ms 延迟),离行走宽限。
	useEffect(() => {
		hoverListener = (payload: SessionHoverPayload | null) => {
			if (showTimer.current !== null) {
				window.clearTimeout(showTimer.current);
				showTimer.current = null;
			}
			if (hideTimer.current !== null) {
				window.clearTimeout(hideTimer.current);
				hideTimer.current = null;
			}
			if (payload === null) {
				if (!visibleRef.current) return;
				hideTimer.current = window.setTimeout(() => {
					hideTimer.current = null;
					visibleRef.current = false;
					setHover(null);
				}, HIDE_GRACE_MS);
				return;
			}
			if (visibleRef.current) {
				setHover(payload);
				return;
			}
			showTimer.current = window.setTimeout(() => {
				showTimer.current = null;
				visibleRef.current = true;
				setHover(payload);
			}, SHOW_DELAY_MS);
		};
		return () => {
			hoverListener = null;
			if (showTimer.current !== null) window.clearTimeout(showTimer.current);
			if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
		};
	}, []);

	// 滚动或改变窗口尺寸即收卡:锚点矩形随之失效,卡会钉在错误位置。scroll
	// 不冒泡,捕获阶段挂 window 才能覆盖侧栏内层滚动容器;resize 走同一段
	// 收卡逻辑（kimi-code 的 workspace 卡同样在 resize 时关闭）。
	useEffect(() => {
		const dismiss = (): void => {
			if (showTimer.current !== null) {
				window.clearTimeout(showTimer.current);
				showTimer.current = null;
			}
			if (hideTimer.current !== null) {
				window.clearTimeout(hideTimer.current);
				hideTimer.current = null;
			}
			if (!visibleRef.current) return;
			visibleRef.current = false;
			setHover(null);
		};
		window.addEventListener("scroll", dismiss, true);
		window.addEventListener("resize", dismiss);
		return () => {
			window.removeEventListener("scroll", dismiss, true);
			window.removeEventListener("resize", dismiss);
		};
	}, []);

	if (!hover) return null;
	const metaRow = meta.get(hover.id);
	const cwd = metaRow?.cwd?.trim() || null;
	const hasBothTimes = Boolean(hover.updatedAt && hover.updatedAt !== hover.timestamp);
	const forkParent = hover.forked ? hover.parentLabel : null;
	const modeLabel = resolveModeLabel(metaRow?.agentPreset, modeCatalog);
	const updatedAt = fullTime(hover.updatedAt ?? hover.timestamp);

	// 贴行右侧;右侧放不下换左侧;垂直方向夹进视口。
	const viewportW = window.innerWidth;
	const viewportH = window.innerHeight;
	const left =
		hover.anchor.right + 10 + CARD_WIDTH > viewportW
			? Math.max(8, hover.anchor.left - 10 - CARD_WIDTH)
			: hover.anchor.right + 10;
	const top = Math.min(Math.max(8, hover.anchor.top - 6), Math.max(8, viewportH - CARD_EST_HEIGHT));

	return createPortal(
		// 只读卡：内容与卡片本身都不接受指针（行没有 hover 底色，也没有可点的
		// 动作），悬停行才是交互面。
		<div
			className={`gui-hover-card gui-session-hover-card${enteredCls ? " gui-hover-card--entered" : ""}`}
			style={{ left, top }}
			role="tooltip"
		>
			<div className="gui-hover-card-title gui-session-hover-card-title" title={hover.label}>
				{hover.label}
			</div>
			{/* 元信息行：一个 chip（模式）+ 一个读数（更新于）。项目的元信息行
			 *  是「目录数 · 会话数」，两张卡同一种读法——先给一个可命名的身份，
			 *  再给一个时间，而不是把所有事实摊成等权的行。 */}
			<div className="gui-hover-card-meta">
				<span className="gui-hover-card-chip gui-session-hover-card-mode" title={modeLabel}>
					{modeLabel}
				</span>
				<span className="gui-hover-card-dot" aria-hidden="true" />
				<span className="gui-session-hover-card-when" title={updatedAt}>
					{t("settings.updated")} {updatedAt}
				</span>
			</div>
			<div className="gui-hover-card-rows">
				{forkParent && (
					<div className="gui-hover-card-row" title={forkParent}>
						<Icon name="git-branch" className="gui-hover-card-icon" />
						<span className="gui-hover-card-text">{t("general.forkedFromWithName", { name: forkParent })}</span>
					</div>
				)}
				{cwd && (
					<div className="gui-hover-card-row" title={cwd}>
						<Icon name="folder" className="gui-hover-card-icon" />
						<span className="gui-hover-card-label">{t("general.sessionWorkspace")}</span>
						<span className="gui-hover-card-text">{baseName(cwd)}</span>
					</div>
				)}
				{hasBothTimes && (
					<div className="gui-hover-card-row">
						<Icon name="history" className="gui-hover-card-icon gui-hover-card-icon--ghost" />
						<span className="gui-hover-card-label">{t("general.createdAt")}</span>
						<span className="gui-hover-card-text">{fullTime(hover.timestamp)}</span>
					</div>
				)}
			</div>
		</div>,
		document.body,
	);
}
