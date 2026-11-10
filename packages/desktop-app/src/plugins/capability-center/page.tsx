import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CapabilityCenter } from "../../components/CapabilityCenter";
import { MarketplaceView } from "../../components/MarketplaceView";
import { ScrollEdgeBlur } from "../../components/ScrollEdgeBlur";
import { SkillMarketView } from "../../components/SkillMarketView";
import { type PluginPackageEntry as PluginEntry, UnifiedPluginsView } from "../../components/UnifiedPluginsView";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { dismissActionToastSource, pushActionToast } from "../../lib/action-toast";
import {
	type CapabilityTab,
	clearCapabilityNav,
	publishCapabilityNav,
	subscribeCapabilityNavAction,
} from "../../lib/capability-nav";
import { setPluginManagementEnabled } from "../../lib/plugin-management";
import type { RpcClient } from "../../lib/rpc";

/** First-class Skills / Plugins / Marketplace page owned by the desktop Cordis plugin.
 *  The tab UNION lives in `lib/capability-nav` so the second-tier panel and
 *  this page cannot drift; this alias keeps the page's public prop shape. */
export type Tab = CapabilityTab;
/** 技能 tab 的两个子分段 (设计稿 frame 01/02):发现 / 我安装的 N。 */
type SkillPane = "discover" | "installed";

/** The page body is the scroll surface; the tool row is sticky at its top.
 *  The scroll edges use the shared `ScrollEdgeBlur` primitive — its bands must
 *  live OUTSIDE the scroller (Chromium does not sample scrolled content for a
 *  backdrop-filter inside the scroll container), so the body sits in
 *  `.gui-capability-scroll` together with the two bands. */
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
	// 插件 tab 的可管理条目数：由 UnifiedPluginsView 按它实际展示的清单上报
	// （官方 manage 层 + 插件包 + 未归属模块），不再用 plugins.packages 的
	// 安装包数量冒充——那个值在没有市场安装时是 0，与页面内容不符。
	const [pluginCount, setPluginCount] = useState(0);
	// Scroll-edge state for the progressive blur bands: the top band only
	// appears once content has moved under the sticky tool row, and the end
	// band disappears at the bottom so it never fades the pagination.
	const bodyRef = useRef<HTMLDivElement | null>(null);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const [edges, setEdges] = useState({ top: false, end: false });
	useEffect(() => {
		const body = bodyRef.current;
		if (!body) return;
		const update = (): void => {
			const top = body.scrollTop > 4;
			const end = body.scrollTop + body.clientHeight < body.scrollHeight - 4;
			setEdges(prev => (prev.top === top && prev.end === end ? prev : { top, end }));
		};
		// The tool row's height is not constant (controls wrap on narrow rows),
		// so the top band pins to the measured height instead of a hard 56px.
		const syncToolbarHeight = (): void => {
			const bars = body.querySelectorAll<HTMLElement>(
				".gui-skill-market-bar, .gui-ext-plugins-toolbar, .mp-grid-toolbar",
			);
			let height = 0;
			for (const bar of bars) {
				const measured = bar.getBoundingClientRect().height;
				if (measured > 0) height = measured;
			}
			if (height > 0) scrollRef.current?.style.setProperty("--cap-toolbar-h", `${Math.ceil(height)}px`);
		};
		update();
		syncToolbarHeight();
		body.addEventListener("scroll", update, { passive: true });
		const observer =
			typeof ResizeObserver === "function"
				? new ResizeObserver(() => {
						update();
						syncToolbarHeight();
					})
				: null;
		observer?.observe(body);
		for (const child of body.children) observer?.observe(child);
		for (const bar of body.querySelectorAll(".gui-skill-market-bar, .gui-ext-plugins-toolbar, .mp-grid-toolbar")) {
			observer?.observe(bar);
		}
		return () => {
			body.removeEventListener("scroll", update);
			observer?.disconnect();
		};
	}, [tab, skillPane]);
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

	// Two-tier shell (2026-11-08): the three destination tabs live in the
	// rail's sidebar slot (`sidebar.panel.capability`), NOT in this page
	// header. This page publishes ONE projection of its state and accepts
	// actions from that panel — one tab source, one selected row, no second
	// copy of the RPC data. The compiled plugin binds `capability-nav`
	// through the host module table, so page and panel share one store.
	useEffect(() => {
		publishCapabilityNav({ tab, skillsCount: installedCount, pluginsCount: pluginCount });
	}, [tab, installedCount, pluginCount]);
	useEffect(
		() =>
			subscribeCapabilityNavAction(action => {
				onTabChange(action.type === "add" ? "marketplace" : action.tab);
			}),
		[onTabChange],
	);
	useEffect(() => () => clearCapabilityNav(), []);

	return (
		<div className="gui-agents-center gui-capability-page">
			<WorkspacePageHeader
				icon="star"
				title={t("tools.capabilityCenter")}
				description={t("tools.capabilityCenterDesc")}
				onBack={onBack}
			/>
			{/* 技能子分段条放在滚动体外：主 tab 已移到二级左栏，这个二级分段
			 * 仍属于内容列，各面板工具行才能以统一偏移吸顶（subtabs 若在滚动
			 * 体内，吸顶偏移随面板层级而变）。 */}
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
			{/* 遮罩必须留在滚动体「外面」：Chromium 不会为滚动容器内部绝对定位
			 * 的 backdrop-filter 采样滚动内容，放里面只剩渐变遮罩、没有真模糊
			 * （与会话记录的边缘带同一结构）。 */}
			<div
				className="gui-capability-scroll"
				ref={scrollRef}
				data-edge-top={edges.top ? "" : undefined}
				data-edge-end={edges.end ? "" : undefined}
			>
				<div className="gui-capability-body" ref={bodyRef}>
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
							onCountChange={setPluginCount}
						/>
					</div>
					<div className={`gui-capability-pane${tab === "marketplace" ? " gui-capability-pane--on" : ""}`}>
						<MarketplaceView rpc={rpc} />
					</div>
				</div>
				<ScrollEdgeBlur edge="top" />
				<ScrollEdgeBlur edge="end" />
			</div>
		</div>
	);
}

export default CapabilityCenterPage;
