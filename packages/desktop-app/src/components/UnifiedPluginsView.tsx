import { t } from "@musepi/client-core";
import { coerceConfigValues } from "@musepi/pi-wire";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useConfirm } from "../lib/prompt-dialog";
import type { RpcClient } from "../lib/rpc";
import { type ExtensionItem, useExtensionRegistry } from "../lib/slot-host";
import { Icon } from "../vendor/oc-icons";
import { ConfigFormRenderer } from "./ConfigFormRenderer";
import { PluginDetailDialog } from "./PluginDetailDialog";
import { kindGlyph, PluginIcon } from "./PluginIcon";
import { PluginInstallDialog } from "./PluginInstallDialog";
import { PluginPackageDialog } from "./PluginPackageDialog";

/**
 * 插件 tab 的统一清单（ExtensionsCenter 与 CapabilityCenterPage 共用）：
 * 插件包（plugins.packages，marketplace/npm 安装）与热加载的插件模块
 * （extensions.list 的 kind=extension-module —— deepseek-harness 式
 * 插件化基础组件）同屏汇总，布局对齐 dsh 插件列表面板：
 * - 分组：官方（内置插件单元）/ 已安装（插件包 + 用户模块）;
 * - 行：图标 + 名称 + 一行描述 + 右侧启停开关;
 * - 点击行打开插件详情液态玻璃弹层（PluginDetailDialog）——配置表单、
 *   资源卡与「包含的组件」独立开关都在弹层内,不跳转页面;
 * - 顶栏「+ 添加插件」进 marketplace。
 *
 * 插件包数据由父级拉取传入（父级还要用它做 tab 计数）；扩展模块走
 * 共享 useExtensionRegistry 单例（10s 轮询 + extensions.changed 即时
 * 刷新），不新增轮询。
 */

/** One preset (its composition) as `modes.list` reports it, for grouping. */
interface PresetRow {
	id: string;
	label: string;
	/** Plugin rows this preset composes; empty ones are filtered out. */
	plugins?: { name: string; id?: string; enabled?: boolean }[];
}

/** One installed plugin package from daemon plugins.packages (full
 *  inventory incl. disabled: name/version/description/scope/enabled). */
