import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useState } from "react";
import { Reveal } from "../../components/Reveal";
import type { SlotComponentProps } from "../../lib/slot-host";
import { Icon } from "../../vendor/oc-icons";

/**
 * 信息卡「插件」分区(Cordis `chat.session-info.plugins`)。
 *
 * 数据由宿主读好:`sessionInfo` 只带计数与条目,分区自己不碰 RPC 或扩展注册表 ——
 * 卡片的内置回退与这里用同一份判定,停用/编译失败时两边的读数不会分叉。
 * 标记与样式沿用 gui-chat.css 的 `.gui-session-info-plugins`,与内置回退同构。
 */
export default function SessionInfoPluginsSection({ sessionInfo }: SlotComponentProps): ReactNode {
	const [open, setOpen] = useState(false);
	if (!sessionInfo || sessionInfo.pluginEntries.length === 0) return null;
	const { runningPlugins, pluginEntries } = sessionInfo;
	return (
		<section className="gui-session-info-plugins" data-state={runningPlugins > 0 ? "running" : "idle"}>
			<button
				type="button"
				className="gui-session-info-plugins-head"
				aria-expanded={open}
				title={t("settings.extensionsRunning", { count: String(runningPlugins) })}
				onClick={() => setOpen(value => !value)}
			>
				<Icon name="plug" className="gui-session-info-row-icon" />
				<span className="gui-session-info-section-label">{t("general.sessionInfoPlugins")}</span>
				<span className="gui-session-info-count">{`${runningPlugins}/${pluginEntries.length}`}</span>
				<Icon
					name="arrow-down-s"
					className={`gui-session-info-chev${open ? "" : " gui-session-info-chev--closed"}`}
				/>
			</button>
			<Reveal open={open}>
				<ul className="gui-session-info-list">
					{pluginEntries.map(entry => (
						<li key={entry.id}>
							<div className="gui-session-info-plugin" title={entry.label}>
								<span
									className={`gui-session-info-dot${entry.active ? " gui-session-info-dot--active" : ""}`}
									aria-hidden="true"
								/>
								<span className="gui-session-info-item-label">{entry.label}</span>
								<span className="gui-session-info-plugin-state">
									{entry.active ? t("settings.extensionsStateRunning") : t("settings.extensionsStateDisabled")}
								</span>
							</div>
						</li>
					))}
				</ul>
			</Reveal>
		</section>
	);
}
