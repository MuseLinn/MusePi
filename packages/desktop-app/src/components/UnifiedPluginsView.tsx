import { t } from "@musepi/client-core";
import { coerceConfigValues } from "@musepi/pi-wire";
import { type ReactNode, useCallback, useMemo, useState } from "react";
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
 * （extensions.list 的 kind=plugin-module / extension-module）同屏汇总，
 * 布局对齐 dsh 插件列表面板。两个入口按 dsh 的层级分开：
 * - 能力中心（variant="list"）：manage 层——可启停或可配置的官方插件 +
 *   已安装/自建插件，紧凑行，只留实验性/状态/版本；
 * - 设置 → 扩展与插件（variant="cards"）：完整库存——含只读提示词/渲染
 *   包与预设专用 persona，行内带 id、只读/预设专用、配置/组件数等技术
 *   身份，是管理/诊断面。
 * - 行：图标 + 名称 + 一行描述 + 右侧启停开关;
 * - 点击行打开插件详情液态玻璃弹层（PluginDetailDialog）——配置表单、
 *   资源卡与「包含的组件」独立开关都在弹层内,不跳转页面;
 * - 顶栏「+ 添加插件」进 marketplace。
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
	experimental?: boolean;
	/** Manifest-declared icon: emoji, text glyph, or http(s)/file URI. */
	icon: string | null;
	/** Bundle enablement is the profile selection; package enablement is the runtime lock. */
	management?: "package" | "bundle";
	/** False for a selected bundle whose package or patch cannot be read. */
	readable?: boolean;
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
		return t("tools.skillFilterBuiltin");
	}
	// builtin-registry 条目：musepi-extensions provider + native level。
	if (provider === "musepi-extensions" && level === "native") {
		return t("tools.skillFilterBuiltin");
	}
	return level === "project" ? t("tools.skillFilterProject") : t("tools.skillFilterUser");
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
	// 两条轨道都算插件模块行（kind 拆分见 capability/module-entry.ts）。
	if (e.kind === "plugin-module" || e.kind === "extension-module") return true;
	return e.source.provider === "musepi-extensions" && e.source.level === "native" && e.kind !== "skill";
}

/**
 * 官方插件在两个入口的分层（dsh 的「插件」页 vs「插件列表」库存）：
 * - manage：能力中心——用户能启停或配置的官方插件；
 * - inventory：设置里的完整库存——只读提示词/渲染包、预设专用 persona
 *   这类没有用户动作的单元。
 *
 * 判定只吃清单事实（presetOnly / readonly / config / components），不维护
 * 第二份插件名单：清单新增字段时两侧自动跟随。
 */
export type PluginSurface = "manage" | "inventory";

export function pluginSurface(e: ExtensionItem): PluginSurface {
	if (!e.builtin) return "manage";
	if (e.presetOnly) return "inventory";
	const actionable = (e.config?.length ?? 0) > 0 || (e.components?.length ?? 0) > 0;
	return e.readonly && !actionable ? "inventory" : "manage";
}

/** 一个入口要展示的官方条目：能力中心只取 manage，设置取完整库存。 */
export function officialPluginsFor(variant: "list" | "cards", modules: ExtensionItem[]): ExtensionItem[] {
	const lane =
		variant === "list" ? modules.filter(e => e.kind === "plugin-module" || e.kind === "extension-module") : modules;
	return lane.filter(e => e.builtin && (variant === "cards" || pluginSurface(e) === "manage"));
}

/** 条目状态标签（ExtensionsCenter detail pane 同款语义单一权威——
 * 加载失败是制胜相位（dsh PluginInventory parity）：条目在配置里可能
 * 名义 active，但实际什么都没注册。 */
