import { t } from "@musepi/client-core";
import { type ReactNode, useMemo, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { type ExtensionItem, useExtensionRegistry } from "../lib/slot-host";
import { Icon } from "../vendor/oc-icons";

/**
 * 插件 tab 的统一清单（ExtensionsCenter 与 CapabilityCenterPage 共用）：
 * 插件包（plugins.packages，marketplace/npm 安装）与热加载的扩展模块
 * （extensions.list 的 kind=extension-module —— deepseek-harness 式
 * 插件化基础组件）同屏汇总，像 skill 管理一样给每项打来源类别标签
 * （内置/项目级/用户级），类型标签区分两条链路。
 *
 * 插件包数据由父级拉取传入（父级还要用它做 tab 计数）；扩展模块走
 * 共享 useExtensionRegistry 单例（10s 轮询 + extensions.changed 即时
 * 刷新），不新增轮询。
 */

/** One installed plugin package from daemon plugins.packages (full
 *  inventory incl. disabled: name/version/description/scope/enabled). */
export interface PluginPackageEntry {
	name: string;
	version: string;
	path: string;
	scope: "user" | "project";
	enabled: boolean;
	description: string | null;
	tools: number;
	commands: number;
	handlers: number;
}

/** 来源类别标签（skill 管理 levelLabel 同款判定）：provider 属内置体系
 *  （native/musepi-managed/builtin-defaults）→ 内置，否则按 level 给
 *  项目级/用户级。插件包传 "omp-plugins"（永不命中内置分支）+ scope。
 *  单一权威实现，ExtensionsCenter 的 levelLabel 委托到这里。 */
export function sourceLevelLabel(provider: string, level: string): string {
	if (provider === "native" || provider === "musepi-managed" || provider === "builtin-defaults") {
		return t("skill filter builtin");
	}
	return level === "project" ? t("skill filter project") : t("skill filter user");
}

export function UnifiedPluginsView({
	rpc,
	plugins,
	pluginsError,
	onTogglePackage,
	onOpenMarketplace,
	onError,
}: {
	rpc: RpcClient | null;
	plugins: PluginPackageEntry[];
	pluginsError: string | null;
	onTogglePackage(p: PluginPackageEntry): void;
	onOpenMarketplace(): void;
	/** 模块开关的错误出口（父级顶栏 error 横幅）。 */
	onError(message: string | null): void;
}): ReactNode {
	const data = useExtensionRegistry(rpc);
	// 防双击：一次只允许一个模块开关在途。插件包开关由父级 own。
	const [busyId, setBusyId] = useState<string | null>(null);
	// 只取 extension-module 一类：其余 kind（skill/tool/mcp/…）在能力
	// 清单 tab 有完整 provider→kind→item 树，这里不重复。
	const modules = useMemo(() => (data?.extensions ?? []).filter(e => e.kind === "extension-module"), [data]);

	const toggleModule = (e: ExtensionItem): void => {
		if (!rpc || busyId) return;
		setBusyId(e.id);
		void rpc
			.request("extensions.setEnabled", { id: e.id, enabled: e.state !== "active" })
			.then(() => onError(null))
			.catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))
			.finally(() => setBusyId(null));
		// daemon 广播 extensions.changed → registry 单例重拉，不本地乐观更新。
	};

	// 双清空才是真空态：任一链路有货就展示统一清单。
	if (plugins.length === 0 && modules.length === 0 && !pluginsError) {
		return (
			<div className="gui-ext-plugins">
				{/* Empty state with an exit: a bald「未加载插件」read as a
				 * broken page. Both plugin systems now surface here unified —
				 * when even the module lane is empty, say where each comes
				 * from instead of leaving a blank. */}
				<div className="gui-ext-empty-state">
					<Icon name="plug" className="h-5 w-5 opacity-40" />
					<div className="gui-ext-empty-state-title">{t("no plugins loaded")}</div>
					<p className="gui-ext-empty-state-desc">{t("plugins empty hint")}</p>
					<p className="gui-ext-empty-state-desc">{t("plugins empty modules hint")}</p>
					<button type="button" className="gui-btn" onClick={onOpenMarketplace}>
						<Icon name="plug-2" className="h-3.5 w-3.5" />
						{t("go to marketplace")}
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="gui-ext-plugins">
			{pluginsError && <div className="gui-ext-plugins-error">{pluginsError}</div>}
			<div className="gui-ext-list-scroll">
				{plugins.map(p => (
					<div key={p.path} className="gui-ext-provider">
						<div className="gui-ext-provider-h">
							<Icon name="plug" className="h-3.5 w-3.5 shrink-0 opacity-60" />
							<span className="min-w-0 flex-1 truncate text-[12px] font-medium">{p.name}</span>
							<span className="gui-ext-item-tag">{t("plugin package tag")}</span>
							<span className="gui-ext-item-tag">{sourceLevelLabel("omp-plugins", p.scope)}</span>
							<button
								type="button"
								role="switch"
								aria-checked={p.enabled}
								aria-label={`${t("plugin enable")} ${p.name}`}
								className={`gui-toggle gui-toggle--sm${p.enabled ? " gui-toggle--on" : ""}`}
								onClick={() => onTogglePackage(p)}
							>
								{/* Knob span required: the thumb is a child element,
								 * not a pseudo-element — empty buttons lose the dot. */}
								<span className="gui-toggle-knob" />
							</button>
						</div>
						<div className="gui-ext-plugins-meta">
							<span className="gui-ext-plugins-version">v{p.version}</span>
							<span className="gui-ext-group-count">
								{t("plugin counts", { tools: p.tools, commands: p.commands, handlers: p.handlers })}
							</span>
						</div>
						{p.description ? <div className="gui-ext-plugins-desc">{p.description}</div> : null}
						<div className="gui-ext-plugins-path">{p.path}</div>
					</div>
				))}
				{modules.map(e => (
					<div key={e.id} className="gui-ext-provider">
						<div className="gui-ext-provider-h">
							<Icon name="code-box" className="h-3.5 w-3.5 shrink-0 opacity-60" />
							<span
								className={`gui-ext-dot${e.loadError ? " gui-ext-dot--error" : e.state === "active" ? "" : e.state === "shadowed" ? " gui-ext-dot--shadowed" : " gui-ext-dot--off"}`}
							/>
							<span className="min-w-0 flex-1 truncate text-[12px] font-medium">{e.displayName || e.name}</span>
							<span className="gui-ext-item-tag">{t("ext kind extension-module")}</span>
							<span className="gui-ext-item-tag">{sourceLevelLabel(e.source.provider, e.source.level)}</span>
							{e.loadError && (
								<span className="gui-ext-item-tag gui-ext-item-tag--err">{t("ext load failed")}</span>
							)}
							<button
								type="button"
								role="switch"
								aria-checked={e.state === "active"}
								aria-label={
									e.state === "active" ? `${t("disable skill")} ${e.name}` : `${t("enable skill")} ${e.name}`
								}
								className={`gui-toggle gui-toggle--sm${e.state === "active" ? " gui-toggle--on" : ""}`}
								onClick={() => toggleModule(e)}
							>
								<span className="gui-toggle-knob" />
							</button>
						</div>
						{e.description ? <div className="gui-ext-plugins-desc">{e.description}</div> : null}
						<div className="gui-ext-plugins-path">{e.path}</div>
					</div>
				))}
				{plugins.length === 0 && modules.length === 0 && (
					<div className="gui-ext-empty">{t("no plugins loaded")}</div>
				)}
			</div>
		</div>
	);
}
