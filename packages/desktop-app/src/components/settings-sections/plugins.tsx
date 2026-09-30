import { t } from "@musepi/client-core";
import { type ReactNode, useMemo, useState } from "react";
import type { RpcClient } from "../../lib/rpc";
import { useExtensionRegistry } from "../../lib/slot-host";
import { Icon } from "../../vendor/oc-icons";
import { PluginDetailDialog } from "../PluginDetailDialog";
import { isPluginLaneEntry, pluginStateLabel } from "../UnifiedPluginsView";

/**
 * 设置 · 插件分区（dsh 设置页「内置插件」卡片网格 parity）：全部插件
 * 单元以卡片呈现（图标 + 显示名 + 状态 + 一行描述），点击卡片打开
 * 与扩展中心/能力中心完全相同的液态玻璃详情弹层——启用、配置表单、
 * 「包含的组件」独立开关三处共享一份组件与契约，零漂移。
 *
 * 数据走共享 useExtensionRegistry 单例（10s 轮询 + extensions.changed
 * 即时刷新），与插件 tab 同一份数据源。
 */

export function PluginsSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const data = useExtensionRegistry(rpc);
	const [detailId, setDetailId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const modules = useMemo(() => (data?.extensions ?? []).filter(isPluginLaneEntry), [data]);
	const detailItem = detailId ? (modules.find(e => e.id === detailId) ?? null) : null;

	return (
		<div className="px-3 py-2">
			<div className="gui-plugin-settings-desc">{t("ext plugins settings desc")}</div>
			{error && <div className="gui-ext-plugins-error">{error}</div>}
			{modules.length === 0 ? (
				<div className="gui-ext-empty">{t("no plugins loaded")}</div>
			) : (
				<div className="gui-plugin-cards">
					{modules.map(e => (
						<button
							key={e.id}
							type="button"
							className="gui-plugin-card"
							aria-label={`${t("ext open plugin details")} · ${e.displayName || e.name}`}
							onClick={() => setDetailId(e.id)}
						>
							<div className="gui-plugin-card-head">
								<Icon name="code-box" className="h-4 w-4 shrink-0 opacity-70" />
								<span
									className={`gui-ext-dot${e.loadError ? " gui-ext-dot--error" : e.state === "active" ? "" : e.state === "shadowed" ? " gui-ext-dot--shadowed" : " gui-ext-dot--off"}`}
								/>
								<span className="min-w-0 flex-1 truncate text-[12px] font-medium">
									{e.displayName || e.name}
								</span>
								<Icon name="arrow-right-s" className="h-3.5 w-3.5 shrink-0 opacity-40" />
							</div>
							{e.description ? <div className="gui-plugin-card-desc">{e.description}</div> : null}
							<div className="gui-plugin-card-foot">
								<span className="gui-ext-item-tag">{pluginStateLabel(e)}</span>
								<span className="gui-ext-item-tag">{e.id}</span>
							</div>
						</button>
					))}
				</div>
			)}
			<PluginDetailDialog
				open={detailItem !== null}
				onClose={() => setDetailId(null)}
				item={detailItem}
				rpc={rpc}
				onError={setError}
			/>
		</div>
	);
}
