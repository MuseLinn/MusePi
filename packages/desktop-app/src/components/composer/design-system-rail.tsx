import { t } from "@musepi/client-core";
import type { MouseEvent, ReactNode } from "react";
import { useRef, useState } from "react";
import { Icon } from "../../vendor/oc-icons";
import { FadeScroll } from "../FadeScroll";
import { DesignSystemHoverCard, DesignSystemSwatchBar } from "./design-system-preview";
import { type DesignSystemEntry, designSystemLabel } from "./use-design-systems";

/**
 * 设计体系预览 rail（M3.7b §3.3）——欢迎页 design armed 时落在 composer
 * 下方：120×72 卡片横排（顶部色卡条 = swatches 前 4 色拼接 + 体系名 +
 * 内置/扩展徽章），横向滚动 + 左右边缘羽化（FadeScroll = client-core
 * useScrollShadow 的通用载体，与创作 chip 排同款）。选中 = accent 描边
 * + 右上角勾选角标（与 DesignStyleSelect 同源 state，调用方保证）；
 * 入场 stagger 每卡 60ms，gui-motion-off 归零；hover 卡面浮出预览卡
 * （§3.3「hover 浮卡给 description 全文」）。
 */

/** 卡 hover 浮卡的悬停桥接（ms），与菜单行同款。 */
const HOVER_LEAVE_MS = 120;

export function DesignSystemRail({
	systems,
	selected,
	onPick,
}: {
	systems: DesignSystemEntry[];
	selected: string | null;
	onPick(id: string | null): void;
}): ReactNode {
	const [hoverRect, setHoverRect] = useState<{
		id: string;
		left: number;
		right: number;
		top: number;
		bottom: number;
	} | null>(null);
	const leaveTimer = useRef(0);
	const hoverEntry = hoverRect ? (systems.find(s => s.id === hoverRect.id) ?? null) : null;
	const enterCard =
		(id: string) =>
		(e: MouseEvent<HTMLElement>): void => {
			window.clearTimeout(leaveTimer.current);
			const r = e.currentTarget.getBoundingClientRect();
			setHoverRect({ id, left: r.left, right: r.right, top: r.top, bottom: r.bottom });
		};
	const scheduleHide = (): void => {
		window.clearTimeout(leaveTimer.current);
		leaveTimer.current = window.setTimeout(() => setHoverRect(null), HOVER_LEAVE_MS);
	};
	return (
		<div className="gui-ds-rail" data-testid="gui-design-system-rail">
			<div className="gui-ds-rail-head">{t("design system rail title")}</div>
			<FadeScroll className="gui-ds-rail-scroll overflow-x-auto">
				<div className="gui-ds-rail-row" role="radiogroup" aria-label={t("design system rail title")}>
					{systems.map((s, i) => {
						const on = selected === s.id;
						return (
							<button
								key={s.id}
								type="button"
								role="radio"
								aria-checked={on}
								data-design-system={s.id}
								className={`gui-ds-card${on ? " gui-ds-card--on" : ""}`}
								style={{ animationDelay: `${i * 60}ms` }}
								onMouseEnter={enterCard(s.id)}
								onMouseLeave={scheduleHide}
								onClick={() => onPick(on ? null : s.id)}
							>
								<DesignSystemSwatchBar entry={s} className="gui-ds-swatchbar gui-ds-swatchbar--rail" />
								<span className="gui-ds-card-name">{designSystemLabel(s)}</span>
								<span className={`gui-ds-badge gui-ds-badge--${s.source}`}>
									{s.source === "builtin" ? t("design system builtin") : t("design system extension")}
								</span>
								{on && (
									<span className="gui-ds-card-check" aria-hidden="true">
										<Icon name="check" className="h-2.5 w-2.5" />
									</span>
								)}
							</button>
						);
					})}
				</div>
			</FadeScroll>
			<DesignSystemHoverCard entry={hoverEntry} anchor={hoverRect} />
		</div>
	);
}
