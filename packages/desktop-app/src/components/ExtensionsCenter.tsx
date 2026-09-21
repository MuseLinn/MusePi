import { type MarketplaceCardAction, MarketplaceGrid, type TranslationKey, t } from "@musepi/client-core";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useConfirm } from "../lib/prompt-dialog";
import type { RpcClient } from "../lib/rpc";
import {
	type ExtensionItem,
	type ProviderInfo,
	SETTINGS_ITEM_SLOT_PREFIX,
	type SlotComponent,
	SlotComponentMount,
	useExtensionRegistry,
	useUnhostedSlots,
} from "../lib/slot-host";
import { Icon } from "../vendor/oc-icons";
import { DiagnosticsView } from "./CapabilityCenter";
import { HeightMorph } from "./HeightMorph";
import { StateIcon } from "./StateIcon";
import { type PluginPackageEntry as PluginEntry, sourceLevelLabel, UnifiedPluginsView } from "./UnifiedPluginsView";

/**
 * 扩展控制中心 (extension control center) — TUI /extensions parity in the
 * GUI: one unified inventory over all 10 capability kinds
 * (extension-module / skill / rule / tool / mcp / prompt / instruction /
 * context-file / hook / slash-command), three states (active / disabled /
 * shadowed), provider tabs + provider→kind→item tree + detail pane with
 * raw inspector. Data + mutations come from the daemon extensions.* RPCs,
 * which share the TUI's normalization and persistence (disabledExtensions
 * ids, mcp.json denylist for mcp:, disabledProviders).
 *
 * Data source: the shared useExtensionRegistry singleton (slot-host.tsx) —
 * one 10s poll + extensions.changed instant refresh for the whole GUI.
 * Mutations flip the daemon cache and broadcast extensions.changed, which
 * re-pulls this component; no local polling or optimistic shadow state.
 */

function kindLabel(kind: string): string {
	const key = `ext kind ${kind}`;
	const zh = t(key as TranslationKey);
	return zh === key ? kind : zh;
}

function stateLabel(e: ExtensionItem): string {
	// Load failure is the winning phase (dsh PluginInventory parity): the
	// item may nominally be "active" in config but nothing registered.
	if (e.loadError) return t("ext load failed");
	if (e.state === "active") return t("extension active");
	if (e.state === "shadowed") return t("ext shadowed");
	return e.disabledReason === "provider-disabled" ? t("ext provider disabled") : t("ext item disabled");
}

function levelLabel(s: ExtensionItem): string {
	// 单一权威判定在 UnifiedPluginsView.sourceLevelLabel（插件 tab 与
	// 能力清单的来源标签必须一致，防 drift）。
	return sourceLevelLabel(s.source.provider, s.source.level);
}

/** User-owned skills (user-level files, not native/auto-learn) can be
 *  deleted — mirrors the daemon's skills.delete guard. */
function isDeletable(e: ExtensionItem): boolean {
	return (
		e.kind === "skill" &&
		e.source.level === "user" &&
		e.source.provider !== "native" &&
		e.source.provider !== "musepi-managed"
	);
}

/** GUI-only capability kinds (visual extensions with no TUI-side effect):
 *  motion packs + the built-in style. Tagged with a badge in the list and
 *  the detail pane so users can tell GUI-surface extensions apart. */
function isGuiKind(e: ExtensionItem): boolean {
	return e.kind === "gui-motion" || e.kind === "style";
}

/**
 * 概览 tab (设计稿 2:1427): stats cards (数字 + 副文案) → needs-attention
 * (load errors + shadowed,每行带描述与动作按钮) → provider health
 * (per-source enable switches + 项数副行) → the capability-center CTA.
 * The CONFIG/diagnosis perspective; discovery & install live in the
 * first-class CapabilityCenterPage this CTA opens.
 */
