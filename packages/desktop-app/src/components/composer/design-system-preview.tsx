import { t } from "@musepi/client-core";
import type { CSSProperties, ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTwoPhaseEnter } from "../../lib/use-two-phase-enter";
import type { DesignSystemEntry } from "./use-design-systems";
import { designSystemLabel } from "./use-design-systems";

/**
 * 设计体系预览卡的共享渲染件（M3.7b §3.3）：DesignStyleSelect 浮动菜单
 * 的行 hover 浮卡与欢迎页预览 rail 的卡 hover 浮卡同一实现——色卡条
 * （swatches 前 4 色）+ 体系名 + description 全文 + 用 tokens 画的小型
 * mock（迷你卡片 + 按钮示意，§3.3「照设计稿表现」）。浮卡是 pointer
 * 陪衬（不给焦点、不接键盘），Escape/焦点契约归宿主菜单/页面。
 */

/** hover 浮卡宽（px）；定位与换边判定共用。 */
const PREVIEW_CARD_W = 232;
/** 浮卡估高（px）：top clamp 用——换边只看横向，纵向钳进视口。 */
const PREVIEW_CARD_EST_H = 210;
/** 浮卡与锚行/锚卡之间的缝隙（px）。 */
const PREVIEW_GAP = 8;
/** 视口边缘留白（px）。 */
const PREVIEW_EDGE_PAD = 8;

/** 色卡条：swatches 前 `count` 色等宽拼接（§3.3 卡面与浮卡共用）。 */
export function DesignSystemSwatchBar({
	entry,
	count = 4,
	className = "gui-ds-swatchbar",
}: {
	entry: Pick<DesignSystemEntry, "swatches">;
	count?: number;
	className?: string;
}): ReactNode {
	const colors = entry.swatches.slice(0, count);
	if (colors.length === 0) return null;
	return (
		<div className={className} aria-hidden="true">
			{colors.map(color => (
				<span key={color} style={{ background: color }} />
			))}
		</div>
	);
}

/**
 * tokens → 迷你 mock 的内联样式：底/文/圆角/描边取体系 token，缺项
 * 回落宿主 GUI token——离线兜底数据与扩展注册体系都能画出一个
 * 「像它」的小卡片（§3.3）。
 */
function miniSurfaceStyle(entry: DesignSystemEntry): CSSProperties {
	const tok = entry.tokens;
	return {
		background: tok["--bg"] ?? tok["--glass-bg"] ?? "var(--color-surface)",
		color: tok["--fg"] ?? "var(--color-text)",
		borderRadius: tok["--radius"] ?? tok["--radius-2xl"] ?? "6px",
		border: tok["--border"]?.startsWith("oklch") ? `1px solid ${tok["--border"]}` : undefined,
		fontFamily: tok["--font-ui"],
	};
}

/** 迷你 mock：一张小卡片衬底 + 两个假文行 + 一颗用点缀色（swatch[5]）
 *  的迷你按钮——浮卡里的「这个体系长这样」示意。 */
export function DesignSystemMiniMock({ entry }: { entry: DesignSystemEntry }): ReactNode {
	const accent = entry.swatches[5] ?? entry.swatches[0] ?? "var(--color-accent)";
	const fg = entry.tokens["--fg"] ?? "#fff";
	return (
		<div className="gui-ds-mock" style={miniSurfaceStyle(entry)} aria-hidden="true">
			<div className="gui-ds-mock-lines">
				<span style={{ background: "currentColor", opacity: 0.28 }} />
				<span style={{ background: "currentColor", opacity: 0.16, width: "62%" }} />
			</div>
			<span className="gui-ds-mock-btn" style={{ background: accent, color: fg, borderRadius: "inherit" }}>
				{t("design system preview cta")}
			</span>
		</div>
	);
}

/** 浮卡内容（不含浮层壳）：色卡条 + 名 + description 全文 + 迷你 mock。 */
export function DesignSystemPreviewCard({ entry }: { entry: DesignSystemEntry }): ReactNode {
	return (
		<div className="gui-ds-preview" data-design-system={entry.id}>
			<DesignSystemSwatchBar entry={entry} />
			<div className="gui-ds-preview-head">
				<span className="gui-ds-preview-name">{designSystemLabel(entry)}</span>
				<span className={`gui-ds-badge gui-ds-badge--${entry.source}`}>
					{entry.source === "builtin" ? t("design system builtin") : t("design system extension")}
				</span>
			</div>
			<p className="gui-ds-preview-desc">{entry.description}</p>
			<DesignSystemMiniMock entry={entry} />
		</div>
	);
}

/**
 * hover 浮卡壳：portal 到 React 根（浮层不被任何祖先 overflow/玻璃
 * 裁剪，useFloatingMenu 同款），贴锚元素右侧弹出；右空间不足自动换
 * 左侧（§3.3「空间不够自动换边」），纵向钳进视口。进出场复用
 * gui-menu-popup 的两段式（useTwoPhaseEnter 喂 `gui-menu-popup--entered`）：
 * opacity 0→1 一步翻转、transform 提供动量，gui-motion-off 下既有规则
 * 归零为即时出现（gui-design.md §5u）。
 */
export function DesignSystemHoverCard({
	entry,
	anchor,
}: {
	entry: DesignSystemEntry | null;
	/** 锚元素（菜单行 / rail 卡）的视口矩形；null = 不渲染。 */
	anchor: { left: number; right: number; top: number; bottom: number } | null;
}): ReactNode {
	const entered = useTwoPhaseEnter(anchor !== null && entry !== null, " gui-menu-popup--entered");
	if (!anchor || !entry) return null;
	const roomRight = window.innerWidth - anchor.right - PREVIEW_GAP - PREVIEW_EDGE_PAD;
	const flipLeft = roomRight < PREVIEW_CARD_W;
	const left = flipLeft
		? Math.max(PREVIEW_EDGE_PAD, anchor.left - PREVIEW_GAP - PREVIEW_CARD_W)
		: anchor.right + PREVIEW_GAP;
	const estTop = (anchor.top + anchor.bottom) / 2 - PREVIEW_CARD_EST_H / 2;
	const top = Math.min(
		Math.max(estTop, PREVIEW_EDGE_PAD),
		Math.max(PREVIEW_EDGE_PAD, window.innerHeight - PREVIEW_CARD_EST_H - PREVIEW_EDGE_PAD),
	);
	return createPortal(
		<div
			className={`gui-menu-popup gui-ds-hover${entered}`}
			style={{ position: "fixed", left, top, width: PREVIEW_CARD_W, zIndex: 4200 }}
			role="tooltip"
		>
			<DesignSystemPreviewCard entry={entry} />
		</div>,
		document.getElementById("root") ?? document.body,
	);
}
