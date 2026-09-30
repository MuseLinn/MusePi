import { t } from "@musepi/client-core";
import { coerceConfigValues } from "@musepi/pi-wire";
import { type ReactNode, useMemo, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { type ExtensionItem, useExtensionRegistry } from "../lib/slot-host";
import { Icon } from "../vendor/oc-icons";
import { ConfigFormRenderer } from "./ConfigFormRenderer";

/**
 * 插件 tab 的统一清单（ExtensionsCenter 与 CapabilityCenterPage 共用）：
 * 插件包（plugins.packages，marketplace/npm 安装）与热加载的插件模块
 * （extensions.list 的 kind=extension-module —— deepseek-harness 式
 * 插件化基础组件）同屏汇总，像 skill 管理一样给每项打来源类别标签
 * （内置/项目级/用户级），类型标签区分两条链路。
 *
 * 模块行支持行内展开（dsh 插件详情页 parity）：状态 / 来源 / 触发词 /
 * 清单配置表单 / 资源占用。两个宿主因此零成本同时获得详情能力，
 * 不新增页面路由与状态管理。
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
	// builtin-registry 条目：musepi-extensions provider + native level。
	if (provider === "musepi-extensions" && level === "native") {
		return t("skill filter builtin");
	}
	return level === "project" ? t("skill filter project") : t("skill filter user");
}

/**
 * 插件 lane 判定（统一清单的「模块侧」口径，ExtensionsCenter 的 tab 计数
 * 与本视图共用此单一权威，防双口径漂移）：
 * - kind=extension-module：真实插件模块（native / musepi-extensions provider）；
 * - builtin-registry 条目（musepi-extensions provider + native level，即
 *   task-card 风格 / 桌壳 / 魔术关键词 / 主题 / 工具卡片渲染等内置插件单元）。
 *   排除 kind=skill —— 捆绑技能是技能清单的管理对象，不进插件 lane，
 *   避免与能力清单 tab 整屏重复。
 */
export function isPluginLaneEntry(e: ExtensionItem): boolean {
	if (e.kind === "extension-module") return true;
	return e.source.provider === "musepi-extensions" && e.source.level === "native" && e.kind !== "skill";
}

/** kind 显示名（与 ExtensionsCenter.kindLabel 同 fallback 口径：有 i18n
 *  key 用译文，没有则回退原始 kind 字符串）。 */
function kindTag(kind: string): string {
	const key = `ext kind ${kind}`;
	const label = t(key as Parameters<typeof t>[0]);
	return label === key ? kind : label;
}

/** 条目状态标签（ExtensionsCenter detail pane 同款语义单一权威——
 * 加载失败是制胜相位（dsh PluginInventory parity）：条目在配置里可能
 * 名义 active，但实际什么都没注册。 */
export function pluginStateLabel(e: ExtensionItem): string {
	if (e.loadError) return t("ext load failed");
	if (e.state === "active") return t("extension active");
	if (e.state === "shadowed") return t("ext shadowed");
	return e.disabledReason === "provider-disabled" ? t("ext provider disabled") : t("ext item disabled");
}

/** i18n 键探测：命中返回译文，未命中返回 null（fallback 到 daemon 原文）。 */
function builtinText(key: string): string | null {
	const label = t(key as Parameters<typeof t>[0]);
	return label === key ? null : label;
}

/** 内置插件单元的 GUI 侧 i18n 覆盖：builtin-registry 的 displayName/
 *  description 是 daemon 硬编码英文原文，GUI 按 `ext builtin <name>[ desc]`
 *  键查译文，未命中回退原文（与 kindTag 同模式，不改 daemon 避免
 *  TUI/GUI 双端分叉）。 */
function builtinDisplayName(e: ExtensionItem): string {
	if (!e.builtin) return e.displayName || e.name;
	return builtinText(`ext builtin ${e.name}`) ?? e.displayName ?? e.name;
}

function builtinDescription(e: ExtensionItem): string | undefined {
	if (!e.builtin) return e.description;
	return builtinText(`ext builtin ${e.name} desc`) ?? e.description;
}

/**
 * 插件详情区（dsh 插件管理页五段式）:配置表单 + 资源卡 + fail-soft
 * 丢弃提示。表单是受控渲染 + 写入链路:初始值 = 清单默认值 ← 存储值
 * (daemon 已按字段钳制下发到 configValues);每次变更先乐观更新本地,
 * 再经 extensions.setConfig 落盘——失败回滚该键并显示错误,成功按字段的
 * restart 声明提示生效时机(运行时消费随 cordis 试点落地)。
 *
 * 单一权威在此：能力清单 tab 的 detail pane 与插件 tab 的行内展开
 * 共用本组件（ExtensionsCenter import 回去）。
 */
export function PluginManifestSections({ item, rpc }: { item: ExtensionItem; rpc: RpcClient | null }): ReactNode {
	const [values, setValues] = useState<Record<string, unknown>>(() =>
		item.config ? coerceConfigValues(item.config, item.configValues) : {},
	);
	const [notice, setNotice] = useState<{ kind: "saved" | "error"; text: string } | null>(null);
	const resources = item.resources;

	const handleChange = (key: string, value: unknown): void => {
		const desc = item.config?.find(f => f.key === key);
		const previous = values[key];
		setValues(prev => ({ ...prev, [key]: value }));
		setNotice(null);
		if (!rpc || !desc) return;
		void rpc
			.request("extensions.setConfig", { id: item.id, key, value })
			.then(() => {
				const hint =
					desc.restart && desc.restart !== "none"
						? ` · ${desc.restart === "session" ? t("ext restart session") : t("ext restart daemon")}`
						: "";
				setNotice({ kind: "saved", text: `${t("ext config saved")}${hint}` });
			})
			.catch((err: unknown) => {
				setValues(prev => ({ ...prev, [key]: previous }));
				setNotice({ kind: "error", text: `${t("ext config save failed")}: ${String(err)}` });
			});
	};

	return (
		<>
			{item.configErrors && item.configErrors.length > 0 && (
				<div className="gui-ext-detail-loaderror">
					<Icon name="alert" className="h-3.5 w-3.5 shrink-0" />
					<span className="min-w-0 truncate">{t("ext config errors", { count: item.configErrors.length })}</span>
				</div>
			)}
			{item.config && item.config.length > 0 && (
				<div className="gui-ext-detail-section">
					<div className="gui-ext-detail-label">{t("ext plugin config")}</div>
					<div className="gui-plugin-config-desc">{t("ext plugin config desc")}</div>
					<ConfigFormRenderer fields={item.config} values={values} onChange={handleChange} disabled={!rpc} />
					{notice && (
						<div
							className={`gui-plugin-config-notice${notice.kind === "error" ? " gui-plugin-config-notice--error" : ""}`}
						>
							{notice.text}
						</div>
					)}
				</div>
			)}
			{resources && (
				<div className="gui-ext-detail-section">
					<div className="gui-ext-detail-label">{t("ext plugin resources")}</div>
					<div className="gui-plugin-resources">
						{resources.disk && (
							<div className="gui-plugin-resource-row">
								<span className="gui-plugin-resource-key">{t("ext resources disk")}</span>
								<span className="gui-plugin-resource-value">{resources.disk}</span>
							</div>
						)}
						{resources.memory && (
							<div className="gui-plugin-resource-row">
								<span className="gui-plugin-resource-key">{t("ext resources memory")}</span>
								<span className="gui-plugin-resource-value">{resources.memory}</span>
							</div>
						)}
						{typeof resources.setupMinutes === "number" && (
							<div className="gui-plugin-resource-row">
								<span className="gui-plugin-resource-key">{t("ext resources setup")}</span>
								<span className="gui-plugin-resource-value">{resources.setupMinutes}</span>
							</div>
						)}
						{resources.models && resources.models.length > 0 && (
							<div className="gui-plugin-resource-row">
								<span className="gui-plugin-resource-key">{t("ext resources models")}</span>
								<span className="gui-plugin-resource-value">
									{resources.models.map(m => (m.size ? `${m.name} · ${m.size}` : m.name)).join(", ")}
								</span>
							</div>
						)}
					</div>
				</div>
			)}
		</>
	);
}

/** 模块行展开详情：状态 / 来源 / 触发词 / 清单配置与资源。 */
function ModuleDetail({ item, rpc }: { item: ExtensionItem; rpc: RpcClient | null }): ReactNode {
	return (
		<div className="gui-ext-plugins-detail">
			<div className="gui-ext-detail-section">
				<div className="gui-ext-detail-label">{t("status")}</div>
				<div
					className={`gui-ext-detail-status${item.state === "active" && !item.loadError ? " gui-ext-detail-status--active" : item.state === "shadowed" ? " gui-ext-detail-status--shadowed" : ""}`}
				>
					<span
						className={`gui-ext-dot${item.loadError ? " gui-ext-dot--error" : item.state === "active" ? "" : item.state === "shadowed" ? " gui-ext-dot--shadowed" : " gui-ext-dot--off"}`}
					/>
					{pluginStateLabel(item)}
					{item.state === "shadowed" && item.shadowedBy && (
						<span className="gui-ext-detail-shadowed">{t("shadowed by {name}", { name: item.shadowedBy })}</span>
					)}
				</div>
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
			{(item.config?.length || item.configErrors?.length || item.resources) && (
				<PluginManifestSections item={item} rpc={rpc} />
			)}
		</div>
	);
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
	// 行内展开的模块详情（dsh 插件详情 parity；同一时刻至多一行展开）。
	const [openId, setOpenId] = useState<string | null>(null);
	// 模块 lane：真实插件模块 + 内置插件单元（isPluginLaneEntry 单一权威，
	// 与 ExtensionsCenter tab 计数同口径）。其余 kind（skill/tool/mcp/…）
	// 在能力清单 tab 有完整 provider→kind→item 树，这里不重复。
	const modules = useMemo(() => (data?.extensions ?? []).filter(isPluginLaneEntry), [data]);

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
				{modules.map(e => {
					const open = openId === e.id;
					return (
						<div key={e.id} className="gui-ext-provider">
							<div
								className="gui-ext-provider-h gui-ext-provider-h--btn"
								role="button"
								tabIndex={0}
								aria-expanded={open}
								aria-label={`${t("plugin details")} · ${builtinDisplayName(e)}`}
								onClick={() => setOpenId(open ? null : e.id)}
								onKeyDown={ev => {
									if (ev.key === "Enter" || ev.key === " ") {
										ev.preventDefault();
										setOpenId(open ? null : e.id);
									}
								}}
							>
								<Icon name="code-box" className="h-3.5 w-3.5 shrink-0 opacity-60" />
								<span
									className={`gui-ext-dot${e.loadError ? " gui-ext-dot--error" : e.state === "active" ? "" : e.state === "shadowed" ? " gui-ext-dot--shadowed" : " gui-ext-dot--off"}`}
								/>
								<span className="min-w-0 flex-1 truncate text-[12px] font-medium">{builtinDisplayName(e)}</span>
								<Icon
									name={open ? "arrow-down-s" : "arrow-right-s"}
									className="h-3.5 w-3.5 shrink-0 opacity-50"
								/>
								<span className="gui-ext-item-tag">{kindTag(e.kind)}</span>
								<span className="gui-ext-item-tag">{sourceLevelLabel(e.source.provider, e.source.level)}</span>
								{e.loadError && (
									<span className="gui-ext-item-tag gui-ext-item-tag--err">{t("ext load failed")}</span>
								)}
								<button
									type="button"
									role="switch"
									aria-checked={e.state === "active"}
									aria-label={
										e.state === "active"
											? `${t("disable skill")} ${e.name}`
											: `${t("enable skill")} ${e.name}`
									}
									className={`gui-toggle gui-toggle--sm${e.state === "active" ? " gui-toggle--on" : ""}`}
									onClick={ev => {
										ev.stopPropagation();
										toggleModule(e);
									}}
								>
									<span className="gui-toggle-knob" />
								</button>
							</div>
							{e.description ? <div className="gui-ext-plugins-desc">{builtinDescription(e)}</div> : null}
							<div className="gui-ext-plugins-path">{e.path}</div>
							{open && <ModuleDetail item={e} rpc={rpc} />}
						</div>
					);
				})}
				{plugins.length === 0 && modules.length === 0 && (
					<div className="gui-ext-empty">{t("no plugins loaded")}</div>
				)}
			</div>
		</div>
	);
}
