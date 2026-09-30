import { t } from "@musepi/client-core";
import { type ReactNode, useMemo, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { useExtensionRegistry } from "../lib/slot-host";
import { Icon } from "../vendor/oc-icons";
import { PluginDetailDialog } from "./PluginDetailDialog";
import { ModuleRow } from "./UnifiedPluginsView";

/**
 * 能力中心「扩展」tab —— 运行时扩展模块（pi/omp 遗产扩展体系的用户/
 * 项目级热加载模块，WorkBuddy 枢纽下拉的直达落点之一）。
 *
 * 口径：extensions.list 里 kind=extension-module 且 source.level 非 native
 * 的条目（builtin 插件单元归「插件」tab 的官方 lane，不重复列）。行渲染
 * 复用 UnifiedPluginsView 的 ModuleRow（单一权威），开关走
 * extensions.setEnabled，daemon 广播 extensions.changed 后 registry 单例
 * 自动重拉。
 */
export function ExtensionsRuntimeTab({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const data = useExtensionRegistry(rpc);
	// 防双击：一次只允许一个模块开关在途。
	const [busyId, setBusyId] = useState<string | null>(null);
	const [detailId, setDetailId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const modules = useMemo(
		() => (data?.extensions ?? []).filter(e => e.kind === "extension-module" && e.source.level !== "native"),
		[data],
	);
	const detailItem = detailId ? (modules.find(e => e.id === detailId) ?? null) : null;

	const toggleModule = (id: string, enabled: boolean): void => {
		if (!rpc || busyId) return;
		setBusyId(id);
		void rpc
			.request("extensions.setEnabled", { id, enabled })
			.then(() => setError(null))
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
			.finally(() => setBusyId(null));
		// daemon 广播 extensions.changed → registry 单例重拉，不本地乐观更新。
	};

	if (modules.length === 0) {
		return (
			<div className="gui-ext-plugins">
				<div className="gui-ext-empty-state">
					<Icon name="code-box" className="h-5 w-5 opacity-40" />
					<div className="gui-ext-empty-state-title">{t("extensions runtime empty")}</div>
					<p className="gui-ext-empty-state-desc">{t("extensions runtime empty hint")}</p>
				</div>
			</div>
		);
	}

	return (
		<div className="gui-ext-plugins">
			{error && <div className="gui-ext-plugins-error">{error}</div>}
			<div className="gui-ext-list-scroll">
				<div className="gui-ext-group">
					<div className="gui-ext-group-title">
						{t("extensions runtime")} · {modules.length}
					</div>
					{modules.map(e => (
						<ModuleRow
							key={e.id}
							e={e}
							rpc={rpc}
							busy={busyId !== null}
							onToggle={item => toggleModule(item.id, item.state !== "active")}
							onOpen={item => setDetailId(item.id)}
						/>
					))}
				</div>
			</div>
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