export function pluginStateLabel(e: ExtensionItem): string {
	if (e.loadError) return t("tools.extLoadFailed");
	if (e.state === "active") return t("tools.extensionActive");
	if (e.state === "shadowed") return t("tools.extShadowed");
	return e.disabledReason === "provider-disabled" ? t("tools.extProviderDisabled") : t("tools.extItemDisabled");
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
						? ` · ${desc.restart === "session" ? t("tools.extRestartSession") : t("tools.extRestartDaemon")}`
						: "";
				setNotice({ kind: "saved", text: `${t("tools.extConfigSaved")}${hint}` });
			})
			.catch((err: unknown) => {
				setValues(prev => ({ ...prev, [key]: previous }));
				setNotice({ kind: "error", text: `${t("tools.extConfigSaveFailed")}: ${String(err)}` });
			});
	};

	return (
		<>
			{item.configErrors && item.configErrors.length > 0 && (
				<div className="gui-ext-detail-loaderror">
					<Icon name="alert" className="h-3.5 w-3.5 shrink-0" />
					<span className="min-w-0 truncate">
						{t("tools.extConfigErrors", { count: item.configErrors.length })}
					</span>
				</div>
			)}
			{item.config && item.config.length > 0 && (
				<div className="gui-ext-detail-section">
					<div className="gui-ext-detail-label">{t("tools.extPluginConfig")}</div>
					<div className="gui-plugin-config-desc">{t("tools.extPluginConfigDesc")}</div>
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
					<div className="gui-ext-detail-label">{t("tools.extPluginResources")}</div>
					<div className="gui-plugin-resources">
						{resources.disk && (
							<div className="gui-plugin-resource-row">
								<span className="gui-plugin-resource-key">{t("tools.extResourcesDisk")}</span>
								<span className="gui-plugin-resource-value">{resources.disk}</span>
							</div>
						)}
						{resources.memory && (
							<div className="gui-plugin-resource-row">
								<span className="gui-plugin-resource-key">{t("tools.extResourcesMemory")}</span>
								<span className="gui-plugin-resource-value">{resources.memory}</span>
							</div>
						)}
						{typeof resources.setupMinutes === "number" && (
							<div className="gui-plugin-resource-row">
								<span className="gui-plugin-resource-key">{t("tools.extResourcesSetup")}</span>
								<span className="gui-plugin-resource-value">{resources.setupMinutes}</span>
							</div>
						)}
						{resources.models && resources.models.length > 0 && (
							<div className="gui-plugin-resource-row">
								<span className="gui-plugin-resource-key">{t("tools.extResourcesModels")}</span>
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

/** Shared horizontal geometry for package and module cards. Only the content
 * and actions vary; click and keyboard behavior stay identical in every view. */
function PluginHorizontalCard({
	name,
	description,
	icon,
	tags,
	actions,
	onOpen,
}: {
	name: string;
	description?: string | null;
	icon: ReactNode;
	tags?: ReactNode;
	actions?: ReactNode;
	onOpen(): void;
}): ReactNode {
	return (
		<div
			className="gui-plugin-card"
			role="button"
			tabIndex={0}
			aria-label={`${t("tools.extOpenPluginDetails")} · ${name}`}
			onClick={onOpen}
			onKeyDown={event => {
				if (event.target !== event.currentTarget) return;
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onOpen();
				}
			}}
		>
			<div className="gui-plugin-card-icon">{icon}</div>
			<div className="gui-plugin-card-content">
				<div className="gui-plugin-card-name" title={name}>
					{name}
				</div>
				<div className="gui-plugin-card-desc">{description}</div>
				<div className="gui-plugin-card-foot">{tags}</div>
			</div>
			<div className="gui-plugin-card-actions">
				{actions}
				<Icon name="arrow-right-s" className="h-3.5 w-3.5 shrink-0 opacity-40" />
			</div>
		</div>
	);
}

interface ModuleCardProps {
	e: ExtensionItem;
	rpc: RpcClient | null;
	busy: boolean;
	onOpen(item: ExtensionItem): void;
	onToggle(item: ExtensionItem): void;
	/** 设置里的完整库存：带上技术身份（id、只读/预设专用、配置/组件数）。
	 *  能力中心只留用户能判断的状态与版本。 */
	detail?: boolean;
}

function ModulePluginCard({ e, rpc, busy, onOpen, onToggle, detail = false }: ModuleCardProps): ReactNode {
	const name = builtinDisplayName(e);
	const configCount = e.config?.length ?? 0;
	const componentCount = e.components?.length ?? 0;
	return (
		<PluginHorizontalCard
			name={name}
			description={builtinDescription(e)}
			icon={
				<PluginIcon
					name={name}
					icon={e.icon ?? kindGlyph(e.kind)}
					size={26}
					status={
						e.loadError ? "error" : e.state === "active" ? "active" : e.state === "shadowed" ? "shadowed" : "off"
					}
				/>
			}
			tags={
				<>
					{e.experimental && (
						<span className="gui-ext-item-tag gui-ext-item-tag--experimental">{t("tools.extExperimental")}</span>
					)}
					{detail && e.presetOnly && <span className="gui-ext-item-tag">{t("tools.extPresetOnlyTag")}</span>}
					{detail && e.readonly && <span className="gui-ext-item-tag">{t("tools.extReadonlyTag")}</span>}
					{e.enabledInPresets && e.enabledInPresets.length > 0 && (
						<span className="gui-ext-item-tag gui-ext-item-tag--preset">{t("tools.extPresetTag")}</span>
					)}
					<span className={`gui-ext-item-tag${e.loadError ? " gui-ext-item-tag--err" : ""}`}>
						{pluginStateLabel(e)}
					</span>
					{detail && <span className="gui-ext-item-tag">{e.id}</span>}
					{e.version && <span className="gui-ext-item-tag">{`v${e.version}`}</span>}
					{detail && configCount > 0 && (
						<span className="gui-ext-item-tag">{t("tools.extConfigCount", { count: configCount })}</span>
					)}
					{detail && componentCount > 0 && (
						<span className="gui-ext-item-tag">{t("tools.extComponentCount", { count: componentCount })}</span>
					)}
				</>
			}
			actions={
				!e.readonly ? (
					<button
						type="button"
						role="switch"
						aria-checked={e.state === "active"}
						aria-label={`${e.state === "active" ? t("tools.disableSkill") : t("tools.enableSkill")} ${e.name}`}
						className={`gui-toggle gui-toggle--sm${e.state === "active" ? " gui-toggle--on" : ""}`}
						disabled={!rpc || busy}
						onClick={event => {
							event.stopPropagation();
							onToggle(e);
						}}
					>
						<span className="gui-toggle-knob" />
					</button>
				) : undefined
			}
			onOpen={() => onOpen(e)}
		/>
	);
}

/** List and grid variants intentionally export the same card implementation. */
export function ModuleRow(props: ModuleCardProps): ReactNode {
	return <ModulePluginCard {...props} />;
}

export function ModuleCard(props: ModuleCardProps): ReactNode {
	return <ModulePluginCard {...props} />;
}

function PackagePluginCard({
	pkg,
	uninstallBusy,
	onOpen,
	onToggle,
	onUninstall,
	detail = false,
}: {
	pkg: PluginPackageEntry;
	uninstallBusy: boolean;
	onOpen(): void;
	onToggle(): void;
	onUninstall(): void;
	detail?: boolean;
}): ReactNode {
	return (
		<PluginHorizontalCard
			name={pkg.name}
			description={pkg.description}
			icon={<PluginIcon name={pkg.name} icon={pkg.icon} size={26} status={pkg.enabled ? "active" : "off"} />}
			tags={
				<>
					{pkg.experimental && (
						<span className="gui-ext-item-tag gui-ext-item-tag--experimental">{t("tools.extExperimental")}</span>
					)}
					<span className="gui-ext-item-tag">{t("tools.pluginPackageTag")}</span>
					{detail && pkg.readable === false && (
						<span className="gui-ext-item-tag">{t("tools.bundleUnreadable" as Parameters<typeof t>[0])}</span>
					)}
					{detail && <span className="gui-ext-item-tag">{sourceLevelLabel("omp-plugins", pkg.scope)}</span>}
					<span className="gui-ext-item-tag">{`v${pkg.version}`}</span>
				</>
			}
			actions={
				<>
					<button
						type="button"
						className="gui-icon-btn"
						disabled={uninstallBusy}
						title={t("tools.uninstall")}
						aria-label={`${t("tools.uninstall")} ${pkg.name}`}
						onClick={event => {
							event.stopPropagation();
							onUninstall();
						}}
					>
						<Icon name="delete-bin" className="h-3.5 w-3.5" />
					</button>
					<button
						type="button"
						role="switch"
						aria-checked={pkg.enabled}
						aria-label={`${t("tools.pluginEnable")} ${pkg.name}`}
						className={`gui-toggle gui-toggle--sm${pkg.enabled ? " gui-toggle--on" : ""}`}
						onClick={event => {
							event.stopPropagation();
							onToggle();
						}}
					>
						<span className="gui-toggle-knob" />
					</button>
				</>
			}
			onOpen={onOpen}
		/>
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
	/** list = 能力中心的插件列表：只列真实插件模块（内置几个 + 用户
	 *  安装/自建）与插件包；cards = 设置 → 扩展与插件：完整库存（含内置
	 *  插件单元），管理导向。 */
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
			void confirm(t("tools.pluginUninstallConfirm", { name: p.name }), t("tools.uninstall"), {
				destructive: true,
			}).then(ok => {
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
	// 两个入口的官方清单不同层：能力中心只收 manage（可启停/可配置），
	// 设置里的扩展与插件是完整库存（含只读单元与预设专用 persona）。
	const officialPool = useMemo(() => officialPluginsFor(variant, modules), [modules, variant]);
	const official = useMemo(
		() =>
			officialPool.filter(e =>
				matchesQuery([e.name, e.displayName, e.id, e.description, builtinDescription(e)], normalizedQuery),
			),
		[officialPool, normalizedQuery],
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

	// 两个入口的官方分组标题不同名：能力中心是「官方」，设置是完整「内置插件」。
	const officialLabel = variant === "cards" ? t("tools.extPluginsBuiltin") : t("tools.extPluginsOfficial");

	// 双清空才是真空态：任一链路有货就展示统一清单。能力中心按 manage 层
	// 计数——只有只读库存时不该声称「已加载插件」。
	if (plugins.length === 0 && officialPool.length === 0 && standaloneModules.length === 0 && !pluginsError) {
		return (
			<div className="gui-ext-plugins" data-variant={variant}>
				{/* Empty state with an exit: a bald「未加载插件」read as a
				 * broken page. Both plugin systems now surface here unified —
				 * when even the module lane is empty, say where each comes
				 * from instead of leaving a blank. */}
				<div className="gui-ext-empty-state">
					<Icon name="plug" className="h-5 w-5 opacity-40" />
					<div className="gui-ext-empty-state-title">{t("tools.noPluginsLoaded")}</div>
					<p className="gui-ext-empty-state-desc">{t("tools.pluginsEmptyHint")}</p>
					<p className="gui-ext-empty-state-desc">{t("tools.pluginsEmptyModulesHint")}</p>
					<button type="button" className="gui-btn" onClick={onOpenMarketplace}>
						<Icon name="plug-2" className="h-3.5 w-3.5" />
						{t("tools.goMarketplace")}
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="gui-ext-plugins" data-variant={variant}>
			{/* dsh 面板顶栏：搜索 + 计数 + 「+ 添加插件」 */}
			<div className="gui-ext-plugins-toolbar">
				<label className="gui-ext-plugins-search">
					<Icon name="search" className="h-3.5 w-3.5 shrink-0 opacity-50" />
					<input
						type="search"
						value={query}
						placeholder={t("tools.extSearchPlugins")}
						aria-label={t("tools.extSearchPlugins")}
						onChange={event => setQuery(event.currentTarget.value)}
					/>
				</label>
				<span className="gui-ext-plugins-toolbar-count">
					{officialLabel} {official.length} · {t("tools.extPluginsInstalled")}{" "}
					{filteredPackages.length + standaloneModules.length}
				</span>
				<button type="button" className="gui-btn gui-btn--sm" onClick={onOpenMarketplace}>
					<Icon name="add" className="h-3.5 w-3.5" />
					{t("tools.extAddPlugin")}
				</button>
				{/* 市场只收录已发布的包；自建插件、压缩包与本机目录从这里进。 */}
				<button type="button" className="gui-btn gui-btn--sm" onClick={() => setInstallOpen(true)}>
					<Icon name="download" className="h-3.5 w-3.5" />
					{t("settings.pluginInstallTitle")}
				</button>
			</div>
			<div className="gui-ext-plugins-scope">
				{variant === "cards" ? t("tools.pluginsInventoryScopeHint") : t("tools.pluginsListScopeHint")}
			</div>
			{pluginsError && <div className="gui-ext-plugins-error">{pluginsError}</div>}
			{normalizedQuery.length > 0 &&
				official.length === 0 &&
				filteredPackages.length === 0 &&
				standaloneModules.length === 0 && <div className="gui-ext-plugins-error">{t("tools.noMatches")}</div>}
			{variant === "cards" ? (
				<div className="gui-ext-list-scroll">
					{official.length > 0 && (
						<div className="gui-ext-group">
							<div className="gui-ext-group-title">
								{officialLabel} · {official.length}
							</div>
							<div className="gui-plugin-cards">
								{official.map(e => (
									<ModuleCard
										key={e.id}
										e={e}
										rpc={rpc}
										busy={busyId !== null}
										detail
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
								{t("tools.extPluginsInstalled")} · {filteredPackages.length + standaloneModules.length}
							</div>
							{filteredPackages.length > 0 && (
								<div className="gui-plugin-cards">
									{filteredPackages.map(p => (
										<PackagePluginCard
											key={p.path}
											pkg={p}
											uninstallBusy={uninstallBusy}
											detail
											onOpen={() => setPackageDetail(p)}
											onToggle={() => onTogglePackage(p)}
											onUninstall={() => uninstallWithConfirm(p)}
										/>
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
										detail
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
					{/* Package management stays a two-section list. Preset composition and
					 * failure details remain available in each item's detail dialog; they
					 * must not duplicate every row on the management landing page. */}
					{official.length > 0 && (
						<div className="gui-ext-group">
							<div className="gui-ext-group-title">
								{officialLabel} · {official.length}
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
								{t("tools.extPluginsInstalled")} · {filteredPackages.length + standaloneModules.length}
							</div>
							<div className="gui-plugin-cards">
								{filteredPackages.map(p => (
									<PackagePluginCard
										key={p.path}
										pkg={p}
										uninstallBusy={uninstallBusy}
										onOpen={() => setPackageDetail(p)}
										onToggle={() => onTogglePackage(p)}
										onUninstall={() => uninstallWithConfirm(p)}
									/>
								))}
							</div>
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
