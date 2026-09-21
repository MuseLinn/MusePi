import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { type ModeLabelEntry, resolveModeLabel } from "../lib/mode-label";
import { Icon } from "../vendor/oc-icons";

/**
 * 会话悬浮卡（WorkBuddy 悬浮弹窗 parity + 我们的 mode 行）：鼠标停在侧栏
 * 会话行上 ~350ms 后,在该行右侧浮出一张玻璃卡片,展示标题 / 会话预设 /
 * 任务工作空间 / 最后活跃 / 创建时间。
 *
 * 数据分两半,由 bus 消息 + meta map 拼合:
 * - 行侧(SessionRow)只上报它手里有的展示字段(id/label/fork 来源/时间戳)
 *   和锚点矩形 — 不给 SessionRow 加任何 props,保住 memo 契约;
 * - 侧栏(sessionMeta map)持有 cwd/modeId,卡片渲染时按 id 现查。
 *
 * 卡片本体 portal 到 document.body:侧栏链路上有 backdrop-filter/transform,
 * fixed 定位会被最近的含 transform 祖先劫持,portal 出去才稳。
 */
export interface SessionHoverPayload {
	id: string;
	/** 行显示标题(已含"未命名会话"回落)。 */
	label: string;
	/** fork 来源会话标题,null = 非 fork。 */
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
	meta: Map<string, { cwd?: string; modeId?: string }>;
	/** modes.list catalog — 命名链尾段：用户创建的预设没有 `mode {id}` 词表
	 *  键，真名只在 catalog 里（与 ContextPanel 共用 lib/mode-label.ts）。 */
	modeCatalog?: readonly ModeLabelEntry[] | null;
}): ReactNode {
	const [hover, setHover] = useState<SessionHoverPayload | null>(null);
	const [entered, setEntered] = useState(false);
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
					setEntered(false);
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

	// 双阶段入场(.gui-menu-popup 同款):先以 opacity 0 合成毛玻璃背景,
	// 下一帧再翻 opacity — backdrop-filter 元素上动画 opacity 会退化成
	// 普通半透明(frosted 闪变),所以入场动画只动 transform。
	useEffect(() => {
		if (!hover) return;
		const raf = requestAnimationFrame(() => setEntered(true));
		return () => cancelAnimationFrame(raf);
	}, [hover]);

	// 滚动即收卡:锚点矩形随滚动失效,卡会钉在错误位置。scroll 不冒泡,
	// 捕获阶段挂 window 才能覆盖侧栏内层滚动容器。
	useEffect(() => {
		const onScroll = (): void => {
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
			setEntered(false);
			setHover(null);
		};
		window.addEventListener("scroll", onScroll, true);
		return () => window.removeEventListener("scroll", onScroll, true);
	}, []);

	if (!hover) return null;
	const metaRow = meta.get(hover.id);
	const cwd = metaRow?.cwd?.trim() || null;
	const hasBothTimes = Boolean(hover.updatedAt && hover.updatedAt !== hover.timestamp);

	// 贴行右侧;右侧放不下换左侧;垂直方向夹进视口。
	const viewportW = window.innerWidth;
	const viewportH = window.innerHeight;
	const left =
		hover.anchor.right + 10 + CARD_WIDTH > viewportW
			? Math.max(8, hover.anchor.left - 10 - CARD_WIDTH)
			: hover.anchor.right + 10;
	const top = Math.min(Math.max(8, hover.anchor.top - 6), Math.max(8, viewportH - CARD_EST_HEIGHT));

	return createPortal(
		<div
			className={`gui-session-hover-card${entered ? " gui-session-hover-card--entered" : ""}`}
			style={{ left, top }}
			role="tooltip"
		>
			<div className="gui-session-hover-card-title" title={hover.label}>
				{hover.label}
			</div>
			{hover.parentLabel && (
				<div className="gui-session-hover-card-row" title={hover.parentLabel}>
					<Icon name="git-branch" className="gui-session-hover-card-icon" />
					<span className="gui-session-hover-card-text">
						{t("forked from {name}", { name: hover.parentLabel })}
					</span>
				</div>
			)}
			<div className="gui-session-hover-card-row gui-session-hover-card-mode">
				<Icon name="stack" className="gui-session-hover-card-icon" />
				<span className="gui-session-hover-card-text">{resolveModeLabel(metaRow?.modeId, modeCatalog)}</span>
			</div>
			{cwd && (
				<div className="gui-session-hover-card-row" title={cwd}>
					<Icon name="folder" className="gui-session-hover-card-icon" />
					<span className="gui-session-hover-card-label">{t("session workspace")}</span>
					<span className="gui-session-hover-card-text">{baseName(cwd)}</span>
				</div>
			)}
			<div className="gui-session-hover-card-row">
				<Icon name="history" className="gui-session-hover-card-icon" />
				<span className="gui-session-hover-card-label">{t("updated")}</span>
				<span className="gui-session-hover-card-text">{fullTime(hover.updatedAt ?? hover.timestamp)}</span>
			</div>
			{hasBothTimes && (
				<div className="gui-session-hover-card-row">
					<Icon name="history" className="gui-session-hover-card-icon gui-session-hover-card-icon--ghost" />
					<span className="gui-session-hover-card-label">{t("created at")}</span>
					<span className="gui-session-hover-card-text">{fullTime(hover.timestamp)}</span>
				</div>
			)}
		</div>,
		document.body,
	);
}
