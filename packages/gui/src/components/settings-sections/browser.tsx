import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
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
	const [relayDir, setRelayDir] = useState<string | null>(null);
	const [installing, setInstalling] = useState(false);
	const [importing, setImporting] = useState(false);
	const [importMsg, setImportMsg] = useState<string | null>(null);
	const [clearing, setClearing] = useState(false);
	const [glow, setGlow] = useState<boolean | null>(null);

	const refresh = (): void => {
		if (!rpc) return;
		void rpc
			.request<{ [k: string]: unknown }>("settings.get", {
				keys: [
					"browser.headless",
					"browser.relay",
					"browser.gui",
					"browser.policy.restrictToPublic",
					"computer.glow",
				],
			})
			.then(res => {
				setHeadless(res["browser.headless"] === true);
				setRelay(res["browser.relay"] === true);
				setGui(res["browser.gui"] === true);
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
			.request<{ dir: string }>("browser.relayInstall", {})
			.then(res => setRelayDir(res?.dir ?? null))
			.finally(() => setInstalling(false));
	};

	return (
		<>
			<h2 className="gui-settings-page-title">{t("browser")}</h2>
			<p className="gui-settings-page-desc">{t("browser settings description")}</p>
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("browser engine")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("headless browser")}</div>
						<div className="gui-settings-row-desc">{t("headless browser description")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={headless === true}
						className={`gui-toggle${headless === true ? " gui-toggle--on" : ""}`}
						onClick={() => setBool("browser.headless", !(headless === true))}
						aria-label={t("headless browser")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("browser relay")}</div>
						<div className="gui-settings-row-desc">{t("browser relay description")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={relay === true}
						className={`gui-toggle${relay === true ? " gui-toggle--on" : ""}`}
						onClick={() => setBool("browser.relay", !(relay === true))}
						aria-label={t("browser relay")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("managed browser")}</div>
						<div className="gui-settings-row-desc">{t("managed browser description")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={gui === true}
						className={`gui-toggle${gui === true ? " gui-toggle--on" : ""}`}
						onClick={() => setBool("browser.gui", !(gui === true))}
						aria-label={t("managed browser")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("public internet only")}</div>
						<div className="gui-settings-row-desc">{t("public internet only description")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={restrictToPublic === true}
						className={`gui-toggle${restrictToPublic === true ? " gui-toggle--on" : ""}`}
						onClick={() => setBool("browser.policy.restrictToPublic", !(restrictToPublic === true))}
						aria-label={t("public internet only")}
					>
						<span className="gui-toggle-knob" />
					</button>
				</div>
				{/* Relay extension install (chrome.debugger bridge — the agent
				 * drives your own Chrome tabs, kimi webbridge 同款). */}
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("browser relay extension")}</div>
						<div className="gui-settings-row-desc">
							{relayDir ? (
								<span className="break-all">{t("browser relay installed at {dir}", { dir: relayDir })}</span>
							) : (
								t("browser relay extension description")
							)}
						</div>
					</div>
					<button type="button" className="gui-btn gui-btn--small" disabled={installing} onClick={installRelay}>
						{installing ? "…" : t("install")}
					</button>
				</div>
			</div>
			{/* Computer-use screen glow: full-screen edge + target highlight
			 * while the agent operates the desktop (computer.glow) — its own
			 * section, this tab covers desktop automation too. */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("desktop operation hints")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("computer glow")}</div>
						<div className="gui-settings-row-desc">{t("computer glow description")}</div>
					</div>
					<button
						type="button"
						role="switch"
						aria-checked={glow === true}
						className={`gui-toggle${glow === true ? " gui-toggle--on" : ""}`}
						onClick={() => setBool("computer.glow", !(glow === true))}
						aria-label={t("computer glow")}
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
				<div className="gui-settings-section-title">{t("browser data")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("import chrome data")}</div>
						<div className="gui-settings-row-desc">{t("import chrome data description")}</div>
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
						{importing ? "…" : t("import browser data")}
					</button>
				</div>
				{importMsg && <div className="px-3 pb-2 text-[11.5px] text-[var(--color-text-faint)]">{importMsg}</div>}
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("clear browser cache")}</div>
						<div className="gui-settings-row-desc">{t("clear browser cache description")}</div>
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
						{clearing ? "…" : t("clear cache")}
					</button>
				</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("clear all browser data")}</div>
						<div className="gui-settings-row-desc">{t("clear all browser data description")}</div>
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
						{clearing ? "…" : t("clear all")}
					</button>
				</div>
			</div>
			{/* Shared browser status + installed extensions */}
			<div className="gui-settings-section">
				<div className="gui-settings-section-title">{t("running state")}</div>
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("shared browser")}</div>
						<div className="gui-settings-row-desc">
							{endpoint
								? t("shared browser running · {tabs} tabs", { tabs: tabCount ?? 0 })
								: t("shared browser idle")}
						</div>
					</div>
					{endpoint && <span className="gui-provider-chip">{t("running")}</span>}
				</div>
				{profileDir && (
					<div className="px-3 pb-2">
						<div className="truncate text-[11px] text-[var(--color-text-faint)]" title={profileDir}>
							{profileDir}
						</div>
					</div>
				)}
				<div className="gui-group-label px-3 pb-1 pt-2">{t("extensions")}</div>
				{extensions === null ? (
					<div className="px-3 text-[12px] text-[var(--color-text-faint)]">…</div>
				) : extensions.length === 0 ? (
					<div className="px-3 pb-2 text-[12px] text-[var(--color-text-faint)]">{t("no extensions")}</div>
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
