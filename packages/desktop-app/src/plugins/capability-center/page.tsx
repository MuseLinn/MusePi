import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { CapabilityCenter } from "../../components/CapabilityCenter";
import { ExtensionStatusCard } from "../../components/ExtensionStatusCard";
import { MarketplaceView } from "../../components/MarketplaceView";
import { SkillMarketView } from "../../components/SkillMarketView";
import { type PluginPackageEntry as PluginEntry, UnifiedPluginsView } from "../../components/UnifiedPluginsView";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { dismissActionToastSource, pushActionToast } from "../../lib/action-toast";
import { setPluginManagementEnabled } from "../../lib/plugin-management";
import type { RpcClient } from "../../lib/rpc";
import { Icon, type IconName } from "../../vendor/oc-icons";

/** First-class Skills / Plugins / Marketplace page owned by the desktop Cordis plugin. */
export type Tab = "skills" | "plugins" | "marketplace";
/** 技能 tab 的两个子分段 (设计稿 frame 01/02):发现 / 我安装的 N。 */
type SkillPane = "discover" | "installed";

export function CapabilityCenterPage({
	rpc,
	page: { onBack, tab, onTabChange },
}: {
	rpc: RpcClient | null;
	/** SlotComponentMount keeps full-page navigation under the `page` prop. */
	page: {
		onBack(): void;
		/** 受控当前 tab（app.tsx 的 capabilityTab state）：侧边栏悬停菜单、
		 * 扩展控制中心 CTA 等外部入口在页面已挂载时也能切 tab——组件只在
		 * mount 时读一次的 initialTab 会让这些跳转静默失效。 */
		tab: Tab;
		onTabChange(tab: Tab): void;
	};
}): ReactNode {
	// The design spec puts the remote catalog INSIDE 技能 as a 发现 sub-pane
	// (我安装的 is the other half). 市场 stays as its own tab because the
	// settings-side 扩展控制中心 still links here for plugin sources.
	const [skillPane, setSkillPane] = useState<SkillPane>("discover");
	const [plugins, setPlugins] = useState<PluginEntry[]>([]);
	const [pluginsError, setPluginsError] = useState<string | null>(null);
	// 「我安装的 N」的计数:只为标签上的数字,列表本身由 CapabilityCenter
	// 自己拉取(它有 warnings/来源过滤等更完整的模型)。
	const [installedCount, setInstalledCount] = useState(0);
	const reportPluginsError = useCallback((details: string, title = t("tools.extLoadFailed")): void => {
		setPluginsError(details);
		pushActionToast({
			kind: "error",
			title,
			message: t("settings.plugins"),
			details,
			dedupeKey: "capability-center:plugins",
		});
	}, []);
	const clearPluginsError = useCallback((): void => {
		setPluginsError(null);
		dismissActionToastSource("capability-center:plugins");
	}, []);

	const loadInstalledCount = useCallback((): void => {
		if (!rpc) return;
		void rpc
			.request<{ skills: unknown[] }>("skills.list", {})
			.then(res => setInstalledCount(res?.skills?.length ?? 0))
			.catch(() => {});
	}, [rpc]);

	useEffect(() => {
		loadInstalledCount();
		// skillPane 也要在依赖里:在「我安装的」里卸载/装完技能后切回
		// 「发现」,标签上的 N 必须已重读,而不是停留在切走前的旧值。
	}, [skillPane, loadInstalledCount]);

	// 三个 tab 面板常驻挂载（gui-capability-pane 用 display 切换），
	// 插件清单在 mount 时即拉取——切到插件 tab 时列表已就绪（持久化 +
	// 切换动效的前提：不能等 tab 激活才挂载/才发请求）。
	// extensions.changed（组件开关/启停/HMR，daemon 统一扇出）即时重拉——
	// 详情弹层里的组件开关不用重进页面即可看到最新状态。
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		const load = (): void => {
			void rpc
				.request<{ plugins: PluginEntry[] }>("plugins.packages", {})
				.then(res => {
					if (!alive) return;
					setPlugins(res?.plugins ?? []);
					clearPluginsError();
				})
				.catch((e: unknown) => {
					if (alive) reportPluginsError(e instanceof Error ? e.message : String(e));
				});
		};
		load();
		const unlisten = rpc.addEventListener(event => {
			const payload = event.payload as { type?: string } | undefined;
			if (payload?.type === "extensions.changed") load();
		});
		return () => {
			alive = false;
			unlisten();
		};
	}, [rpc, clearPluginsError, reportPluginsError]);

	const togglePlugin = (p: PluginEntry): void => {
		if (!rpc) return;
		void setPluginManagementEnabled(rpc, p, !p.enabled)
			.then(res => {
				if (res.ok) {
					setPlugins(prev =>
						prev.map(x => (x.name === p.name ? { ...x, enabled: res.enabled ?? !p.enabled } : x)),
					);
					clearPluginsError();
				} else {
					// Load failed: leave the toggle where it was and surface why.
					setPlugins(prev => prev.map(x => (x.name === p.name ? { ...x, enabled: false } : x)));
					reportPluginsError(`${p.name}: ${res.error ?? "load failed"}`, t("tools.operationFailed"));
				}
			})
			.catch((err: unknown) =>
				reportPluginsError(err instanceof Error ? err.message : String(err), t("tools.operationFailed")),
			);
	};
	// No daemon-side plugin removal RPC (list/packages/setEnabled only) — the
	// enable toggle is the management surface; removal happens on disk.

	const tabs: { id: Tab; label: string; icon: IconName }[] = [
		{ id: "skills", label: t("tools.skillsTab"), icon: "sparkling" },
		{ id: "plugins", label: t("settings.plugins"), icon: "plug" },
		{ id: "marketplace", label: t("guest.marketplace"), icon: "plug-2" },
	];

	return (
		<div className="gui-agents-center gui-capability-page">
			<WorkspacePageHeader
				icon="star"
				title={t("tools.capabilityCenter")}
				description={t("tools.capabilityCenterDesc")}
				onBack={onBack}
				tabs={
					<div className="gui-capability-tabs" role="tablist">
						{tabs.map(tb => (
							<button
								key={tb.id}
								type="button"
								role="tab"
								aria-selected={tab === tb.id}
								className={`gui-capability-tab${tab === tb.id ? " gui-capability-tab--on" : ""}`}
								onClick={() => onTabChange(tb.id)}
							>
								<Icon name={tb.icon} className="h-3.5 w-3.5 shrink-0 opacity-70" />
								{tb.label}
							</button>
						))}
					</div>
				}
			/>
			{/* 技能子分段条放在滚动体外：与主 tab 同处页头，各面板工具行才能
			 * 以统一偏移吸顶（subtabs 若在滚动体内，吸顶偏移随面板层级而变）。 */}
			{tab === "skills" && (
				<div className="gui-capability-subtabs" role="tablist">
					{(
						[
							["discover", t("general.discover")],
							["installed", t("general.installedWithCount", { count: installedCount })],
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
			)}
			<div className="gui-capability-body">
				{/* 三个面板常驻挂载、display 切换（gui-capability-pane）：切 tab
				 * 不丢各面板的滚动位置/输入态/已拉取数据，切入面板有淡入上浮动效
				 * （display none→block 会重放 keyframes）。 */}
				<div className={`gui-capability-pane${tab === "skills" ? " gui-capability-pane--on" : ""}`}>
					<div className={`gui-capability-pane${skillPane === "discover" ? " gui-capability-pane--on" : ""}`}>
						<SkillMarketView rpc={rpc} onInstalled={loadInstalledCount} />
					</div>
					<div className={`gui-capability-pane${skillPane === "installed" ? " gui-capability-pane--on" : ""}`}>
						<CapabilityCenter rpc={rpc} />
					</div>
				</div>
				<div className={`gui-capability-pane${tab === "plugins" ? " gui-capability-pane--on" : ""}`}>
					{/* Running-plugin status: the composer used to carry it; the
					 * capability page is now its host. The chip renders nothing when
					 * no plugin is running, so the pane keeps its normal top. */}
					<ExtensionStatusCard rpc={rpc} />
					{/* Shared unified list, manage layer only: official plugins the user
					 * can toggle or configure plus installed/self-built packages. The
					 * full built-in inventory (read-only packs, preset-only personas)
					 * stays in Settings → Extensions & plugins. */}
					<UnifiedPluginsView
						rpc={rpc}
						plugins={plugins}
						pluginsError={pluginsError}
						onTogglePackage={togglePlugin}
						onOpenMarketplace={() => onTabChange("marketplace")}
						onError={reportPluginsError}
					/>
				</div>
				<div className={`gui-capability-pane${tab === "marketplace" ? " gui-capability-pane--on" : ""}`}>
					<MarketplaceView rpc={rpc} />
				</div>
			</div>
		</div>
	);
}

export default CapabilityCenterPage;
