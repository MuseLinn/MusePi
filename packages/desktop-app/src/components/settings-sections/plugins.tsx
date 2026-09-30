import { t } from "@musepi/client-core";
import { type ReactNode, useMemo, useState } from "react";
import type { RpcClient } from "../../lib/rpc";
import { useExtensionRegistry } from "../../lib/slot-host";
import { PluginDetailDialog } from "../PluginDetailDialog";
import { isPluginLaneEntry, ModuleCard } from "../UnifiedPluginsView";

/**
 * 设置 · 插件分区（dsh 设置页「内置插件」卡片网格 parity）：全部插件
 * 单元以卡片呈现（图标 + 显示名 + 状态 + 一行描述），点击卡片打开
 * 与扩展中心/能力中心完全相同的液态玻璃详情弹层——启用、配置表单、
 * 「包含的组件」独立开关三处共享一份组件与契约，零漂移。卡片本体
 * 与扩展中心插件 tab 的 cards variant 共用 ModuleCard 单一权威。
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
						<ModuleCard key={e.id} e={e} onOpen={item => setDetailId(item.id)} />
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
