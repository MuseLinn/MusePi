import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { Icon, type IconName } from "../vendor/oc-icons";
import { CapabilityCenter } from "./CapabilityCenter";
import { MarketplaceView } from "./MarketplaceView";
import { SkillMarketView } from "./SkillMarketView";
import { type PluginPackageEntry as PluginEntry, UnifiedPluginsView } from "./UnifiedPluginsView";

/**
 * 能力中心 (capability center) — the FIRST-CLASS sidebar page (设计稿 05:
 * 系统侧栏一级导航), split from the settings-side 扩展控制中心 which keeps
 * the config/diagnosis perspective (概览/能力清单/插件/市场/槽位诊断).
 *
 * Three tabs share one card/filter/drawer language (设计稿 05):
 *   技能  — installed skills + acquire (skills.install / Git URL), with the
 *           skill detail drawer (CapabilityCenter two-screen).
 *   插件  — unified plugin list (UnifiedPluginsView): marketplace/npm
 *           plugin packages + hot-loaded extension modules, each item
 *           tagged by source category (内置/项目级/用户级, skill 管理
 *           同款) like the settings-side tab.
 *   市场  — the remote marketplace catalog (marketplace.list / install).
 */

type Tab = "skills" | "plugins" | "marketplace";
/** 技能 tab 的两个子分段 (设计稿 frame 01/02):发现 / 我安装的 N。 */
type SkillPane = "discover" | "installed";

export function CapabilityCenterPage({ rpc, onBack }: { rpc: RpcClient | null; onBack(): void }): ReactNode {
	const [tab, setTab] = useState<Tab>("skills");
	// The design spec puts the remote catalog INSIDE 技能 as a 发现 sub-pane
	// (我安装的 is the other half). 市场 stays as its own tab because the
	// settings-side 扩展控制中心 still links here for plugin sources.
	const [skillPane, setSkillPane] = useState<SkillPane>("discover");
	const [plugins, setPlugins] = useState<PluginEntry[]>([]);
	const [pluginsError, setPluginsError] = useState<string | null>(null);
	// 「我安装的 N」的计数:只为标签上的数字,列表本身由 CapabilityCenter
	// 自己拉取(它有 warnings/来源过滤等更完整的模型)。
	const [installedCount, setInstalledCount] = useState(0);

	const loadInstalledCount = useCallback((): void => {
		if (!rpc) return;
		void rpc
			.request<{ skills: unknown[] }>("skills.list", {})
			.then(res => setInstalledCount(res?.skills?.length ?? 0))
			.catch(() => {});
	}, [rpc]);

	useEffect(() => {
		if (tab !== "skills") return;
		loadInstalledCount();
		// skillPane 也要在依赖里:在「我安装的」里卸载/装完技能后切回
		// 「发现」,标签上的 N 必须已重读,而不是停留在切走前的旧值。
	}, [tab, skillPane, loadInstalledCount]);

	useEffect(() => {
		if (!rpc || tab !== "plugins") return;
		let alive = true;
		void rpc
			.request<{ plugins: PluginEntry[] }>("plugins.packages", {})
			.then(res => {
				if (alive) setPlugins(res?.plugins ?? []);
			})
			.catch((e: unknown) => alive && setPluginsError(e instanceof Error ? e.message : String(e)));
		return () => {
			alive = false;
		};
	}, [rpc, tab]);

	const togglePlugin = (p: PluginEntry): void => {
		if (!rpc) return;
		void rpc
			.request("plugins.setEnabled", { name: p.name, enabled: !p.enabled })
			.then(() => {
				setPlugins(prev => prev.map(x => (x.name === p.name ? { ...x, enabled: !p.enabled } : x)));
				setPluginsError(null);
			})
			.catch((err: unknown) => setPluginsError(err instanceof Error ? err.message : String(err)));
	};
	// No daemon-side plugin removal RPC (list/packages/setEnabled only) — the
	// enable toggle is the management surface; removal happens on disk.

	const tabs: { id: Tab; label: string; icon: IconName }[] = [
		{ id: "skills", label: t("skills tab"), icon: "sparkling" },
		{ id: "plugins", label: t("plugins"), icon: "plug" },
		{ id: "marketplace", label: t("marketplace"), icon: "plug-2" },
	];

	return (
		<div className="gui-agents-center gui-capability-page">
			<header className="gui-agents-center-head">
				<button type="button" className="gui-tool-btn" onClick={onBack} aria-label={t("back")} title={t("back")}>
					<Icon name="arrow-left" className="h-4 w-4" />
				</button>
				<div className="gui-agents-center-title">
					<Icon name="star" className="h-4 w-4 text-[var(--color-accent)]" />
					<h2 className="gui-agents-center-name">{t("capability center")}</h2>
					<span className="gui-agents-center-count">{t("capability center desc")}</span>
				</div>
			</header>
			<div className="gui-capability-tabs" role="tablist">
				{tabs.map(tb => (
					<button
						key={tb.id}
						type="button"
						role="tab"
						aria-selected={tab === tb.id}
						className={`gui-capability-tab${tab === tb.id ? " gui-capability-tab--on" : ""}`}
						onClick={() => setTab(tb.id)}
					>
						<Icon name={tb.icon} className="h-3.5 w-3.5 shrink-0 opacity-70" />
						{tb.label}
					</button>
				))}
			</div>
			<div className="gui-capability-body">
				{tab === "skills" ? (
					<>
						<div className="gui-capability-subtabs" role="tablist">
							{(
								[
									["discover", t("discover")],
									["installed", t("installed {count}", { count: installedCount })],
								] as [SkillPane, string][]
							).map(([id, label]) => (
								<button
									key={id}
									type="button"
									role="tab"
									aria-selected={skillPane === id}
									className={`gui-capability-subtab${skillPane === id ? " gui-capability-subtab--on" : ""}`}
									onClick={() => setSkillPane(id)}
								>
									{label}
								</button>
							))}
						</div>
						{skillPane === "discover" ? (
							<SkillMarketView rpc={rpc} onInstalled={loadInstalledCount} />
						) : (
							<CapabilityCenter rpc={rpc} />
						)}
					</>
				) : tab === "plugins" ? (
					/* Shared unified list (settings-side 扩展控制中心 parity):
					 * plugin packages + hot-loaded extension modules, source-
					 * category tags per item, shared empty-state contract. */
					<UnifiedPluginsView
						rpc={rpc}
						plugins={plugins}
						pluginsError={pluginsError}
						onTogglePackage={togglePlugin}
						onOpenMarketplace={() => setTab("marketplace")}
						onError={setPluginsError}
					/>
				) : (
					<MarketplaceView rpc={rpc} />
				)}
			</div>
		</div>
	);
}