function OverviewView({
	extensions,
	providers,
	unhosted,
	slots,
	onOpenDiagnostics,
	onOpenCapabilityCenter,
	onToggleProvider,
	onForceEnable,
}: {
	extensions: Array<{
		id: string;
		kind: string;
		name: string;
		displayName?: string;
		loadError?: string | null;
		state: string;
		source: { provider: string };
	}>;
	providers: Array<{ id: string; displayName: string; enabled: boolean }>;
	unhosted: string[];
	slots: { exact: readonly string[]; prefixes: readonly string[] } | null;
	onOpenDiagnostics(): void;
	onOpenCapabilityCenter(): void;
	onToggleProvider(p: { id: string; displayName: string; enabled: boolean }): void;
	onForceEnable(e: { id: string }): void;
}): ReactNode {
	const failed = extensions.filter(e => e.loadError);
	const shadowed = extensions.filter(e => e.state === "shadowed");
	const attention = [...failed, ...shadowed].slice(0, 6);
	const activeCount = extensions.filter(e => e.state === "active" && !e.loadError).length;
	const kindCount = new Set(extensions.map(e => e.kind)).size;
	const totalSlots = (slots?.exact.length ?? 0) + (slots?.prefixes.length ?? 0);
	// 来源健康度 skips the `native` provider (TUI buildProviderTabs parity):
	// native IS the app's own config + builtin registry — the inventory tree
	// already surfaces it read-only as 内置, and a「MusePi」row toggling the
	// user's entire native config next to「MusePi Extensions」read as a
	// duplicate source. Only real (toggleable) sources stay listed.
	const managedProviders = providers.filter(p => p.id !== "native");
	const stats: { label: string; value: number; tone?: "err"; sub?: string }[] = [
		{
			label: t("ext stat total"),
			value: extensions.length,
			sub: t("ext stat total sub {kinds} {sources}", { kinds: kindCount, sources: managedProviders.length }),
		},
		{
			label: t("ext stat active"),
			value: activeCount,
			sub: t("ext stat active sub {n}", { n: extensions.length - activeCount }),
		},
		{
			label: t("ext stat failed"),
			value: failed.length,
			tone: failed.length > 0 ? "err" : undefined,
			sub: failed[0]?.displayName ?? failed[0]?.name,
		},
		{
			label: t("ext stat unhosted"),
			value: unhosted.length,
			sub: unhosted.length > 0 ? unhosted.join(", ") : t("ext stat unhosted sub ok {total}", { total: totalSlots }),
		},
	];
	const providerCount = (p: { id: string }): number => extensions.filter(e => e.source.provider === p.id).length;
	return (
		<div className="gui-ext-overview">
			<div className="gui-ext-stat-row">
				{stats.map(s => (
					<div key={s.label} className={`gui-ext-stat-card${s.tone === "err" ? " gui-ext-stat-card--err" : ""}`}>
						<span className="gui-ext-stat-label">{s.label}</span>
						<span className="gui-ext-stat-value">{s.value}</span>
						{s.sub && <span className="gui-ext-stat-sub">{s.sub}</span>}
					</div>
				))}
			</div>
			<div className="gui-ext-overview-section">
				<div className="gui-ext-overview-head">
					<span className="gui-group-label">{t("ext needs attention")}</span>
					<button type="button" className="gui-btn" onClick={onOpenDiagnostics}>
						{t("ext open diagnostics")}
					</button>
				</div>
				{attention.length === 0 ? (
					<div className="gui-ext-empty">{t("ext needs attention empty")}</div>
				) : (
					<div className="gui-ext-overview-rows">
						{attention.map(e => (
							<div key={e.id} className="gui-ext-overview-row">
								<span
									className={`gui-ext-dot${e.loadError ? " gui-ext-dot--error" : " gui-ext-dot--shadowed"}`}
								/>
								<span className="gui-ext-overview-row-text">
									<span className="gui-ext-overview-row-title">{e.displayName ?? e.name}</span>
									{e.loadError && <span className="gui-ext-overview-row-sub">{e.loadError}</span>}
								</span>
								{e.loadError ? (
									<>
										<span className="gui-ext-item-tag gui-ext-item-tag--err">{t("ext load failed")}</span>
										<button type="button" className="gui-btn" onClick={onOpenDiagnostics}>
											{t("ext view details")}
										</button>
									</>
								) : (
									<>
										<span className="gui-ext-item-tag">{t("ext shadowed")}</span>
										<button type="button" className="gui-btn" onClick={() => onForceEnable(e)}>
											{t("force enable")}
										</button>
									</>
								)}
							</div>
						))}
					</div>
				)}
			</div>
			<div className="gui-ext-overview-section">
				<div className="gui-ext-overview-head">
					<span className="gui-group-label">{t("ext provider health")}</span>
				</div>
				<div className="gui-ext-overview-rows">
					{managedProviders.map(p => (
						<div key={p.id} className="gui-ext-overview-row">
							<span className={`gui-ext-dot${p.enabled ? "" : " gui-ext-dot--off"}`} />
							<span className="gui-ext-overview-row-text">
								<span className="gui-ext-overview-row-title">{p.displayName}</span>
								<span className="gui-ext-overview-row-sub">
									{t("ext provider items {n}", { n: providerCount(p) })}
								</span>
							</span>
							<button
								type="button"
								role="switch"
								aria-checked={p.enabled}
								aria-label={`${t("ext provider")} ${p.displayName}`}
								className={`gui-toggle gui-toggle--sm${p.enabled ? " gui-toggle--on" : ""}`}
								onClick={() => onToggleProvider(p)}
							>
								{/* The knob IS the dot: an empty self-closing button
								 * rendered a track with no thumb (overview rows). */}
								<span className="gui-toggle-knob" />
							</button>
						</div>
					))}
				</div>
			</div>
			{/* CTA (设计稿 2:1427 底部):配置与诊断看完了 → 去能力中心发现/安装。 */}
			<button type="button" className="gui-ext-overview-cta" onClick={onOpenCapabilityCenter}>
				<Icon name="star" className="h-4 w-4" />
				<span className="min-w-0 flex-1 text-left">
					<span className="block text-[13px] font-medium">{t("capability center")}</span>
					<span className="block truncate text-[12px] text-[var(--color-text-faint)]">
						{t("ext open capability hint")}
					</span>
				</span>
				<Icon name="arrow-right-s" className="h-4 w-4 shrink-0 opacity-60" />
			</button>
		</div>
	);
}

