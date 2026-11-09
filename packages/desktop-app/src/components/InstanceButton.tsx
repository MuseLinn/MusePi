/**
 * InstanceButton — daemon 实例信息入口（本地/远程切换、版本、延迟、
 * 浏览器桥诊断）。独立组件：状态全自管（meta 轮询、hosts 表单、
 * browserHost 外部 store），宿主只需喂连接事实与 host 增删改回调。
 *
 * 位置：左侧面板底部栏（顶栏减法后从 header 迁来）——连接状态收起
 * 在侧栏 footer，与设置入口并列成两段布局。
 */
import { t } from "@musepi/client-core";
import { type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { projectRuntimeVersions } from "../lib/daemon-version";
import { checkAppUpdates, getShellVersion } from "../lib/electron";
import { getHostState, subscribeHost } from "../lib/managed-browser-host";
import { buildWsUrl, type RemoteHost } from "../lib/remote-hosts";
import type { RpcClient } from "../lib/rpc";
import { Icon } from "../vendor/oc-icons";
import { InstanceManagerDialog } from "./InstanceManagerDialog";
import { MenuPopup } from "./MenuPopup";

export function InstanceButton({
	rpc,
	connected,
	daemonUrl,
	hosts,
	onSwitchHost,
	onAddHost,
	onRemoveHost,
	onOpenSettings,
	onReconnect,
	onDisconnect,
	onOpenWorkspace,
	onOpenManager,
	onOpenDisclaimer,
	/** Rail variant: the destination column must keep the instance menu
	 *  reachable when the sidebar is collapsed or a page destination owns
	 *  the surface. Only the status dot shows; the full menu is unchanged. */
	compact = false,
}: {
	rpc: RpcClient | null;
	connected: boolean;
	daemonUrl: string;
	hosts: RemoteHost[];
	onSwitchHost(host: RemoteHost | null): void;
	onAddHost(host: { label: string; url: string; token?: string }): void;
	onRemoveHost(id: string): void;
	onOpenSettings(): void;
	onReconnect(): void;
	onDisconnect(): void;
	onOpenWorkspace(cwd: string): void;
	onOpenManager(open: () => void): void;
	onOpenDisclaimer(): void;
	compact?: boolean;
}): ReactNode {
	const btnRef = useRef<HTMLButtonElement | null>(null);
	const [open, setOpen] = useState(false);
	const [managerOpen, setManagerOpen] = useState(false);
	const browserHost = useSyncExternalStore(subscribeHost, getHostState, getHostState);

	// Shell and daemon facts remain separate; only the shell drives app updates.
	const [displayVersion, setDisplayVersion] = useState<string | null>(null);
	const [latestVersion, setLatestVersion] = useState<string | null>(null);
	const [appUpdateAvailable, setAppUpdateAvailable] = useState(false);
	const [daemonLatency, setDaemonLatency] = useState<number | null>(null);
	const [metaLoading, setMetaLoading] = useState(false);
	const refreshMeta = useCallback((): void => {
		if (!rpc) return;
		setMetaLoading(true);
		const t0 = performance.now();
		void Promise.all([
			rpc.request<{ version?: string; musepiVersion?: string | null }>("system.meta"),
			getShellVersion(),
			checkAppUpdates().catch(() => null),
		])
			.then(([meta, appVersion, update]) => {
				const projected = projectRuntimeVersions({ appVersion, meta, update });
				setDisplayVersion(projected.displayVersion);
				setLatestVersion(projected.latestVersion);
				setAppUpdateAvailable(projected.appUpdateAvailable);
				setDaemonLatency(Math.max(0, Math.round(performance.now() - t0)));
			})
			.catch(() => {
				setDaemonLatency(null);
			})
			.finally(() => setMetaLoading(false));
	}, [rpc]);
	useEffect(() => {
		if (open) refreshMeta();
	}, [open, refreshMeta]);

	// Reachability dots for saved remote hosts (probe on open).
	const [hostReach, setHostReach] = useState<Record<string, boolean>>({});
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		for (const h of hosts) {
			if (buildWsUrl(h) === daemonUrl) continue;
			fetch(`${h.url.replace(/^ws/, "http")}/healthz`, { mode: "no-cors" })
				.then(() => {
					if (!cancelled) setHostReach(prev => ({ ...prev, [h.id]: true }));
				})
				.catch(() => {});
		}
		return () => {
			cancelled = true;
		};
	}, [open, hosts, daemonUrl]);

	return (
		<div className={`gui-instance${compact ? " gui-instance--compact" : ""}`}>
			<button
				type="button"
				ref={btnRef}
				className={compact ? "gui-instance-btn gui-rail-btn" : "gui-instance-btn gui-instance-btn--recessed"}
				title={t("general.instanceInfo")}
				aria-label={t("general.instanceInfo")}
				aria-expanded={open}
				onClick={() => setOpen(v => !v)}
			>
				<span
					className={`h-2 w-2 shrink-0 rounded-full ${connected ? "bg-[var(--color-success)]" : "bg-[var(--color-danger)]"}`}
				/>
				{!compact && <span>{t("general.local")}</span>}
				{!compact && <Icon name="arrow-down-s" className="h-3 w-3 opacity-60" />}
			</button>
			<MenuPopup
				open={open}
				className="gui-instance-menu"
				portal
				anchor={btnRef.current}
				align="left"
				onOpenChange={setOpen}
			>
				{/* Current-instance header row: local daemon + manual re-probe. */}
				<div className="flex items-center gap-2 px-2 py-1.5">
					<span className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--color-surface-sunken)]">
						<Icon name="stack" className="h-3.5 w-3.5" />
					</span>
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-1.5 text-[12.5px] font-medium">
							{t("settings.localDaemon")}
							{connected && (
								<span className="rounded-full bg-[var(--color-success)]/15 px-1.5 text-[10px] font-semibold text-[var(--color-success)]">
									{t("settings.currentInstanceBadge")}
								</span>
							)}
						</div>
						<div className="truncate text-[11px] text-[var(--color-text-faint)]">
							{connected
								? daemonLatency !== null
									? t("general.connectedMsWithMs", { ms: String(daemonLatency) })
									: t("transcript.connected")
								: t("settings.disconnected")}
						</div>
					</div>
					<button
						type="button"
						className="gui-view-opt !w-auto px-1.5"
						aria-label={t("settings.refresh")}
						title={t("settings.refresh")}
						onClick={refreshMeta}
					>
						<Icon
							name={metaLoading ? "loader-4" : "refresh"}
							className={`h-3.5 w-3.5${metaLoading ? " animate-spin" : ""}`}
						/>
					</button>
				</div>
				{/* Host row: the single local host with status dot + version + endpoint URL. */}
				<div className="mx-2 mb-1 flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--color-surface-sunken)]">
					<span
						className={`h-2 w-2 shrink-0 rounded-full ${connected ? "bg-[var(--color-success)]" : "bg-[var(--color-danger)]"}`}
					/>
					<div className="min-w-0 flex-1">
						<div className="truncate text-[12.5px]">{t("general.local")}</div>
						<div className="truncate font-mono text-[10.5px] text-[var(--color-text-faint)]">{daemonUrl}</div>
					</div>
					<span className="shrink-0 text-[10.5px] text-[var(--color-text-faint)]">{displayVersion ?? "—"}</span>
					{appUpdateAvailable && latestVersion && (
						<span
							className="gui-update-badge"
							title={t("general.updateAvailable", {
								version: `v${latestVersion}`,
							})}
						>
							{t("general.updateAvailable", { version: `v${latestVersion}` })}
						</span>
					)}
				</div>
				{/* Managed-browser bridge diagnostics: port + tab count + last error. */}
				<div className="mx-2 mb-1 flex items-center gap-2 rounded-lg px-2 py-1.5">
					<span
						className={`h-2 w-2 shrink-0 rounded-full ${browserHost.port ? "bg-[var(--color-success)]" : "bg-[var(--color-text-faint)]"}`}
					/>
					<div className="min-w-0 flex-1">
						<div className="truncate text-[12.5px]">{t("tools.browserBridge")}</div>
						<div className="truncate font-mono text-[10.5px] text-[var(--color-text-faint)]">
							{browserHost.port
								? t("tools.browserBridgeInfo", {
										port: String(browserHost.port),
										tabs: String(browserHost.tabs.length),
									})
								: t("tools.browserBridgeOffline")}
						</div>
					</div>
				</div>
				{browserHost.error && (
					<div
						className="mx-2 mb-1 truncate rounded-lg bg-[var(--color-danger)]/10 px-2 py-1 font-mono text-[10.5px] text-[var(--color-danger)]"
						title={browserHost.error}
					>
						{browserHost.error}
					</div>
				)}
				{hosts.length > 0 && (
					<>
						<div className="my-1 border-t border-[var(--border)]" />
						<div className="px-2 py-1 text-[10.5px] uppercase tracking-wider text-[var(--color-text-faint)]">
							{t("settings.instances")}
						</div>
						{hosts.map(h => {
							const active = buildWsUrl(h) === daemonUrl;
							return (
								<div
									key={h.id}
									className="group mx-2 mb-1 flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--color-surface-sunken)]"
									role="button"
									tabIndex={0}
									onClick={() => {
										if (!active) {
											setOpen(false);
											onSwitchHost(h);
										}
									}}
									onKeyDown={e => {
										if (e.key === "Enter" && !active) {
											setOpen(false);
											onSwitchHost(h);
										}
									}}
								>
									<span
										className={`h-2 w-2 shrink-0 rounded-full ${active ? "bg-[var(--color-success)]" : hostReach[h.id] === true ? "bg-[var(--color-warning)]" : "bg-[var(--color-text-faint)]"}`}
									/>
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-1.5">
											<span className="truncate text-[12.5px]">{h.label}</span>
											{active && (
												<span className="rounded-full bg-[var(--color-success)]/15 px-1.5 text-[10px] font-semibold text-[var(--color-success)]">
													{t("settings.currentInstanceBadge")}
												</span>
											)}
										</div>
										<div className="truncate font-mono text-[10.5px] text-[var(--color-text-faint)]">
											{h.url}
										</div>
									</div>
									<button
										type="button"
										className="gui-view-opt !w-auto px-1.5 opacity-0 group-hover:opacity-100"
										aria-label={t("general.remove")}
										title={t("general.remove")}
										onClick={e => {
											e.stopPropagation();
											onRemoveHost(h.id);
										}}
									>
										<Icon name="close" className="h-3 w-3" />
									</button>
								</div>
							);
						})}
					</>
				)}
				<div className="my-1 border-t border-[var(--border)]" />
				<button
					type="button"
					className="gui-view-opt"
					onClick={() => {
						setOpen(false);
						onOpenManager(() => setManagerOpen(true));
					}}
				>
					<Icon name="settings-3" className="h-3.5 w-3.5" />
					<span>{t("settings.instanceManager")}</span>
				</button>
				<div className="my-1 border-t border-[var(--border)]" />
				<button
					type="button"
					className="gui-view-opt"
					onClick={() => {
						setOpen(false);
						onOpenSettings();
					}}
				>
					<Icon name="settings-3" className="h-3.5 w-3.5" />
					<span>{t("settings.settings")}</span>
				</button>
				<button
					type="button"
					className="gui-view-opt"
					onClick={() => {
						setOpen(false);
						onOpenDisclaimer();
					}}
				>
					<Icon name="information" className="h-3.5 w-3.5" />
					<span>{t("settings.viewRemoteDisclaimer")}</span>
				</button>
				<button
					type="button"
					className="gui-view-opt"
					onClick={() => {
						setOpen(false);
						onReconnect();
					}}
				>
					<Icon name="restart" className="h-3.5 w-3.5" />
					<span>{t("general.reconnect")}</span>
				</button>
				<div className="my-1 border-t border-[var(--border)]" />
				<button
					type="button"
					className="gui-view-opt"
					onClick={() => {
						setOpen(false);
						// Electron: closing the only window quits the app.
						window.close();
					}}
				>
					<Icon name="close" className="h-3.5 w-3.5" />
					<span>{t("general.quitApp")}</span>
				</button>
			</MenuPopup>
			<InstanceManagerDialog
				open={managerOpen}
				onClose={() => setManagerOpen(false)}
				rpc={rpc}
				connected={connected}
				daemonUrl={daemonUrl}
				hosts={hosts}
				onSwitchHost={onSwitchHost}
				onAddHost={onAddHost}
				onRemoveHost={onRemoveHost}
				onDisconnect={onDisconnect}
				onOpenDisclaimer={onOpenDisclaimer}
				onOpenWorkspace={cwd => {
					setManagerOpen(false);
					onOpenWorkspace(cwd);
				}}
			/>
		</div>
	);
}
