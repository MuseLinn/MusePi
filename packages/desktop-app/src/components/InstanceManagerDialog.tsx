import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { buildWsUrl, normalizeRemoteHostUrl, type RemoteHost } from "../lib/remote-hosts";
import { RpcClient } from "../lib/rpc";
import { Icon } from "../vendor/oc-icons";
import { ConnectDialog } from "./ConnectDialog";
import { DialogFrame } from "./DialogFrame";

/** One management surface for daemon connections and SSH-backed workspaces. */
export function InstanceManagerDialog({
	open,
	onClose,
	rpc,
	connected,
	daemonUrl,
	hosts,
	onSwitchHost,
	onAddHost,
	onRemoveHost,
	onDisconnect,
	onOpenWorkspace,
}: {
	open: boolean;
	onClose(): void;
	rpc: RpcClient | null;
	connected: boolean;
	daemonUrl: string;
	hosts: RemoteHost[];
	onSwitchHost(host: RemoteHost | null): void;
	onAddHost(host: { label: string; url: string; token?: string }): void;
	onRemoveHost(id: string): void;
	onDisconnect(): void;
	onOpenWorkspace(cwd: string): void;
}): ReactNode {
	const [tab, setTab] = useState<"instances" | "remote">("instances");
	const [draft, setDraft] = useState({ label: "", url: "", token: "" });
	const [adding, setAdding] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		setTab("instances");
		setError(null);
	}, [open]);

	const addInstance = async (): Promise<void> => {
		let url: string;
		try {
			url = normalizeRemoteHostUrl(draft.url);
		} catch {
			setError(t("settings.instanceUrlInvalid"));
			return;
		}
		const label = draft.label.trim();
		const token = draft.token.trim() || undefined;
		if (!label) return;
		setAdding(true);
		setError(null);
		const probe = new RpcClient(buildWsUrl({ id: "probe", label, url, token }));
		let timer: Timer | null = null;
		try {
			await Promise.race([
				(async () => {
					await probe.connect();
					await probe.request("system.meta", {}, { timeoutMs: 5000 });
				})(),
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("Instance connection timed out")), 6000);
				}),
			]);
			onAddHost({ label, url, token });
			setDraft({ label: "", url: "", token: "" });
		} catch {
			setError(t("settings.instanceConnectionFailed"));
		} finally {
			if (timer !== null) clearTimeout(timer);
			probe.close();
			setAdding(false);
		}
	};

	const renderHost = (host: RemoteHost | null): ReactNode => {
		const active = host ? buildWsUrl(host) === daemonUrl : !hosts.some(h => buildWsUrl(h) === daemonUrl);
		const label = host?.label ?? t("general.local");
		const url = host?.url ?? daemonUrl;
		return (
			<div key={host?.id ?? "local"} className="gui-instance-manager-row">
				<button
					type="button"
					className="gui-instance-manager-select"
					onClick={() => {
						if (!active) {
							onSwitchHost(host);
							onClose();
						}
					}}
					disabled={active}
				>
					<span
						className={`h-2 w-2 shrink-0 rounded-full ${
							active && connected ? "bg-[var(--color-success)]" : "bg-[var(--color-text-faint)]"
						}`}
					/>
					<span className="min-w-0 flex-1 text-left">
						<span className="flex items-center gap-2 text-[13px] font-medium">
							{label}
							{active && (
								<span className="rounded-full bg-[var(--color-success)]/15 px-1.5 text-[10px] text-[var(--color-success)]">
									{t("settings.currentInstanceBadge")}
								</span>
							)}
						</span>
						<span className="block truncate font-mono text-[11px] text-[var(--color-text-faint)]">{url}</span>
					</span>
				</button>
				{host && (
					<button
						type="button"
						className="gui-tool-btn"
						title={t("general.remove")}
						aria-label={t("general.remove")}
						onClick={() => onRemoveHost(host.id)}
					>
						<Icon name="close" className="h-3.5 w-3.5" />
					</button>
				)}
			</div>
		);
	};

	return (
		<DialogFrame
			open={open}
			onClose={onClose}
			label={t("settings.instanceManager")}
			className="gui-dialog--instance-manager"
		>
			<div className="gui-dialog-head">
				<span className="text-[14px] font-semibold">{t("settings.instanceManager")}</span>
				<button type="button" className="gui-tool-btn" onClick={onClose} aria-label={t("settings.close")}>
					<Icon name="close" className="h-4 w-4" />
				</button>
			</div>
			<div className="gui-instance-manager-tabs" role="tablist" aria-label={t("settings.instanceManager")}>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "instances"}
					className={tab === "instances" ? "gui-view-opt gui-view-opt--active" : "gui-view-opt"}
					onClick={() => setTab("instances")}
				>
					<Icon name="stack" className="h-3.5 w-3.5" />
					<span>{t("settings.instances")}</span>
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "remote"}
					className={tab === "remote" ? "gui-view-opt gui-view-opt--active" : "gui-view-opt"}
					onClick={() => setTab("remote")}
				>
					<Icon name="server" className="h-3.5 w-3.5" />
					<span>{t("settings.remoteWorkspaces")}</span>
				</button>
			</div>
			{tab === "instances" ? (
				<div className="gui-instance-manager-body">
					<p className="gui-settings-page-desc">{t("settings.instanceListDescription")}</p>
					<div className="gui-instance-manager-list">
						{renderHost(null)}
						{hosts.map(renderHost)}
					</div>
					<div className="gui-instance-manager-add">
						<div className="gui-settings-row-label">{t("settings.addInstance")}</div>
						<div className="gui-instance-manager-fields">
							<input
								className="gui-input"
								value={draft.label}
								placeholder={t("settings.instanceLabel")}
								aria-label={t("settings.instanceLabel")}
								onChange={e => setDraft(current => ({ ...current, label: e.target.value }))}
							/>
							<input
								className="gui-input font-mono"
								value={draft.url}
								placeholder={t("settings.hostUrlPlaceholder")}
								aria-label={t("settings.hostUrlPlaceholder")}
								spellCheck={false}
								onChange={e => setDraft(current => ({ ...current, url: e.target.value }))}
							/>
							<input
								className="gui-input font-mono"
								value={draft.token}
								placeholder={t("settings.remoteToken")}
								aria-label={t("settings.remoteToken")}
								type="password"
								onChange={e => setDraft(current => ({ ...current, token: e.target.value }))}
							/>
						</div>
						{error && <div className="gui-instance-manager-error">{error}</div>}
						<div className="gui-instance-manager-actions">
							<button
								type="button"
								className="gui-btn"
								onClick={() => {
									onDisconnect();
									onClose();
								}}
							>
								{t("settings.disconnectCurrent")}
							</button>
							<button
								type="button"
								className="gui-btn gui-btn-primary"
								disabled={adding || !draft.label.trim() || !draft.url.trim()}
								onClick={() => void addInstance()}
							>
								{adding ? t("settings.connecting2") : t("settings.testAndAddInstance")}
							</button>
						</div>
					</div>
				</div>
			) : (
				<ConnectDialog
					open={open && tab === "remote"}
					framed={false}
					onClose={onClose}
					rpc={rpc}
					onOpenWorkspace={onOpenWorkspace}
				/>
			)}
		</DialogFrame>
	);
}