export function ExtensionsCenter({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const data = useExtensionRegistry(rpc);
	const extensions = data?.extensions ?? null;
	const tabs = data?.tabs ?? [];
	const providers = data?.providers ?? [];
	const unhosted = useUnhostedSlots(rpc);
	const [error, setError] = useState<string | null>(null);
	// 设计稿 07 五 tab：概览 / 能力清单 / 插件 / 市场 / 槽位诊断 —— 配置与
	// 诊断视角；发现与安装（消费者视角）在一级「能力中心」（CapabilityCenterPage）。
	const [view, setView] = useState<"overview" | "inventory" | "plugins" | "marketplace" | "diagnostics">("overview");
	// 能力清单内部的 provider 子 tab（ALL + provider tabs，TUI buildProviderTabs 顺序）。
	const [tab, setTab] = useState("all");
	const [query, setQuery] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [detail, setDetail] = useState<{ content: string; filePath: string } | null>(null);
	const [raw, setRaw] = useState<string | null>(null);
	const [rawOpen, setRawOpen] = useState(false);
	const [collapsedKinds, setCollapsedKinds] = useState<Set<string>>(new Set());
	const { confirm } = useConfirm();
	// 插件列表:daemon plugins.list 是会话无关
	// 扩展扫描的独立 TTL 缓存 —— 与 extensions.list 分开拉取。
	const [plugins, setPlugins] = useState<PluginEntry[]>([]);
	const [pluginsError, setPluginsError] = useState<string | null>(null);
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		void rpc
			.request<{ plugins: PluginEntry[] }>("plugins.packages", {})
			.then(res => {
				if (!alive) return;
				setPlugins(res?.plugins ?? []);
			})
			.catch((e: unknown) => alive && setPluginsError(e instanceof Error ? e.message : String(e)));
		return () => {
			alive = false;
		};
	}, [rpc]);
	// 扩展设置卡片:settings.item.<extId> 组件
	// 按扩展分组 —— "served ∩ enabled"(组件 extensionId = 扩展模块路径,
	// 与扩展中心条目的 path 匹配)。
	const extSettingCards = useMemo(() => {
		const enabled = new Set((data?.extensions ?? []).filter(e => e.state === "active").map(e => e.path));
		const byExt = new Map<string, SlotComponent[]>();
		for (const c of data?.components ?? []) {
			if (!c.slot.startsWith(SETTINGS_ITEM_SLOT_PREFIX)) continue;
			if (!enabled.has(c.extensionId)) continue;
			const list = byExt.get(c.extensionId) ?? [];
			list.push(c);
			byExt.set(c.extensionId, list);
		}
		return [...byExt.entries()].sort((a, b) => a[0].localeCompare(b[0]));
	}, [data]);
	const extSettingsScope = rpc
		? {
				get: (keys: string[]) => rpc.request<Record<string, unknown>>("settings.get", { keys }),
				set: (key: string, value: unknown) => rpc.request("settings.set", { key, value }) as Promise<void>,
			}
		: null;

	const selected = useMemo(() => (extensions ?? []).find(e => e.id === selectedId) ?? null, [extensions, selectedId]);

	// 插件 tab 计数 = 插件包 + 热加载扩展模块（统一清单的两条链路）。
	const moduleCount = useMemo(
		() => (extensions ?? []).filter(e => e.kind === "extension-module").length,
		[extensions],
	);

	// Detail content (lazy): skills → SKILL.md via skills.read; context
	// files → fs.read; other kinds have no content file (inspector only).
	useEffect(() => {
		if (!selected || !rpc) {
			setDetail(null);
			return;
		}
		let alive = true;
		setDetail(null);
		setRaw(null);
		setRawOpen(false);
		if (selected.kind === "skill") {
			void rpc
				.request<{ content: string; filePath: string }>("skills.read", { name: selected.name })
				.then(res => {
					if (!alive) return;
					setDetail(res ? { content: res.content, filePath: res.filePath } : null);
				})
				.catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
		} else if (selected.kind === "context-file") {
			void rpc
				.request<{ content: string | null }>("fs.read", { path: selected.path })
				.then(res => {
					if (!alive) return;
					setDetail(res?.content ? { content: res.content, filePath: selected.path } : null);
				})
				.catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
		}
		return () => {
			alive = false;
		};
	}, [selected, rpc]);

	const loadRaw = (): void => {
		if (!selected || !rpc) return;
		setRawOpen(true);
		if (raw !== null) return;
		void rpc
			.request<{ raw: string }>("extensions.raw", { id: selected.id })
			.then(res => setRaw(res?.raw ?? "{}"))
			.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
	};

	const toggle = (e: ExtensionItem, next: boolean): void => {
		if (!rpc) return;
		// daemon 广播 extensions.changed → 单例重拉,不本地乐观更新。
		void rpc
			.request("extensions.setEnabled", { id: e.id, enabled: next })
			.then(() => setError(null))
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
	};

	/** omp 生态智能兼容:shadowed 项显式启用/取消(写 forceEnabledExtensions)。
	 *  默认同名冲突低优先级自动让位(shadow);agent/用户分析 shadowedBy 详情后
	 *  可强制启用 —— 下次扫描该项存活、原胜者反向 shadow。 */
	const forceToggle = (e: ExtensionItem, next: boolean): void => {
		if (!rpc) return;
		void rpc
			.request("extensions.setForceEnabled", { id: e.id, enabled: next })
			.then(() => setError(null))
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
	};

	const toggleProvider = (p: ProviderInfo): void => {
		if (!rpc) return;
		void rpc
			.request("extensions.setProviderEnabled", { providerId: p.id, enabled: !p.enabled })
			.then(() => setError(null))
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
	};

	const togglePlugin = (p: PluginEntry): void => {
		if (!rpc) return;
		void rpc
			.request("plugins.setEnabled", { name: p.name, enabled: !p.enabled })
			.then(() => {
				setPlugins(prev => prev.map(x => (x.name === p.name ? { ...x, enabled: !p.enabled } : x)));
				setError(null);
			})
			.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
	};

	const remove = (e: ExtensionItem): void => {
		if (!rpc) return;
		void confirm(t("delete skill confirm {name}", { name: e.name }), t("delete")).then(ok => {
			if (!ok) return;
			void rpc
				.request("skills.delete", { name: e.name })
				.then(() => {
					if (selectedId === e.id) setSelectedId(null);
					setError(null);
				})
				.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
		});
	};

	// Search filter (name/description/trigger/provider/kind) + tab filter.
	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		return (extensions ?? []).filter(e => {
			if (tab !== "all" && e.source.provider !== tab) return false;
			if (!q) return true;
			return [e.name, e.displayName, e.description ?? "", e.trigger ?? "", e.source.providerName, e.kind]
				.join(" ")
				.toLowerCase()
				.includes(q);
		});
	}, [extensions, tab, query]);

	// Tree: non-native providers (with kind groups) + a read-only 内置 node
	// for native items so builtins stay reachable (TUI tabs skip native).
	const tree = useMemo(() => {
		const nodes: {
			provider: ProviderInfo;
			count: number;
			enabled: boolean;
			kinds: { kind: string; count: number; items: ExtensionItem[] }[];
		}[] = [];
		const nativeItems: ExtensionItem[] = [];
		for (const p of providers) {
			const items = filtered.filter(e => e.source.provider === p.id);
			if (p.id === "native") {
				nativeItems.push(...items);
				continue;
			}
			// Empty disabled providers stay hidden — EXCEPT musepi-extensions:
			// the MusePi-native extension provider is a first-class entry the
			// user must always see (management surface even with zero items,
			// "插件化了用户要能了解"), unlike third-party providers.
			if (items.length === 0 && !p.enabled && p.id !== "musepi-extensions") continue;
			const kinds = new Map<string, ExtensionItem[]>();
			for (const it of items) {
				const list = kinds.get(it.kind) ?? [];
				list.push(it);
				kinds.set(it.kind, list);
			}
			nodes.push({
				provider: p,
				count: items.length,
				enabled: p.enabled,
				kinds: [...kinds.entries()]
					.map(([kind, list]) => ({ kind, count: list.length, items: list }))
					.sort((a, b) => b.count - a.count),
			});
		}
		// 未注册 provider 的条目(扩展声明的技能 provider "extension" 等):
		// ALL tab 已计数,但 provider 树没有对应节点 —— 补一个合成节点,
		// 否则条目计数与可见列表不一致(数据在,渲染不出来)。
		const knownProviderIds = new Set(providers.map(p => p.id));
		const orphaned = filtered.filter(e => !knownProviderIds.has(e.source.provider));
		if (orphaned.length > 0) {
			const kinds = new Map<string, ExtensionItem[]>();
			for (const it of orphaned) {
				const list = kinds.get(it.kind) ?? [];
				list.push(it);
				kinds.set(it.kind, list);
			}
			nodes.push({
				provider: {
					id: "extension",
					displayName: t("extension provider"),
					enabled: true,
				},
				count: orphaned.length,
				enabled: true,
				kinds: [...kinds.entries()]
					.map(([kind, list]) => ({ kind, count: list.length, items: list }))
					.sort((a, b) => b.count - a.count),
			});
		}
		nodes.sort((a, b) => (a.count === 0 ? 1 : 0) - (b.count === 0 ? 1 : 0) || b.count - a.count);
		return { nodes, nativeItems };
	}, [providers, filtered]);

	const toggleKind = (key: string): void => {
		setCollapsedKinds(prev => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	return (
		<div className="gui-ext-center">
			{/* 标题区 (设计稿 2:1427):大标题 + 副标题 + 右上槽位挂载胶囊。 */}
			<div className="gui-ext-head">
				<div className="gui-ext-head-text">
					<div className="gui-ext-head-title">{t("ext center title")}</div>
					<div className="gui-ext-head-sub">{t("ext center subtitle")}</div>
				</div>
				{unhosted.length > 0 ? (
					<span className="gui-ext-head-pill gui-ext-head-pill--warn">
						<Icon name="alert" className="h-3 w-3" />
						{t("slot unhosted {slot}", { slot: unhosted.join(", ") })}
					</span>
				) : (
					extensions !== null && (
						<span className="gui-ext-head-pill gui-ext-head-pill--ok">
							<Icon name="check" className="h-3 w-3" />
							{t("all slots hosted")}
						</span>
					)
				)}
			</div>
			{/* Top tabs (设计稿 07): 概览 / 能力清单 / 插件 / 市场 / 槽位诊断.
			 * Provider tabs live INSIDE the inventory view. */}
			<div className="gui-ext-tabs" role="tablist">
				<button
					type="button"
					role="tab"
					aria-selected={view === "overview"}
					className={`gui-ext-tab${view === "overview" ? " gui-ext-tab--active" : ""}`}
					onClick={() => setView("overview")}
				>
					<Icon name="layout-column" className="h-3.5 w-3.5 shrink-0 opacity-70" />
					{t("ext overview")}
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={view === "inventory"}
					className={`gui-ext-tab${view === "inventory" ? " gui-ext-tab--active" : ""}`}
					onClick={() => setView("inventory")}
				>
					{t("ext inventory")}
					<span className="gui-ext-tab-count">{(extensions ?? []).length}</span>
				</button>
				{/* 插件 tab:统一清单(UnifiedPluginsView)—— 插件包(marketplace/npm)
				 * 与热加载扩展模块(kind=extension-module)同屏,像 skill 管理一样
				 * 逐项标记来源类别(内置/项目级/用户级)。 */}
				<button
					type="button"
					role="tab"
					aria-selected={view === "plugins"}
					className={`gui-ext-tab${view === "plugins" ? " gui-ext-tab--active" : ""}`}
					onClick={() => setView("plugins")}
				>
					{t("plugins")}
					<span className="gui-ext-tab-count">{plugins.length + moduleCount}</span>
				</button>
				{/* Marketplace tab:daemon marketplace.list 的远程插件目录
				 * 浏览/一键安装。从 @musepi/client-core 复用 MarketplaceGrid,
				 * MarketplacePanel 留在 guest-client 自己用(SessionClient 绑定,
				 * 这里用 RpcClient 适配)。 */}
				<button
					type="button"
					role="tab"
					aria-selected={view === "marketplace"}
					className={`gui-ext-tab${view === "marketplace" ? " gui-ext-tab--active" : ""}`}
					onClick={() => setView("marketplace")}
				>
					<Icon name="plug-2" className="h-3.5 w-3.5 shrink-0 opacity-70" />
					{t("marketplace")}
				</button>
				{/* 槽位诊断 tab:加载失败 / 遮蔽 / 技能发现警告 / 已关闭来源 ——
				 * 一个回答"为什么没生效"的健康视图。 */}
				<button
					type="button"
					role="tab"
					aria-selected={view === "diagnostics"}
					className={`gui-ext-tab${view === "diagnostics" ? " gui-ext-tab--active" : ""}`}
					onClick={() => setView("diagnostics")}
				>
					<Icon name="pulse" className="h-3.5 w-3.5 shrink-0 opacity-70" />
					{t("ext slot diagnostics")}
				</button>
			</div>
			{error && <div className="px-1 pb-1 text-[12.5px] text-[var(--color-warning)]">{error}</div>}
			<div className="gui-ext-body">
				{/* 概览:统计卡 + 需要处理 + 来源健康度 + 能力中心 CTA(设计稿 07)。 */}
				{view === "overview" ? (
					<OverviewView
						extensions={extensions ?? []}
						providers={providers}
						unhosted={unhosted}
						onOpenDiagnostics={() => setView("diagnostics")}
						onOpenCapabilityCenter={() => window.dispatchEvent(new CustomEvent("omp-open-capability"))}
						onToggleProvider={toggleProvider}
						slots={data?.slots ?? null}
						onForceEnable={e => forceToggle(e as ExtensionItem, true)}
					/>
				) : view === "diagnostics" ? (
					<DiagnosticsView rpc={rpc} extensions={extensions} tabs={tabs} />
				) : view === "plugins" ? (
					<UnifiedPluginsView
						rpc={rpc}
						plugins={plugins}
						pluginsError={pluginsError}
						onTogglePackage={togglePlugin}
						onOpenMarketplace={() => setView("marketplace")}
						onError={setError}
					/>
				) : view === "marketplace" ? (
					<MarketplaceView rpc={rpc} />
				) : (
					<div className="gui-ext-inventory">
						{/* Inventory-internal provider tabs (TUI buildProviderTabs
						 * order): ALL + one per provider. Disabled providers render
						 * greyed but stay clickable. */}
						<div className="gui-ext-tabs" role="tablist">
							<button
								type="button"
								role="tab"
								aria-selected={tab === "all"}
								className={`gui-ext-tab${tab === "all" ? " gui-ext-tab--active" : ""}`}
								onClick={() => setTab("all")}
							>
								ALL
								<span className="gui-ext-tab-count">{(extensions ?? []).length}</span>
							</button>
							{tabs
								.filter(t => t.id !== "all")
								.map(tr => (
									<button
										key={tr.id}
										type="button"
										role="tab"
										aria-selected={tab === tr.id}
										className={`gui-ext-tab${tab === tr.id ? " gui-ext-tab--active" : ""}${tr.enabled ? "" : " gui-ext-tab--off"}`}
										onClick={() => setTab(tr.id)}
									>
										{tr.label}
										<span className="gui-ext-tab-count">{tr.count}</span>
									</button>
								))}
						</div>
						<div className="gui-ext-inventory-split">
							{/* Left: search + provider→kind→item tree. */}
							<div className="gui-ext-list">
								<div className="gui-ext-search">
									<Icon name="search" className="h-3.5 w-3.5 shrink-0 opacity-60" />
									<input
										className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none"
										placeholder={t("search skills...")}
										value={query}
										onChange={e => setQuery(e.target.value)}
									/>
								</div>
								<div className="gui-ext-list-scroll">
									{tree.nodes.map(node => {
										const providerKey = `p:${node.provider.id}`;
										const providerCollapsed = collapsedKinds.has(providerKey);
										return (
											<div key={node.provider.id} className="gui-ext-provider">
												<div
													className="gui-ext-provider-h"
													role="button"
													tabIndex={0}
													onClick={() => toggleKind(providerKey)}
												>
													<StateIcon
														on={providerCollapsed}
														pair={["arrow-right-s", "arrow-down-s"]}
														className="h-3.5 w-3.5 shrink-0 opacity-60"
													/>
													<span className={`gui-ext-dot${node.enabled ? "" : " gui-ext-dot--off"}`} />
													<span className="min-w-0 flex-1 truncate text-[12px] font-medium">
														{node.provider.displayName}
													</span>
													<span className="gui-ext-group-count">({node.count})</span>
													{node.provider.id !== "native" && (
														<button
															type="button"
															role="switch"
															aria-checked={node.enabled}
															aria-label={`${t("ext provider")} ${node.provider.displayName}`}
															className={`gui-toggle gui-toggle--sm${node.enabled ? " gui-toggle--on" : ""}`}
															onClick={e => {
																e.stopPropagation();
																toggleProvider(node.provider);
															}}
														>
															<span className="gui-toggle-knob" />
														</button>
													)}
												</div>
												{!providerCollapsed && (
													<div className="gui-ext-provider-children">
														{node.kinds.map(k => {
															const kindKey = `${node.provider.id}:${k.kind}`;
															const kindCollapsed = collapsedKinds.has(kindKey);
															return (
																<div key={kindKey}>
																	<div
																		className="gui-ext-kind-h"
																		role="button"
																		tabIndex={0}
																		onClick={() => toggleKind(kindKey)}
																	>
																		<StateIcon
																			on={kindCollapsed}
																			pair={["arrow-right-s", "arrow-down-s"]}
																			className="h-3 w-3 shrink-0 opacity-50"
																		/>
																		<span className="min-w-0 flex-1 truncate text-[11.5px]">
																			{kindLabel(k.kind)}
																		</span>
																		<span className="gui-ext-group-count">{k.count}</span>
																	</div>
																	{!kindCollapsed &&
																		k.items.map(e => (
																			<div
																				key={e.id}
																				role="button"
																				tabIndex={0}
																				className={`gui-ext-item${selectedId === e.id ? " gui-ext-item--selected" : ""}`}
																				onClick={() => setSelectedId(e.id)}
																				onKeyDown={ev => {
																					if (ev.key === "Enter" || ev.key === " ") {
																						ev.preventDefault();
																						setSelectedId(e.id);
																					}
																				}}
																			>
																				<span
																					className={`gui-ext-dot${e.loadError ? " gui-ext-dot--error" : e.state === "active" ? "" : e.state === "shadowed" ? " gui-ext-dot--shadowed" : " gui-ext-dot--off"}`}
																				/>
																				<span className="min-w-0 flex-1 truncate">{e.name}</span>
																				{e.loadError && (
																					<span className="gui-ext-item-tag gui-ext-item-tag--err">
																						{t("ext load failed")}
																					</span>
																				)}
																				{isGuiKind(e) && (
																					<span className="gui-ext-item-tag gui-ext-item-tag--gui">
																						GUI
																					</span>
																				)}
																				<span className="gui-ext-item-tag">{levelLabel(e)}</span>
																				<span className="gui-ext-item-ops">
																					{isDeletable(e) && (
																						<button
																							type="button"
																							className="gui-icon-btn"
																							onClick={ev => {
																								ev.stopPropagation();
																								remove(e);
																							}}
																							title={t("delete skill")}
																							aria-label={t("delete skill")}
																						>
																							<Icon name="delete-bin" className="h-3 w-3" />
																						</button>
																					)}
																					<button
																						type="button"
																						role="switch"
																						aria-checked={e.state === "active"}
																						aria-label={
																							e.state === "active"
																								? t("disable skill")
																								: t("enable skill")
																						}
																						className={`gui-toggle gui-toggle--sm${e.state === "active" ? " gui-toggle--on" : ""}`}
																						onClick={ev => {
																							ev.stopPropagation();
																							toggle(e, e.state !== "active");
																						}}
																					>
																						<span className="gui-toggle-knob" />
																					</button>
																				</span>
																			</div>
																		))}
																</div>
															);
														})}
													</div>
												)}
											</div>
										);
									})}
									{tree.nativeItems.length > 0 && (
										<div className="gui-ext-provider">
											<div className="gui-ext-provider-h">
												<span className="gui-ext-dot" />
												<span className="min-w-0 flex-1 truncate text-[12px] font-medium">
													{t("ext builtin")}
												</span>
												<span className="gui-ext-group-count">({tree.nativeItems.length})</span>
											</div>
											<div className="gui-ext-provider-children">
												{tree.nativeItems.map(e => (
													<div
														key={e.id}
														role="button"
														tabIndex={0}
														className={`gui-ext-item${selectedId === e.id ? " gui-ext-item--selected" : ""}`}
														onClick={() => setSelectedId(e.id)}
													>
														<span
															className={`gui-ext-dot${e.loadError ? " gui-ext-dot--error" : e.state === "active" ? "" : e.state === "shadowed" ? " gui-ext-dot--shadowed" : " gui-ext-dot--off"}`}
														/>
														<span className="min-w-0 flex-1 truncate">{e.name}</span>
														{e.loadError && (
															<span className="gui-ext-item-tag gui-ext-item-tag--err">
																{t("ext load failed")}
															</span>
														)}
													</div>
												))}
											</div>
										</div>
									)}
									{filtered.length === 0 && <div className="gui-ext-empty">{t("no skills found")}</div>}
								</div>
							</div>
							{/* Right: detail pane (name / type / description / trigger /
							 * source / path / state / instructions / raw inspector). */}
							<div className="gui-ext-detail">
								{selected ? (
									<>
										<div className="gui-ext-detail-name">{selected.displayName}</div>
										<div className="gui-ext-detail-meta">
											{t("extension type")}: {kindLabel(selected.kind)}
											{isGuiKind(selected) && (
												<span className="gui-ext-item-tag gui-ext-item-tag--gui">GUI</span>
											)}
										</div>
										{selected.description && <p className="gui-ext-detail-desc">{selected.description}</p>}
										{selected.trigger && (
											<div className="gui-ext-detail-section">
												<div className="gui-ext-detail-label">{t("trigger")}</div>
												<div className="gui-ext-detail-path">{selected.trigger}</div>
											</div>
										)}
										<div className="gui-ext-detail-section">
											<div className="gui-ext-detail-label">{t("source")}</div>
											<div className="gui-ext-detail-value">
												{t("via {provider} ({level})", {
													provider: selected.source.providerName,
													level: levelLabel(selected),
												})}
											</div>
											<div className="gui-ext-detail-path">{selected.path}</div>
										</div>
										<div className="gui-ext-detail-section">
											<div className="gui-ext-detail-label">{t("status")}</div>
											<div
												className={`gui-ext-detail-status${selected.state === "active" ? " gui-ext-detail-status--active" : selected.state === "shadowed" ? " gui-ext-detail-status--shadowed" : ""}`}
											>
												<span
													className={`gui-ext-dot${selected.state === "active" ? "" : selected.state === "shadowed" ? " gui-ext-dot--shadowed" : " gui-ext-dot--off"}`}
												/>
												{stateLabel(selected)}
												{selected.state === "shadowed" && selected.shadowedBy && (
													<span className="gui-ext-detail-shadowed">
														{t("shadowed by {name}", { name: selected.shadowedBy })}
													</span>
												)}
											</div>
											{selected.loadError && (
												<div className="gui-ext-detail-loaderror" title={selected.loadError}>
													<Icon name="alert" className="h-3.5 w-3.5 shrink-0" />
													<span className="min-w-0 truncate">{selected.loadError}</span>
												</div>
											)}
										</div>
										{selected.state === "shadowed" && (
											<div className="gui-ext-detail-actions">
												<button
													type="button"
													className="gui-btn"
													onClick={() => forceToggle(selected, true)}
												>
													<Icon name="plug" className="h-3.5 w-3.5" />
													{t("force enable")}
												</button>
											</div>
										)}
										{(selected.kind === "skill" || selected.kind === "context-file") && (
											<div className="gui-ext-detail-section">
												<div className="gui-ext-detail-label">{t("instructions")}</div>
												<div className="gui-ext-detail-code">
													{detail ? (
														<pre>{detail.content}</pre>
													) : (
														<div className="text-[12px] text-[var(--color-text-faint)]">
															{t("no content")}
														</div>
													)}
												</div>
											</div>
										)}
										<div className="gui-ext-detail-section">
											<button
												type="button"
												className="gui-ext-detail-raw-toggle"
												onClick={loadRaw}
												aria-expanded={rawOpen}
											>
												<StateIcon
													on={rawOpen}
													pair={["arrow-down-s", "arrow-right-s"]}
													className="h-3.5 w-3.5"
												/>
												{t("raw data")}
											</button>
											<HeightMorph morphKey={rawOpen ? "raw-open" : "raw-closed"}>
												{rawOpen && (
													<div className="gui-ext-detail-code">
														<pre>{raw ?? "…"}</pre>
													</div>
												)}
											</HeightMorph>
										</div>
										{isDeletable(selected) && (
											<div className="gui-ext-detail-actions">
												<button type="button" className="gui-btn" onClick={() => remove(selected)}>
													<Icon name="delete-bin" className="h-3.5 w-3.5" />
													{t("delete skill")}
												</button>
											</div>
										)}
									</>
								) : (
									<div className="gui-ext-detail-empty">{t("select an extension")}</div>
								)}
							</div>
						</div>
						{/* /.gui-ext-inventory-split */}
					</div>
				)}
			</div>
			{/* 扩展设置卡片(`settings.item.<extId>`
			 * 组件按扩展分组渲染在此 —— 插件的运行时配置随插件 inventory 展示,
			 * 不设设置页聚合 tab(registerSetting 配置项经 ui.tab 进现有 tab,
			 * settings.tab.<id> 整页进设置页左侧导航)。 */}
			{extSettingCards.length > 0 && (
				<div className="gui-ext-itemcards">
					<div className="gui-ext-slots-head">
						<Icon name="plug-2" className="h-3.5 w-3.5 shrink-0 opacity-60" />
						<span className="text-[12px] font-medium">{t("extension settings")}</span>
					</div>
					{extSettingCards.map(([extId, items]) => (
						<div key={extId} className="gui-agent-card gui-ext-settings-card">
							<div className="gui-ext-settings-card-label">{extId.split("/").pop()}</div>
							{items.map(item => (
								<SlotComponentMount
									key={`${item.slot}:${item.extensionId}`}
									item={item}
									rpc={rpc}
									settingsScope={extSettingsScope}
								/>
							))}
						</div>
					))}
				</div>
			)}
			{/* Bottom status bar (CCEC parity). */}
			<div className="gui-ext-statusbar">
				<span>{t("ext status hint")}</span>
				<span className="ml-auto truncate">
					{filtered.length} / {(extensions ?? []).length}
				</span>
			</div>
		</div>
	);
}

/**
 * Marketplace browse panel used by the GUI `marketplace` tab. Wraps the
 * shared {@link MarketplaceGrid} from `@musepi/client-core` so the visual
 * stays in lock-step with the collab guest client, and wires install /
 * remove actions to the daemon `marketplace.install` / `marketplace.remove`
 * RPCs. Open detail is a non-fatal no-op for now (the GUI has no plugin
 * detail view yet); it logs so the click doesn't disappear silently.
 */
function MarketplaceView({ rpc }: { rpc: RpcClient | null }): ReactNode {
	// The shared MarketplaceGrid owns fetch / busy / refresh: it pulls
	// `marketplace.list` on mount (through the duck-typed client adapter) and
	// wraps every install/remove in a busy flag + automatic re-pull. This view
	// only routes the actions to the daemon RPCs; failures propagate back to
	// the grid's error banner.
	const handleAction = async (action: MarketplaceCardAction): Promise<void> => {
		if (!rpc) return;
		if (action.kind === "open") {
			console.info("[marketplace] open detail pending:", action.entry.name);
			return;
		}
		const method = action.kind === "install" ? "marketplace.install" : "marketplace.remove";
		await rpc.request(method, {
			name: action.entry.name,
			marketplace: action.entry.marketplace ?? "default",
		});
	};

	// MarketplaceGrid's `client` prop is duck-typed `{ rpc<T>(method, params?) }`;
	// RpcClient.request matches that signature, so a thin adapter is enough.
	const client = rpc ? { rpc: <T,>(m: string, p?: unknown): Promise<T> => rpc.request<T>(m, p) } : null;

	return (
		<div className="gui-ext-marketplace">
			<MarketplaceGrid client={client} onAction={handleAction} />
		</div>
	);
}
