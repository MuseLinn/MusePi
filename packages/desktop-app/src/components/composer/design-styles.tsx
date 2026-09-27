import { t } from "@musepi/client-core";
import { type MouseEvent, type ReactNode, useRef, useState } from "react";
import { useFloatingMenu } from "../../lib/use-floating-menu";
import { Icon } from "../../vendor/oc-icons";
import { DesignSystemHoverCard, DesignSystemSwatchBar } from "./design-system-preview";
import { type DesignSystemEntry, designSystemLabel } from "./use-design-systems";

/**
 * Design style picker — 会话 composer（Composer.tsx footerLeft）与欢迎页
 * （WelcomeComposer，design 预设 armed 时）共用的同一颗选择胶囊。
 *
 * M3.7b（docs/review/0.5.0-m3-mode-page-redesign.md §3）：数据源是
 * `design.systems.list` RPC（useDesignSystems，调用方传入；RPC 不可用时
 * 回退内置五套静态镜像）。内置五 id 走 i18n 词表 label，扩展体系用
 * RPC 原样 label/description。
 *
 * 选中语义（接线归调用方）：欢迎页选中 → designSystemId 随
 * session.create 的 projectMetadata 落盘；会话内选中 →
 * session.setDesignSystem RPC（选中即写，null = 清除/跟随既有）。
 * hover 风格行浮出预览卡（§3.3 opendesign 式：色卡条 + 名 + description
 * 全文 + tokens 迷你 mock），浮卡实现见 design-system-preview.tsx。
 */

/** 行 hover 浮卡的悬停桥接（ms）：移出行 → 卡前的小窗口，移到卡面即取消。 */
const HOVER_LEAVE_MS = 120;

export function DesignStyleSelect({
	systems,
	selected,
	onPick,
}: {
	/** 设计体系列表（useDesignSystems 的返回；两处调用同源）。 */
	systems: DesignSystemEntry[];
	/** Currently selected style id, null = 跟随既有. */
	selected: string | null;
	/** Pick handler; null = inherit (跟随既有). */
	onPick(id: string | null): void;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const { anchorRef, renderMenu } = useFloatingMenu(open, setOpen);
	const current = selected != null ? (systems.find(s => s.id === selected) ?? null) : null;
	// hover 预览卡：悬停行 → 记锚矩形；移出行/卡经短桥接后清除。
	const [hoverRect, setHoverRect] = useState<{
		id: string;
		left: number;
		right: number;
		top: number;
		bottom: number;
	} | null>(null);
	const leaveTimer = useRef(0);
	const hoverEntry = hoverRect ? (systems.find(s => s.id === hoverRect.id) ?? null) : null;
	const enterRow =
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
	const pick = (id: string | null): void => {
		setOpen(false);
		setHoverRect(null);
		onPick(id);
	};
	return (
		<div ref={anchorRef} className="gui-style-select">
			<button
				type="button"
				className={`gui-style-select-btn${current ? " gui-style-select-btn--set" : ""}${
					open ? " gui-style-select-btn--open" : ""
				}`}
				title={t("design style hint")}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen(v => !v)}
			>
				<Icon name="palette" className="h-3 w-3" />
				<span>{current ? designSystemLabel(current) : t("design style inherit")}</span>
				<Icon name="arrow-down-s" className="h-3 w-3 gui-style-select-caret" />
			</button>
			{renderMenu(
				<div
					className="gui-attach-menu gui-style-select-menu"
					role="menu"
					aria-label={t("design style")}
					onMouseLeave={() => setHoverRect(null)}
				>
					<div className="gui-approval-menu-head">{t("design style")}</div>
					<button
						type="button"
						className={`gui-attach-opt${selected === null ? " gui-attach-opt--on" : ""}`}
						role="menuitemradio"
						aria-checked={selected === null}
						title={t("design style hint")}
						onClick={() => pick(null)}
					>
						<Icon name={selected === null ? "check" : "palette"} className="h-4 w-4" />
						<span className="min-w-0 flex-1 truncate text-[13px] leading-tight text-[var(--color-text)]">
							{t("design style inherit")}
						</span>
					</button>
					{systems.map(s => (
						<button
							key={s.id}
							type="button"
							className={`gui-attach-opt${selected === s.id ? " gui-attach-opt--on" : ""}`}
							role="menuitemradio"
							aria-checked={selected === s.id}
							title={t("design style hint")}
							onMouseEnter={enterRow(s.id)}
							onMouseLeave={scheduleHide}
							onClick={() => pick(s.id)}
						>
							<Icon name={selected === s.id ? "check" : "palette"} className="h-4 w-4" />
							<span className="min-w-0 flex-1 truncate text-[13px] leading-tight text-[var(--color-text)]">
								{designSystemLabel(s)}
							</span>
							<DesignSystemSwatchBar entry={s} count={3} className="gui-ds-swatchbar gui-ds-swatchbar--menu" />
						</button>
					))}
				</div>,
			)}
			<DesignSystemHoverCard entry={hoverEntry} anchor={hoverRect} />
		</div>
	);
}
