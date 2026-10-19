import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { getHostState, subscribeHost } from "../../lib/managed-browser-host";
import type { RpcClient } from "../../lib/rpc";

interface BrowserTabInfo {
	targetId: string;
	title: string;
	url: string;
}

interface BrowserExtensionInfo {
	id: string;
	name: string;
	version: string;
}

/** 浏览器 section: shared automation Chromium status + defaults + the
 *  MusePi Browser Relay extension (chrome.debugger bridge into the user's own
 *  Chrome — kimi webbridge 同款) install entry. */
export function BrowserSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [headless, setHeadless] = useState<boolean | null>(null);
	const [relay, setRelay] = useState<boolean | null>(null);
	const [gui, setGui] = useState<boolean | null>(null);
	const [restrictToPublic, setRestrictToPublic] = useState<boolean | null>(null);
	const [endpoint, setEndpoint] = useState<string | null>(null);
	const [profileDir, setProfileDir] = useState<string | null>(null);
	const [tabCount, setTabCount] = useState<number | null>(null);
	const [extensions, setExtensions] = useState<BrowserExtensionInfo[] | null>(null);
	const [relayStatus, setRelayStatus] = useState<{
		installed: boolean;
		serving: boolean;
		connected: boolean;
		extensionDir: string;
	} | null>(null);
	const [installing, setInstalling] = useState(false);
	const [importing, setImporting] = useState(false);
	const [importMsg, setImportMsg] = useState<string | null>(null);
	const [clearing, setClearing] = useState(false);
	const [glow, setGlow] = useState<boolean | null>(null);
	// 托管浏览器桥是**渲染端**事实(主进程 CDP 桥的绑定端口、agent 标签页),
	// 不经过 daemon —— 直接订阅宿主 store,与右栏面板同源。
	const [guiUrl, setGuiUrl] = useState<string | null>(null);
	const host = useSyncExternalStore(subscribeHost, getHostState);
	const bridgePort = host.port;
	const agentTab = host.tabs.find(tab => tab.agent) ?? null;

	const refresh = (): void => {
		if (!rpc) return;
		void rpc
			.request<{ [k: string]: unknown }>("settings.get", {
				keys: [
					"browser.headless",
					"browser.relay",
					"browser.gui",
					"browser.guiUrl",
					"browser.policy.restrictToPublic",
					"computer.glow",
				],
			})
			.then(res => {
				setHeadless(res["browser.headless"] === true);
				setRelay(res["browser.relay"] === true);
				setGui(res["browser.gui"] === true);
				if (typeof res["browser.guiUrl"] === "string") setGuiUrl(res["browser.guiUrl"]);
				setRestrictToPublic(res["browser.policy.restrictToPublic"] === true);
				setGlow(res["computer.glow"] !== false);
			})
			.catch(() => {});
		void rpc
			.request<{ wsEndpoint?: string; profileDir?: string }>("browser.endpoint", {})
			.then(res => {
				setEndpoint(res?.wsEndpoint ?? null);
				setProfileDir(res?.profileDir ?? null);
			})
			.catch(() => setEndpoint(null));
		void rpc
			.request<{ tabs?: BrowserTabInfo[] }>("browser.tabs", {})
			.then(res => setTabCount(res?.tabs?.length ?? 0))
			.catch(() => setTabCount(0));
		void rpc
			.request<{ extensions?: BrowserExtensionInfo[] }>("browser.extensions", {})
			.then(res => setExtensions(res?.extensions ?? []))
			.catch(() => setExtensions([]));
		void rpc
			.request<{ installed: boolean; serving: boolean; connected: boolean; extensionDir: string }>(
				"browser.relayStatus",
				{},
			)
			.then(res => setRelayStatus(res))
			.catch(() => setRelayStatus(null));
	};

	useEffect(() => {
		refresh();
		const id = setInterval(refresh, 4000);
		return () => clearInterval(id);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [refresh]);

	const setBool = (
		key: "browser.headless" | "browser.relay" | "browser.gui" | "browser.policy.restrictToPublic" | "computer.glow",
		next: boolean,
	): void => {
		void rpc?.request("settings.set", { key, value: next }).then(() => {
			refresh();
			// The app's glow latch caches this setting — poke it to re-read.
			if (key === "computer.glow") window.dispatchEvent(new Event("omp-glow-setting"));
		});
	};

	const installRelay = (): void => {
		if (!rpc || installing) return;
		setInstalling(true);
		void rpc
			.request("browser.relayInstall", {})
			.then(() => refresh())
			.finally(() => setInstalling(false));
	};
	const uninstallRelay = (): void => {
		if (!rpc || installing) return;
		setInstalling(true);
		void rpc
			.request("browser.relayUninstall", {})
			.then(() => refresh())
			.finally(() => setInstalling(false));
	};

	return (
		<>
			<h2 className="gui-settings-page-title">{t("settings.browser")}</h2>
			<p className="gui-settings-page-desc">{t("tools.browserSettingsDescription")}</p>
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("tools.browserEngine")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("tools.headlessBrowser")}</div>
						<div className="gui-settings-row-desc">{t("tools.headlessBrowserDescription")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={headless === true}
						className={`gui-toggle${headless === true ? " gui-toggle--on" : ""}`}
						onClick={() => setBool("browser.headless", !(headless === true))}
						aria-label={t("tools.headlessBrowser")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("tools.browserRelay")}</div>
						<div className="gui-settings-row-desc">{t("tools.browserRelayDescription")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={relay === true}
						className={`gui-toggle${relay === true ? " gui-toggle--on" : ""}`}
						onClick={() => setBool("browser.relay", !(relay === true))}
						aria-label={t("tools.browserRelay")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("tools.managedBrowser")}</div>
						<div className="gui-settings-row-desc">{t("tools.managedBrowserDescription")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={gui === true}
						className={`gui-toggle${gui === true ? " gui-toggle--on" : ""}`}
						onClick={() => setBool("browser.gui", !(gui === true))}
						aria-label={t("tools.managedBrowser")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				{/* 托管浏览器桥地址:桥运行时以它的实际端口为准(9230-9239
				 * 是重试区间),这里填的值只在没有桥时兜底。 */}
				<div className="gui-settings-row">
					<div className="min-w-0 flex-1">
						<div className="gui-settings-row-label">{t("tools.managedBrowserUrl")}</div>
						<div className="gui-settings-row-desc">{t("tools.managedBrowserUrlDescription")}</div>
						<input
							className="gui-input mt-1.5"
							value={guiUrl ?? ""}
							spellCheck={false}
							placeholder="http://127.0.0.1:9230"
							aria-label={t("tools.managedBrowserUrl")}
							onChange={e => setGuiUrl(e.target.value)}
							onBlur={() => {
								if (guiUrl === null) return;
								void rpc
									?.request("settings.set", { key: "browser.guiUrl", value: guiUrl.trim() })
									.then(() => refresh())
									.catch(() => {});
							}}
						/>
					</div>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("tools.browserChannelPriority")}</div>
						<div className="gui-settings-row-desc">{t("tools.browserChannelPriorityDescription")}</div>
					</div>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("tools.publicInternetOnly")}</div>
						<div className="gui-settings-row-desc">{t("tools.publicInternetOnlyDescription")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={restrictToPublic === true}
						className={`gui-toggle${restrictToPublic === true ? " gui-toggle--on" : ""}`}
						onClick={() => setBool("browser.policy.restrictToPublic", !(restrictToPublic === true))}
						aria-label={t("tools.publicInternetOnly")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				{/* Relay extension (chrome.debugger bridge — kimi webbridge 同款):
				 * 安装/卸载 + 三层状态(文件写出 / server 在跑 / 扩展握手)。 */}
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("tools.browserRelayExtension")}</div>
						<div className="gui-settings-row-desc">
							{relayStatus === null
								? "…"
								: !relayStatus.installed
									? t("tools.browserRelayExtensionDescription")
									: relayStatus.connected
										? t("tools.browserRelayConnected")
										: relayStatus.serving
											? t("tools.browserRelayServingWaiting")
											: t("tools.browserRelayInstalledNot")}
						</div>
					</div>
					{relayStatus?.installed ? (
						<button
							type="button"
							className="gui-btn gui-btn--small gui-btn--danger"
							disabled={installing}
							onClick={uninstallRelay}
						>
							{installing ? "…" : t("tools.uninstall")}
						</button>
					) : (
						<button type="button" className="gui-btn gui-btn--small" disabled={installing} onClick={installRelay}>
							{installing ? "…" : t("tools.install")}
						</button>
					)}
				</div>
			</div>
			{/* Computer-use screen glow: full-screen edge + target highlight
			 * while the agent operates the desktop (computer.glow) — its own
			 * section, this tab covers desktop automation too. */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("tools.desktopOperationHints")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("tools.computerGlow")}</div>
						<div className="gui-settings-row-desc">{t("tools.computerGlowDescription")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={glow === true}
						className={`gui-toggle${glow === true ? " gui-toggle--on" : ""}`}
						onClick={() => setBool("computer.glow", !(glow === true))}
						aria-label={t("tools.computerGlow")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				{glow === true && (
					<div className="gui-computer-glow-preview" aria-hidden="true">
						<div className="gui-cgp-edge" />
						<div className="gui-cgp-badge">
							<span className="gui-cgp-dot" />
							<span>AI 正在操作桌面</span>
						</div>
						<div className="gui-cgp-finder">
							<div className="gui-cgp-finder-bar">
								<span className="gui-cgp-light gui-cgp-light--close" />
								<span className="gui-cgp-light gui-cgp-light--min" />
								<span className="gui-cgp-light gui-cgp-light--max" />
								<span className="gui-cgp-finder-title">Finder</span>
							</div>
							<div className="gui-cgp-finder-body">
								<div className="gui-cgp-finder-side" />
								<div className="gui-cgp-finder-files">
									<i />
									<i />
									<i />
									<i />
									<i />
									<i />
								</div>
							</div>
						</div>
						<div className="gui-cgp-ring" />
					</div>
				)}
			</div>
			{/* Browser data (zcode 浏览器数据 parity): one-time Chrome
			 * import, cache clear, full clear. */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("tools.browserData")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("tools.importChromeData")}</div>
						<div className="gui-settings-row-desc">{t("tools.importChromeDataDescription")}</div>
					</div>
					<button
						type="button"
						className="gui-btn gui-btn--small"
						disabled={importing}
						onClick={() => {
							if (!rpc || importing) return;
							setImporting(true);
							void rpc
								.request<{ ok?: boolean; importedFrom?: string; error?: string }>("browser.importChrome", {})
								.then(res => setImportMsg(res?.ok ? (res.importedFrom ?? "") : (res?.error ?? "")))
								.finally(() => setImporting(false));
						}}
					>
						{importing ? "…" : t("tools.importBrowserData")}
					</button>
				</div>
				{importMsg && <div className="px-3 pb-2 text-[11.5px] text-[var(--color-text-faint)]">{importMsg}</div>}
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("tools.clearBrowserCache")}</div>
						<div className="gui-settings-row-desc">{t("tools.clearBrowserCacheDescription")}</div>
					</div>
					<button
						type="button"
						className="gui-btn gui-btn--small"
						disabled={clearing}
						onClick={() => {
							if (!rpc || clearing) return;
							setClearing(true);
							void rpc.request("browser.clearCache", {}).finally(() => setClearing(false));
						}}
					>
						{clearing ? "…" : t("tools.clearCache")}
					</button>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("tools.clearAllBrowserData")}</div>
						<div className="gui-settings-row-desc">{t("tools.clearAllBrowserDataDescription")}</div>
					</div>
					<button
						type="button"
						className="gui-btn gui-btn--small gui-btn--danger"
						disabled={clearing}
						onClick={() => {
							if (!rpc || clearing) return;
							setClearing(true);
							void rpc.request("browser.clearAll", {}).finally(() => setClearing(false));
						}}
					>
						{clearing ? "…" : t("tools.clearAll")}
					</button>
				</div>
			</div>
			{/* Shared browser status + installed extensions */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("tools.runningState")}</div>
				{/* 通道一:托管浏览器桥(桌面应用右栏内置浏览器,agent 默认接管) */}
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("tools.managedBrowserBridge")}</div>
						<div className="gui-settings-row-desc">
							{bridgePort !== null
								? t("tools.managedBrowserBridgeRunningWithPort", { port: String(bridgePort) })
								: t("tools.managedBrowserBridgeIdle")}
							{" · "}
							{agentTab ? t("tools.managedBrowserAgentTab") : t("tools.managedBrowserAgentTabIdle")}
						</div>
					</div>
					{bridgePort !== null && <span className="gui-provider-chip">{t("tools.running")}</span>}
				</div>
				{/* 通道二:共享无头浏览器(没有托管桥时的兜底) */}
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("tools.sharedHeadlessBrowser")}</div>
						<div className="gui-settings-row-desc">
							{endpoint
								? t("tools.sharedBrowserRunningTabsWithTabs", { tabs: tabCount ?? 0 })
								: t("tools.sharedBrowserIdle")}
						</div>
					</div>
					{endpoint && <span className="gui-provider-chip">{t("tools.running")}</span>}
				</div>
				{profileDir && (
					<div className="px-3 pb-2">
						<div className="truncate text-[11px] text-[var(--color-text-faint)]" title={profileDir}>
							{profileDir}
						</div>
					</div>
				)}
				<div className="gui-group-label px-3 pb-1 pt-2">{t("tools.extensions")}</div>
				{extensions === null ? (
					<div className="px-3 text-[12px] text-[var(--color-text-faint)]">…</div>
				) : extensions.length === 0 ? (
					<div className="px-3 pb-2 text-[12px] text-[var(--color-text-faint)]">{t("tools.noExtensions")}</div>
				) : (
					extensions.map(ext => (
						<div key={ext.id} className="gui-agent-card">
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-1.5">
									<span className="truncate text-[13px] font-medium">{ext.name}</span>
									<span className="gui-provider-chip">{ext.version}</span>
								</div>
								<div className="truncate text-[11px] text-[var(--color-text-faint)]">{ext.id}</div>
							</div>
						</div>
					))
				)}
			</div>
		</>
	);
}
