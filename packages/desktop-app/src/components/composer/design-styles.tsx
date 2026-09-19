import { t } from "@musepi/guest-client";
import { Icon } from "../../vendor/oc-icons";

/**
 * Design style chips — 会话 composer（Composer.tsx aboveRow）与欢迎页空态
 * （WelcomeComposer，design 预设 armed 时）共用的同一行风格选择。
 *
 * 设计稿 08 契约:点一个风格 chip → 把 `design style brief update {style}`
 * 句子写进输入框,用户编辑后发送;agent 按设计简报协议把基准留在会话里。
 * "跟随既有" (id=null) 表示不覆盖简报里已有的风格基准。
 */
export const DESIGN_STYLES = [
	{ id: "minimal", labelKey: "design style minimal" },
	{ id: "glass", labelKey: "design style glass" },
	{ id: "editorial", labelKey: "design style editorial" },
	{ id: "neubrutalism", labelKey: "design style neubrutalism" },
	{ id: "darkneon", labelKey: "design style darkneon" },
] as const;

export function DesignStyleChips({
	selected,
	onPick,
}: {
	/** Currently highlighted style id, null = 跟随既有. */
	selected: string | null;
	/** Pick handler; null = inherit (跟随既有). */
	onPick(id: string | null): void;
}) {
	return (
		<div className="gui-design-chips">
			<span className="gui-design-chips-label">
				<Icon name="palette" className="h-3 w-3" />
				{t("design style")}
			</span>
			<button
				type="button"
				className={`gui-design-chip${selected === null ? " gui-design-chip--on" : ""}`}
				title={t("design style hint")}
				onClick={() => onPick(null)}
			>
				{t("design style inherit")}
			</button>
			{DESIGN_STYLES.map(s => (
				<button
					key={s.id}
					type="button"
					className={`gui-design-chip${selected === s.id ? " gui-design-chip--on" : ""}`}
					title={t("design style hint")}
					onClick={() => onPick(s.id)}
				>
					{t(s.labelKey)}
				</button>
			))}
		</div>
	);
}
