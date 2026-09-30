import { t } from "@musepi/client-core";
import { type ReactNode, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import type { ExtensionItem } from "../lib/slot-host";
import { Icon } from "../vendor/oc-icons";
import { DialogFrame } from "./DialogFrame";
import { PluginManifestSections, pluginStateLabel, sourceLevelLabel } from "./UnifiedPluginsView";

/**
 * 插件详情液态玻璃弹层（dsh 插件详情页 parity，交互形态按小袁总决策
 * 从「跳转页面」改为「弹出浮层」，浮层本身日后可插件化）：
 * 标题（图标 + 显示名 + kind/来源标签 + 状态点）、ID + 描述、
 * 触发词 / 来源 / 路径、清单配置表单与资源卡（PluginManifestSections
 * 单一权威复用），以及 dsh「包含的组件」段——每组件一行独立开关，
 * 经 extensions.setComponentEnabled 写 tools.disabled 黑名单，禁用后
 * agent 工具集下个模型请求即移除。
 *
 * DialogFrame 常驻挂载由 open 驱动（GUI 规范：条件挂载会杀死退场动画）。
 */

function ComponentsSection({
	item,
	rpc,
	onError,
}: {
	item: ExtensionItem;
	rpc: RpcClient | null;
	onError(m: string | null): void;
}): ReactNode {
	const [busy, setBusy] = useState<string | null>(null);
	if (!item.components || item.components.length === 0) return null;

	const toggle = (componentId: string, enabled: boolean): void => {
		if (!rpc || busy) return;
		setBusy(componentId);
		void rpc
			.request("extensions.setComponentEnabled", { id: item.id, component: componentId, enabled })
			.then(() => onError(null))
			.catch((err: unknown) =>
				onError(`${t("ext component toggle failed")}: ${err instanceof Error ? err.message : String(err)}`),
			)
			.finally(() => setBusy(null));
		// daemon 广播 extensions.changed → registry 单例重拉，不本地乐观更新。
	};

	return (
		<div className="gui-ext-detail-section">
			<div className="gui-ext-detail-label">
				{t("ext plugin components")} · {item.components.length}
			</div>
			<div className="gui-plugin-config-desc">{t("ext plugin components desc")}</div>
			<div className="gui-plugin-components">
				{item.components.map(c => (
					<div key={c.id} className="gui-plugin-component-row">
						<div className="min-w-0 flex-1">
							<div className="gui-plugin-component-name">
								<span className={`gui-ext-dot${c.enabled ? "" : " gui-ext-dot--off"}`} />
								{c.name}
							</div>
							{c.description ? <div className="gui-plugin-component-desc">{c.description}</div> : null}
							{!c.enabled && c.disabledReason ? (
								<div className="gui-plugin-component-denied">{t("ext component denied")}</div>
							) : null}
						</div>
						{c.canToggle && (
							<button
								type="button"
								role="switch"
								aria-checked={c.enabled}
								aria-label={`${t("plugin enable")} ${c.name}`}
								className={`gui-toggle gui-toggle--sm${c.enabled ? " gui-toggle--on" : ""}`}
								disabled={busy === c.id}
								onClick={() => toggle(c.id, !c.enabled)}
							>
								<span className="gui-toggle-knob" />
							</button>
						)}
					</div>
				))}
			</div>
		</div>
	);
}

export function PluginDetailDialog({
	open,
	onClose,
	item,
	rpc,
	onError,
}: {
	open: boolean;
	onClose(): void;
	item: ExtensionItem | null;
	rpc: RpcClient | null;
	/** 组件开关错误出口（弹层内横幅）。 */
	onError(message: string | null): void;
}): ReactNode {
	return (
		<DialogFrame open={open} onClose={onClose} label={t("ext plugin details")} className="gui-plugin-dialog">
			{item && (
				<>
					<div className="gui-dialog-head">
						<Icon name="code-box" className="h-4 w-4 opacity-70" />
						<span className="min-w-0 flex-1 truncate text-[14px] font-semibold">
							{item.displayName || item.name}
						</span>
						<span className="gui-ext-item-tag">{item.id}</span>
						<button type="button" className="gui-tool-btn" onClick={onClose} aria-label={t("close")}>
							<Icon name="close" className="h-4 w-4" />
						</button>
					</div>
					<div className="gui-plugin-dialog-body">
						<div className="gui-ext-detail-section">
							<div
								className={`gui-ext-detail-status${item.state === "active" && !item.loadError ? " gui-ext-detail-status--active" : item.state === "shadowed" ? " gui-ext-detail-status--shadowed" : ""}`}
							>
								<span
									className={`gui-ext-dot${item.loadError ? " gui-ext-dot--error" : item.state === "active" ? "" : item.state === "shadowed" ? " gui-ext-dot--shadowed" : " gui-ext-dot--off"}`}
								/>
								{pluginStateLabel(item)}
								<span className="gui-ext-item-tag">
									{sourceLevelLabel(item.source.provider, item.source.level)}
								</span>
							</div>
							{item.description ? <div className="gui-ext-plugins-desc">{item.description}</div> : null}
							{item.loadError && (
								<div className="gui-ext-detail-loaderror" title={item.loadError}>
									<Icon name="alert" className="h-3.5 w-3.5 shrink-0" />
									<span className="min-w-0 truncate">{item.loadError}</span>
								</div>
							)}
						</div>
						{item.trigger && (
							<div className="gui-ext-detail-section">
								<div className="gui-ext-detail-label">{t("trigger")}</div>
								<div className="gui-ext-detail-path">{item.trigger}</div>
							</div>
						)}
						<div className="gui-ext-detail-section">
							<div className="gui-ext-detail-label">{t("source")}</div>
							<div className="gui-ext-detail-value">
								{t("via {provider} ({level})", {
									provider: item.source.providerName,
									level: sourceLevelLabel(item.source.provider, item.source.level),
								})}
							</div>
							<div className="gui-ext-detail-path">{item.path}</div>
						</div>
						<ComponentsSection item={item} rpc={rpc} onError={onError} />
						{(item.config?.length || item.configErrors?.length || item.resources) && (
							<PluginManifestSections item={item} rpc={rpc} />
						)}
					</div>
				</>
			)}
		</DialogFrame>
	);
}
