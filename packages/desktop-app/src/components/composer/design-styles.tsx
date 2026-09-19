import { t } from "@musepi/guest-client";
import { type ReactNode, useState } from "react";
import { useFloatingMenu } from "../../lib/use-floating-menu";
import { Icon } from "../../vendor/oc-icons";

/**
 * Design style picker — 会话 composer（Composer.tsx footerLeft）与欢迎页空态
 * （WelcomeComposer，design 预设 armed 时）共用的同一颗选择胶囊。
 *
 * WorkBuddy 创意模式 footer 胶囊 parity：入口不再是输入框上方的一行 chips，
 * 而是按钮行里的一颗「风格: 当前值 ∨」胶囊，点开浮动菜单选择。选中风格
 * → 把 `design style brief update {style}` 句子写进输入框（设计稿 08 契约
 * 不变：用户编辑后发送，agent 按设计简报协议把基准留在会话里）。
 * "跟随既有" (id=null) 表示不覆盖简报里已有的风格基准。
 */
export const DESIGN_STYLES = [
	{ id: "minimal", labelKey: "design style minimal" },
	{ id: "glass", labelKey: "design style glass" },
	{ id: "editorial", labelKey: "design style editorial" },
	{ id: "neubrutalism", labelKey: "design style neubrutalism" },
	{ id: "darkneon", labelKey: "design style darkneon" },
] as const;

export function DesignStyleSelect({
	selected,
	onPick,
}: {
	/** Currently selected style id, null = 跟随既有. */
	selected: string | null;
	/** Pick handler; null = inherit (跟随既有). */
	onPick(id: string | null): void;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const { anchorRef, renderMenu } = useFloatingMenu(open, setOpen);
	const current = selected != null ? (DESIGN_STYLES.find(s => s.id === selected) ?? null) : null;
	const pick = (id: string | null): void => {
		setOpen(false);
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
				<span>{current ? t(current.labelKey) : t("design style inherit")}</span>
				<Icon name="arrow-down-s" className="h-3 w-3 gui-style-select-caret" />
			</button>
			{renderMenu(
				<div className="gui-attach-menu gui-style-select-menu" role="menu" aria-label={t("design style")}>
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
					{DESIGN_STYLES.map(s => (
						<button
							key={s.id}
							type="button"
							className={`gui-attach-opt${selected === s.id ? " gui-attach-opt--on" : ""}`}
							role="menuitemradio"
							aria-checked={selected === s.id}
							title={t("design style hint")}
							onClick={() => pick(s.id)}
						>
							<Icon name={selected === s.id ? "check" : "palette"} className="h-4 w-4" />
							<span className="min-w-0 flex-1 truncate text-[13px] leading-tight text-[var(--color-text)]">
								{t(s.labelKey)}
							</span>
						</button>
					))}
				</div>,
			)}
		</div>
	);
}