export interface PluginPackageEntry {
	name: string;
	version: string;
	path: string;
	scope: "user" | "project";
	enabled: boolean;
	description: string | null;
	/** Manifest-declared icon: emoji, text glyph, or http(s)/file URI. */
	icon: string | null;
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

/**
 * Whether `child` lives inside the directory `parent`.
 *
 * The two sides come from different RPCs and therefore from different
 * resolvers: `plugins.packages` returns a package directory built with
 * `path.join`, `extensions.list` returns each module's own entry path. They
 * currently agree on Windows, but the old literal `startsWith(parent + "/")`
 * stops matching silently the moment either side changes spelling — and
 * `startsWith` cannot tell a sibling that merely shares a prefix
 * (`demo-extra` under `demo`) from a real child.
 *
 * Comparing normalized prefixes answers containment directly. Renderer code
 * cannot import `node:path` (Electron gives the renderer no node integration),
 * so normalization is done here instead.
 */
function normalizePathForCompare(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
}

export function isPathInside(child: string, parent: string): boolean {
	const base = normalizePathForCompare(parent);
	const target = normalizePathForCompare(child);
	return target.length > base.length && target.startsWith(`${base}/`);
}

/** i18n 键探测：命中返回译文，未命中返回 null（fallback 到 daemon 原文）。 */
export function builtinText(key: string): string | null {
	const label = t(key as Parameters<typeof t>[0]);
	return label === key ? null : label;
}

/** 内置插件单元的 GUI 侧 i18n 覆盖：builtin-registry 的 displayName/
 *  description 是 daemon 硬编码英文原文，GUI 按 `ext builtin <name>[ desc]`
 *  键查译文，未命中回退原文（与 kindTag 同模式，不改 daemon 避免
 *  TUI/GUI 双端分叉）。 */
export function builtinDisplayName(e: ExtensionItem): string {
	if (!e.builtin) return e.displayName || e.name;
	return builtinText(`ext builtin ${e.name}`) ?? e.displayName ?? e.name;
}

export function builtinDescription(e: ExtensionItem): string | undefined {
	if (!e.builtin) return e.description;
	return builtinText(`ext builtin ${e.name} desc`) ?? e.description;
}

/**
 * 插件配置表单 + 资源卡 + fail-soft 丢弃提示（详情弹层内复用,
 * 单一权威）。表单是受控渲染 + 写入链路:初始值 = 清单默认值 ← 存储值
 * (daemon 已按字段钳制下发到 configValues);每次变更先乐观更新本地,
 * 再经 extensions.setConfig 落盘——失败回滚该键并显示错误,成功按字段的
 * restart 声明提示生效时机。
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

/** 插件模块行（dsh 插件条目 parity：**整条**是一个信息丰富的可点击卡片
 *  ——图标 + 状态点 + 名称 + kind/组件数标签 + 描述都在点击区内，悬停整卡
 *  高亮；只有右侧开关独占点击（stopPropagation）。能力中心「插件」tab
 *  复用（导出共享）。 */
export function ModuleRow({
	e,
	rpc,
	busy,
	onToggle,
	onOpen,
}: {
	e: ExtensionItem;
	rpc: RpcClient | null;
	busy: boolean;
	onToggle(item: ExtensionItem): void;
	onOpen(item: ExtensionItem): void;
}): ReactNode {
	return (
		<div
			className="gui-ext-provider gui-ext-provider--btn"
			role="button"
			tabIndex={0}
			aria-label={`${t("ext open plugin details")} · ${builtinDisplayName(e)}`}
			onClick={() => onOpen(e)}
			onKeyDown={ev => {
				if (ev.key === "Enter" || ev.key === " ") {
					ev.preventDefault();
					onOpen(e);
				}
			}}
		>
			<div className="gui-ext-provider-h">
				<PluginIcon
					name={builtinDisplayName(e)}
					icon={kindGlyph(e.kind)}
					size={24}
					status={
						e.loadError ? "error" : e.state === "active" ? "active" : e.state === "shadowed" ? "shadowed" : "off"
					}
				/>
				<span className="min-w-0 flex-1 truncate text-[12px] font-medium">{builtinDisplayName(e)}</span>
				<span className="gui-ext-item-tag">{kindTag(e.kind)}</span>
				{e.enabledInPresets && e.enabledInPresets.length > 0 && (
					<span className="gui-ext-item-tag gui-ext-item-tag--preset">{t("ext preset tag")}</span>
				)}
				{e.components && e.components.length > 0 && (
					<span className="gui-ext-item-tag">{t("ext component count", { count: e.components.length })}</span>
				)}
				{e.loadError && <span className="gui-ext-item-tag gui-ext-item-tag--err">{t("ext load failed")}</span>}
				{/* 只读展示项(主题包/渲染器包/终端):无禁用语义,不渲染
				 * 死开关——禁用不会改变运行时,放个可点的开关是撒谎。 */}
				{!e.readonly && (
					<button
						type="button"
						role="switch"
						aria-checked={e.state === "active"}
						aria-label={
							e.state === "active" ? `${t("disable skill")} ${e.name}` : `${t("enable skill")} ${e.name}`
						}
						className={`gui-toggle gui-toggle--sm${e.state === "active" ? " gui-toggle--on" : ""}`}
						disabled={!rpc || busy}
						onClick={ev => {
							ev.stopPropagation();
							onToggle(e);
						}}
					>
						<span className="gui-toggle-knob" />
					</button>
				)}
			</div>
			{e.description ? <div className="gui-ext-plugins-desc">{builtinDescription(e)}</div> : null}
		</div>
	);
}

/** 插件模块卡片（cards variant / 设置插件分区共用）：图标 + 状态点 +
 *  显示名 + 描述 + 状态/id 脚注，点击打开详情弹层。
 *  启停开关与插件包卡片同一口径——一张卡片若只读不可停，管理面就出现
 *  「这一行管不了」的裂缝（只读展示项由 readonly 把关，不渲染死开关）。 */
export function ModuleCard({
	e,
	rpc,
	busy,
	onOpen,
	onToggle,
}: {
	e: ExtensionItem;
	rpc: RpcClient | null;
	busy: boolean;
	onOpen(item: ExtensionItem): void;
	onToggle(item: ExtensionItem): void;
}): ReactNode {
	return (
		<div
			role="button"
			tabIndex={0}
			className="gui-plugin-card"
			aria-label={`${t("ext open plugin details")} · ${builtinDisplayName(e)}`}
			onClick={() => onOpen(e)}
			onKeyDown={ev => {
				if (ev.key === "Enter" || ev.key === " ") {
					ev.preventDefault();
					onOpen(e);
				}
			}}
		>
			<div className="gui-plugin-card-head">
				<PluginIcon
					name={builtinDisplayName(e)}
					icon={kindGlyph(e.kind)}
					status={
						e.loadError ? "error" : e.state === "active" ? "active" : e.state === "shadowed" ? "shadowed" : "off"
					}
				/>
				<span className="gui-plugin-card-name min-w-0 flex-1 truncate">{builtinDisplayName(e)}</span>
				{!e.readonly && (
					<button
						type="button"
						role="switch"
						aria-checked={e.state === "active"}
						aria-label={
							e.state === "active" ? `${t("disable skill")} ${e.name}` : `${t("enable skill")} ${e.name}`
						}
						className={`gui-toggle gui-toggle--sm${e.state === "active" ? " gui-toggle--on" : ""}`}
						disabled={!rpc || busy}
						onClick={ev => {
							ev.stopPropagation();
							onToggle(e);
						}}
					>
						<span className="gui-toggle-knob" />
					</button>
				)}
				<Icon name="arrow-right-s" className="h-3.5 w-3.5 shrink-0 opacity-40" />
			</div>
			{builtinDescription(e) ? <div className="gui-plugin-card-desc">{builtinDescription(e)}</div> : null}
			<div className="gui-plugin-card-foot">
				{e.enabledInPresets && e.enabledInPresets.length > 0 && (
					<span className="gui-ext-item-tag gui-ext-item-tag--preset">{t("ext preset tag")}</span>
				)}
				<span className="gui-ext-item-tag">{pluginStateLabel(e)}</span>
				<span className="gui-ext-item-tag">{e.id}</span>
			</div>
		</div>
	);
}

/** dsh 面板搜索匹配：大小写不敏感子串，命中任一文本面即算。 */
function matchesQuery(texts: (string | null | undefined)[], q: string): boolean {
	return q.length === 0 || texts.some(v => v?.toLocaleLowerCase().includes(q));
}

export function UnifiedPluginsView({
	rpc,
	plugins,
	pluginsError,
	onTogglePackage,
	onOpenMarketplace,
	onError,
	onPackagesRefreshed,
	variant = "list",
}: {
	rpc: RpcClient | null;
	plugins: PluginPackageEntry[];
	pluginsError: string | null;
	onTogglePackage(p: PluginPackageEntry): void;
	onOpenMarketplace(): void;
	/** 模块开关/组件开关的错误出口（父级顶栏 error 横幅）。 */
	onError(message: string | null): void;
	/** 父级持有插件包清单；spec 安装完成后由本视图回读并交给它替换。 */
	onPackagesRefreshed?(packages: PluginPackageEntry[]): void;
	/** list = dsh 插件列表面板（能力中心,管理导向:分组行+开关）;
	 *  cards = 卡片网格（扩展中心,发现导向,与设置插件分区同款）。 */
	variant?: "list" | "cards";
}): ReactNode {
	const data = useExtensionRegistry(rpc);
	// 防双击：一次只允许一个模块开关在途。插件包开关由父级 own。
	const [busyId, setBusyId] = useState<string | null>(null);
	// dsh 面板搜索：匹配名称/显示名/id/描述（大小写不敏感）。
	const [query, setQuery] = useState("");
	// 详情弹层（dsh 插件详情 parity；行点击打开,同一时刻至多一个）。
	const [detailId, setDetailId] = useState<string | null>(null);
	// spec 安装弹层：marketplace 只覆盖已收录的包,自建/未发布的插件走这条。
	const [installOpen, setInstallOpen] = useState(false);
	// 卸载在途标记（卡片直卸 + 详情弹层卸载共用,一次一个）。
	const [uninstallBusy, setUninstallBusy] = useState(false);
	const { confirm } = useConfirm();
	/**
	 * Presets, for the by-preset grouping.
	 *
	 * A preset is a plugin composition, and this list is where a user asks "what
	 * would switching preset change?". Reading it here rather than through the
	 * parent keeps the one view that needs the composition responsible for it —
	 * the other tabs show installed things, not declared ones.
	 */
	const [presets, setPresets] = useState<PresetRow[]>([]);
	useEffect(() => {
		if (!rpc) return;
		let live = true;
		void rpc
			.request<{ modes: PresetRow[] } | null>("modes.list", {})
			.then(res => {
				if (live) setPresets((res?.modes ?? []).filter(p => (p.plugins ?? []).length > 0));
			})
			.catch(() => {
				// The preset plane is additive: the flat list still renders without it.
			});
		return () => {
			live = false;
		};
	}, [rpc]);
	/**
	 * Re-read the installed packages after a spec install or uninstall.
	 *
	 * The install ran on the daemon and the list this view renders came from the
	 * parent, so a completed install would otherwise leave the new package
	 * invisible until the settings panel was reopened. The daemon broadcasts
	 * `plugins.install.state`; this reads the authoritative list rather than
	 * patching the parent's copy from the install's own view of the result.
	 */
	const refreshPackages = useCallback((): void => {
		if (!rpc) return;
		void rpc
			.request<{ packages: PluginPackageEntry[] }>("plugins.packages")
			.then(res => onPackagesRefreshed?.(res?.packages ?? []))
			.catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)));
	}, [rpc, onError, onPackagesRefreshed]);

	/** Uninstall one package (plugins.uninstall) and refresh the list. */
	const uninstallPackage = useCallback(
		async (p: PluginPackageEntry): Promise<void> => {
			if (!rpc) return;
			setUninstallBusy(true);
			try {
				await rpc.request("plugins.uninstall", { name: p.name });
				onError(null);
				refreshPackages();
			} catch (err) {
				onError(err instanceof Error ? err.message : String(err));
			} finally {
				setUninstallBusy(false);
			}
		},
		[rpc, onError, refreshPackages],
	);

	/** 卸载是删除性的：先确认再执行。 */
	const uninstallWithConfirm = useCallback(
		(p: PluginPackageEntry): void => {
			void confirm(t("plugin uninstall confirm", { name: p.name }), t("uninstall")).then(ok => {
				if (ok) void uninstallPackage(p);
			});
		},
		[confirm, uninstallPackage],
	);
	/**
	 * Re-read the installed packages after a spec install.
	 *
	 * The install ran on the daemon and the list this view renders came from the
	 * parent, so a completed install would otherwise leave the new package
	 * invisible until the settings panel was reopened. The daemon broadcasts
	 * `plugins.install.state`; this reads the authoritative list rather than
	 * patching the parent's copy from the install's own view of the result.
	 */
	// 模块 lane：真实插件模块 + 内置插件单元（isPluginLaneEntry 单一权威，
	// 与 ExtensionsCenter tab 计数同口径）。其余 kind（skill/tool/mcp/…）
	// 在能力清单 tab 有完整 provider→kind→item 树，这里不重复。
	const modules = useMemo(() => (data?.extensions ?? []).filter(isPluginLaneEntry), [data]);
	// dsh 分组：官方 = 内置插件单元；已安装 = 插件包 + 用户级模块。
	const normalizedQuery = query.trim().toLocaleLowerCase();
	const official = useMemo(
		() =>
			modules.filter(
				e =>
					e.builtin &&
					matchesQuery([e.name, e.displayName, e.id, e.description, builtinDescription(e)], normalizedQuery),
			),
		[modules, normalizedQuery],
	);
	const installedModules = useMemo(
		() =>
			modules.filter(
				e =>
					!e.builtin &&
					matchesQuery([e.name, e.displayName, e.id, e.description, builtinDescription(e)], normalizedQuery),
			),
		[modules, normalizedQuery],
	);
	const filteredPackages = useMemo(
		() => plugins.filter(p => matchesQuery([p.name, p.description, p.path], normalizedQuery)),
		[plugins, normalizedQuery],
	);
	/**
	 * The same installed things, seen through each preset's composition.
	 *
	 * Ordered before the flat groups because a preset is the thing a user switches
	 * between, and "which plugins does this preset bring" is the question the flat
	 * list cannot answer. A composition row may name a package or a module, so it
	 * is matched against both — a row that matched only one spelling would show an
	 * empty group for a preset that plainly composes something.
	 */
	const presetGroups = useMemo(
		() =>
			presets
				.map(preset => {
					const rows = (preset.plugins ?? []).filter(row => row.enabled !== false);
					const names = new Set(rows.map(row => row.name));
					return {
						preset,
						packages: filteredPackages.filter(p => names.has(p.name)),
						modules: modules.filter(e => names.has(e.name) || names.has(e.displayName) || names.has(e.id)),
					};
				})
				.filter(group => group.packages.length > 0 || group.modules.length > 0),
		[presets, filteredPackages, modules],
	);
	const detailItem = detailId ? (modules.find(e => e.id === detailId) ?? null) : null;

	// 一个插件包 + 它目录下的扩展模块是同一个插件的两条链路 —— 包是列表的
	// 唯一条目，模块收进包详情弹层的「包含的组件」。模块路径在包目录下即归
	// 该包（module path = <pkg>/index.ts）。未归属任何已安装包的用户级模块
	// 保留自己的行（裸加载的 extension 不经 node_modules）。
	const packagedModules = useMemo(
		() => installedModules.filter(e => filteredPackages.some(p => isPathInside(e.path, p.path))),
		[installedModules, filteredPackages],
	);
	const standaloneModules = useMemo(() => {
		const packaged = new Set(packagedModules.map(e => e.id));
		return installedModules.filter(e => !packaged.has(e.id));
	}, [installedModules, packagedModules]);
	// 当前详情弹层打开的包 + 归属它的模块与设置组件。
	const [packageDetail, setPackageDetail] = useState<PluginPackageEntry | null>(null);
	const packageModules = useMemo(
		() => (packageDetail ? installedModules.filter(e => isPathInside(e.path, packageDetail.path)) : []),
		[packageDetail, installedModules],
	);
	const packageComponents = useMemo(
		() =>
			packageDetail ? (data?.components ?? []).filter(c => isPathInside(c.extensionId, packageDetail.path)) : [],
		[packageDetail, data],
	);

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
			{/* dsh 面板顶栏：搜索 + 计数 + 「+ 添加插件」 */}
			<div className="gui-ext-plugins-toolbar">
				<label className="gui-ext-plugins-search">
					<Icon name="search" className="h-3.5 w-3.5 shrink-0 opacity-50" />
					<input
						type="search"
						value={query}
						placeholder={t("ext search plugins")}
						aria-label={t("ext search plugins")}
						onChange={event => setQuery(event.currentTarget.value)}
					/>
				</label>
				<span className="gui-ext-plugins-toolbar-count">
					{t("ext plugins official")} {official.length} · {t("ext plugins installed")}{" "}
					{filteredPackages.length + standaloneModules.length}
				</span>
				<button type="button" className="gui-btn gui-btn--sm" onClick={onOpenMarketplace}>
					<Icon name="add" className="h-3.5 w-3.5" />
					{t("ext add plugin")}
				</button>
				{/* 市场只收录已发布的包；自建插件、压缩包与本机目录从这里进。 */}
				<button type="button" className="gui-btn gui-btn--sm" onClick={() => setInstallOpen(true)}>
					<Icon name="download" className="h-3.5 w-3.5" />
					{t("plugin install title")}
				</button>
			</div>
			{pluginsError && <div className="gui-ext-plugins-error">{pluginsError}</div>}
			{normalizedQuery.length > 0 &&
				official.length === 0 &&
				filteredPackages.length === 0 &&
				standaloneModules.length === 0 && <div className="gui-ext-plugins-error">{t("no matches")}</div>}
			{variant === "cards" ? (
				<div className="gui-ext-list-scroll">
					{official.length > 0 && (
						<div className="gui-ext-group">
							<div className="gui-ext-group-title">
								{t("ext plugins official")} · {official.length}
							</div>
							<div className="gui-plugin-cards">
								{official.map(e => (
									<ModuleCard
										key={e.id}
										e={e}
										rpc={rpc}
										busy={busyId !== null}
										onOpen={item => setDetailId(item.id)}
										onToggle={toggleModule}
									/>
								))}
							</div>
						</div>
					)}
					{(filteredPackages.length > 0 || standaloneModules.length > 0) && (
						<div className="gui-ext-group">
							<div className="gui-ext-group-title">
								{t("ext plugins installed")} · {filteredPackages.length + standaloneModules.length}
							</div>
							{filteredPackages.length > 0 && (
								<div className="gui-plugin-cards">
									{filteredPackages.map(p => (
										<div
											key={p.path}
											className="gui-plugin-card"
											role="button"
											tabIndex={0}
											onClick={() => setPackageDetail(p)}
											onKeyDown={e => {
												if (e.key === "Enter" || e.key === " ") {
													e.preventDefault();
													setPackageDetail(p);
												}
											}}
										>
											<div className="gui-plugin-card-head">
												<PluginIcon name={p.name} icon={p.icon} status={p.enabled ? "active" : "off"} />
												<span className="gui-plugin-card-name min-w-0 flex-1 truncate">{p.name}</span>
												<button
													type="button"
													role="switch"
													aria-checked={p.enabled}
													aria-label={`${t("plugin enable")} ${p.name}`}
													className={`gui-toggle gui-toggle--sm${p.enabled ? " gui-toggle--on" : ""}`}
													onClick={e => {
														e.stopPropagation();
														onTogglePackage(p);
													}}
												>
													<span className="gui-toggle-knob" />
												</button>
											</div>
											{p.description ? <div className="gui-plugin-card-desc">{p.description}</div> : null}
											<div className="gui-plugin-card-foot">
												<span className="gui-ext-item-tag">{t("plugin package tag")}</span>
												<span className="gui-ext-item-tag">{sourceLevelLabel("omp-plugins", p.scope)}</span>
												<span className="gui-ext-item-tag">{`v${p.version}`}</span>
												<span style={{ marginLeft: "auto" }}>
													<button
														type="button"
														className="gui-icon-btn"
														disabled={uninstallBusy}
														title={t("uninstall")}
														aria-label={`${t("uninstall")} ${p.name}`}
														onClick={e => {
															e.stopPropagation();
															uninstallWithConfirm(p);
														}}
													>
														<Icon name="delete-bin" className="h-3.5 w-3.5" />
													</button>
												</span>
											</div>
										</div>
									))}
								</div>
							)}
							<div className="gui-plugin-cards">
								{standaloneModules.map(e => (
									<ModuleCard
										key={e.id}
										e={e}
										rpc={rpc}
										busy={busyId !== null}
										onOpen={item => setDetailId(item.id)}
										onToggle={toggleModule}
									/>
								))}
							</div>
						</div>
					)}
				</div>
			) : (
				<div className="gui-ext-list-scroll">
					{/* Presets first: they are what a user switches between, and the flat
					 * groups below cannot answer "which plugins does this preset bring".
					 * Read-only membership — a preset's rows are edited in its own
					 * definition, and a switch here would have nowhere to write. */}
					{presetGroups.map(({ preset, packages, modules: presetModules }) => (
						<div className="gui-ext-group" key={preset.id}>
							<div className="gui-ext-group-title">
								{t("tools.extPluginsPresetGroup", { name: preset.label })} ·{" "}
								{packages.length + presetModules.length}
							</div>
							{packages.map(p => (
								<div
									key={`pkg:${p.path}`}
									className="gui-ext-provider gui-ext-provider--btn"
									role="button"
									tabIndex={0}
									onClick={() => setPackageDetail(p)}
									onKeyDown={e => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault();
											setPackageDetail(p);
										}
									}}
								>
									<div className="gui-ext-provider-h">
										<PluginIcon name={p.name} icon={p.icon} size={24} status={p.enabled ? "active" : "off"} />
										<span className="gui-plugin-card-name min-w-0 flex-1 truncate">{p.name}</span>
										<span className="gui-ext-item-tag">{t("tools.pluginPackageTag")}</span>
									</div>
								</div>
							))}
							{presetModules.map(e => (
								<ModuleRow
									key={`mod:${e.id}`}
									e={e}
									rpc={rpc}
									busy={busyId !== null}
									onToggle={toggleModule}
									onOpen={item => setDetailId(item.id)}
								/>
							))}
						</div>
					))}
					{official.length > 0 && (
						<div className="gui-ext-group">
							<div className="gui-ext-group-title">
								{t("ext plugins official")} · {official.length}
							</div>
							{official.map(e => (
								<ModuleRow
									key={e.id}
									e={e}
									rpc={rpc}
									busy={busyId !== null}
									onToggle={toggleModule}
									onOpen={item => setDetailId(item.id)}
								/>
							))}
						</div>
					)}
					{(filteredPackages.length > 0 || standaloneModules.length > 0) && (
						<div className="gui-ext-group">
							<div className="gui-ext-group-title">
								{t("ext plugins installed")} · {filteredPackages.length + standaloneModules.length}
							</div>
							{filteredPackages.map(p => (
								<div
									key={p.path}
									className="gui-ext-provider"
									role="button"
									tabIndex={0}
									onClick={() => setPackageDetail(p)}
									onKeyDown={e => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault();
											setPackageDetail(p);
										}
									}}
								>
									<div className="gui-ext-provider-h">
										<PluginIcon name={p.name} icon={p.icon} size={24} status={p.enabled ? "active" : "off"} />
										<span className="gui-plugin-card-name min-w-0 flex-1 truncate">{p.name}</span>
										<span className="gui-ext-item-tag">{t("plugin package tag")}</span>
										<span className="gui-ext-item-tag">{sourceLevelLabel("omp-plugins", p.scope)}</span>
										<button
											type="button"
											className="gui-icon-btn"
											disabled={uninstallBusy}
											title={t("uninstall")}
											aria-label={`${t("uninstall")} ${p.name}`}
											onClick={e => {
												e.stopPropagation();
												uninstallWithConfirm(p);
											}}
										>
											<Icon name="delete-bin" className="h-3.5 w-3.5" />
										</button>
										<button
											type="button"
											role="switch"
											aria-checked={p.enabled}
											aria-label={`${t("plugin enable")} ${p.name}`}
											className={`gui-toggle gui-toggle--sm${p.enabled ? " gui-toggle--on" : ""}`}
											onClick={e => {
												e.stopPropagation();
												onTogglePackage(p);
											}}
										>
											{/* Knob span required: the thumb is a child element,
											 * not a pseudo-element — empty buttons lose the dot. */}
											<span className="gui-toggle-knob" />
										</button>
									</div>
									<div className="gui-ext-plugins-meta">
										<span className="gui-ext-plugins-version">{`v${p.version}`}</span>
										<span className="gui-ext-group-count">
											{t("plugin counts", { tools: p.tools, commands: p.commands, handlers: p.handlers })}
										</span>
									</div>
									{p.description ? <div className="gui-ext-plugins-desc">{p.description}</div> : null}
								</div>
							))}
							{standaloneModules.map(e => (
								<ModuleRow
									key={e.id}
									e={e}
									rpc={rpc}
									busy={busyId !== null}
									onToggle={toggleModule}
									onOpen={item => setDetailId(item.id)}
								/>
							))}
						</div>
					)}
				</div>
			)}
			<PluginDetailDialog
				open={detailItem !== null}
				onClose={() => setDetailId(null)}
				item={detailItem}
				rpc={rpc}
				onError={onError}
				onToggle={toggleModule}
				toggleBusy={busyId !== null}
			/>
			<PluginInstallDialog
				rpc={rpc}
				open={installOpen}
				onClose={() => setInstallOpen(false)}
				onInstalled={refreshPackages}
			/>
			<PluginPackageDialog
				open={packageDetail !== null}
				onClose={() => setPackageDetail(null)}
				pkg={packageDetail}
				modules={packageModules}
				components={packageComponents}
				busy={busyId !== null}
				uninstalling={uninstallBusy}
				onUninstall={uninstallPackage}
				onTogglePackage={onTogglePackage}
				onToggleModule={toggleModule}
				onError={onError}
				rpc={rpc}
			/>
		</div>
	);
}
