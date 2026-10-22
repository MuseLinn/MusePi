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
import { getHostState, subscribeHost } from "../lib/managed-browser-host";
import { buildWsUrl, type RemoteHost } from "../lib/remote-hosts";
import type { RpcClient } from "../lib/rpc";
import { Icon } from "../vendor/oc-icons";
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
}): ReactNode {
	const btnRef = useRef<HTMLButtonElement | null>(null);
	const [open, setOpen] = useState(false);
	const browserHost = useSyncExternalStore(subscribeHost, getHostState, getHostState);

	// Real version + round-trip latency from system.meta, refreshed whenever
	// the menu opens or the refresh button is hit.
	const [daemonVersion, setDaemonVersion] = useState<string | null>(null);
	const [daemonLatency, setDaemonLatency] = useState<number | null>(null);
	const [metaLoading, setMetaLoading] = useState(false);
	const refreshMeta = useCallback((): void => {
		if (!rpc) return;
		setMetaLoading(true);
		const t0 = performance.now();
		void rpc
			.request<{ version?: string }>("system.meta")
			.then(meta => {
				setDaemonVersion(meta?.version ?? null);
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

	// Remote-update badge: daemon version vs the latest GitHub release.
	const [latestVersion, setLatestVersion] = useState<string | null>(null);
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		void fetch("https://api.github.com/repos/MuseLinn/MusePi/releases/latest")
			.then(r => (r.ok ? (r.json() as Promise<{ tag_name?: string }>) : null))
			.then(rel => {
				if (!cancelled && rel?.tag_name) setLatestVersion(rel.tag_name.replace(/^v/, ""));
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [open]);

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

	const [addHostOpen, setAddHostOpen] = useState(false);
	const [hostDraft, setHostDraft] = useState({ label: "", url: "", token: "" });

	return (
		<div className="gui-instance">
			<button
				type="button"
				ref={btnRef}
				className="gui-instance-btn gui-instance-btn--recessed"
				title={t("general.instanceInfo")}
				aria-label={t("general.instanceInfo")}
				aria-expanded={open}
				onClick={() => setOpen(v => !v)}
			>
				<span
					className={`h-2 w-2 shrink-0 rounded-full ${connected ? "bg-[var(--color-success)]" : "bg-[var(--color-danger)]"}`}
				/>
				<span>{t("general.local")}</span>
				<Icon name="arrow-down-s" className="h-3 w-3 opacity-60" />
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
					<span className="shrink-0 text-[10.5px] text-[var(--color-text-faint)]">{daemonVersion ?? "—"}</span>
					{latestVersion && daemonVersion && latestVersion !== daemonVersion && (
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
				{addHostOpen ? (
					<div className="mx-2 mb-1 flex flex-col gap-1.5 rounded-lg bg-[var(--color-surface-sunken)] p-2">
						<input
							className="gui-input w-full"
							placeholder={t("settings.instanceLabel")}
							value={hostDraft.label}
							onChange={e => setHostDraft(d => ({ ...d, label: e.target.value }))}
						/>
						<input
							className="gui-input w-full font-mono"
							placeholder={t("settings.hostUrlPlaceholder")}
							value={hostDraft.url}
							onChange={e => setHostDraft(d => ({ ...d, url: e.target.value }))}
						/>
						<input
							className="gui-input w-full font-mono"
							placeholder={t("settings.remoteToken")}
							type="password"
							value={hostDraft.token}
							onChange={e => setHostDraft(d => ({ ...d, token: e.target.value }))}
						/>
						<div className="flex gap-1.5">
							<button
								type="button"
								className="gui-btn gui-btn-primary gui-btn-sm flex-1"
								disabled={!hostDraft.label.trim() || !hostDraft.url.trim()}
								onClick={() => {
									onAddHost({
										label: hostDraft.label.trim(),
										url: hostDraft.url.trim(),
										token: hostDraft.token.trim() || undefined,
									});
									setHostDraft({ label: "", url: "", token: "" });
									setAddHostOpen(false);
								}}
							>
								{t("settings.add")}
							</button>
							<button type="button" className="gui-btn gui-btn-sm" onClick={() => setAddHostOpen(false)}>
								{t("settings.cancel")}
							</button>
						</div>
					</div>
				) : (
					<button type="button" className="gui-view-opt" onClick={() => setAddHostOpen(true)}>
						<Icon name="add-circle" className="h-3.5 w-3.5" />
						<span>{t("settings.addInstance")}</span>
					</button>
				)}
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
		</div>
	);
}
