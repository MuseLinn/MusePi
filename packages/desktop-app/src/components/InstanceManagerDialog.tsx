import { Segmented, t } from "@musepi/client-core";
import { LoaderCircle as LoaderCircleIconData, Plus as PlusIconData } from "lucide";
import { Layers, Server } from "lucide-react";
import { MorphIcon } from "morphicons/react";
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
			<div
				key={host?.id ?? "local"}
				className={`gui-instance-manager-row${active ? " gui-instance-manager-row--current" : ""}`}
			>
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
						className={`gui-instance-manager-dot${active && connected ? " gui-instance-manager-dot--live" : ""}`}
						aria-hidden
					/>
					<span className="gui-instance-manager-copy">
						<span className="gui-instance-manager-name">
							{label}
							{active && <span className="gui-instance-manager-chip">{t("settings.currentInstanceBadge")}</span>}
						</span>
						<span className="gui-instance-manager-url">{url}</span>
					</span>
				</button>
				{host && (
					<button
						type="button"
						className="gui-tool-btn gui-instance-manager-remove"
						title={t("general.remove")}
						aria-label={t("general.remove")}
						onClick={() => onRemoveHost(host.id)}
					>
						<Icon name="delete-bin" className="h-3.5 w-3.5" />
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
			<div className="gui-instance-manager-tabs">
				<Segmented<"instances" | "remote">
					value={tab}
					onChange={setTab}
					ariaLabel={t("settings.instanceManager")}
					options={[
						{ value: "instances", label: t("settings.instances"), icon: Layers },
						{ value: "remote", label: t("settings.remoteWorkspaces"), icon: Server },
					]}
				/>
			</div>
			{tab === "instances" ? (
				<div className="gui-instance-manager-body">
					<section className="gui-instance-manager-panel">
						<header className="gui-instance-manager-section">
							<h3 className="gui-instance-manager-section-title">{t("settings.instances")}</h3>
							<p className="gui-instance-manager-section-desc">{t("settings.instanceListDescription")}</p>
						</header>
						<div className="gui-instance-manager-list">
							{renderHost(null)}
							{hosts.map(renderHost)}
						</div>
						<div className="gui-instance-manager-panel-actions">
							<button
								type="button"
								className="gui-btn gui-btn-stop"
								onClick={() => {
									onDisconnect();
									onClose();
								}}
							>
								{t("settings.disconnectCurrent")}
							</button>
						</div>
					</section>
					<section className="gui-instance-manager-panel gui-instance-manager-add">
						<header className="gui-instance-manager-section">
							<h3 className="gui-instance-manager-section-title">{t("settings.addInstance")}</h3>
						</header>
						<div className="gui-instance-manager-fields">
							<label className="gui-field">
								<span className="gui-field-label">{t("settings.instanceLabel")}</span>
								<input
									className="gui-input"
									value={draft.label}
									placeholder={t("settings.instanceLabel")}
									onChange={e => setDraft(current => ({ ...current, label: e.target.value }))}
								/>
							</label>
							<label className="gui-field">
								<span className="gui-field-label">{t("settings.instanceUrlLabel")}</span>
								<input
									className="gui-input font-mono"
									value={draft.url}
									placeholder={t("settings.hostUrlPlaceholder")}
									spellCheck={false}
									onChange={e => setDraft(current => ({ ...current, url: e.target.value }))}
								/>
							</label>
							<label className="gui-field">
								<span className="gui-field-label">{t("settings.remoteToken")}</span>
								<input
									className="gui-input font-mono"
									value={draft.token}
									placeholder={t("settings.remoteToken")}
									type="password"
									onChange={e => setDraft(current => ({ ...current, token: e.target.value }))}
								/>
							</label>
						</div>
						{error && (
							<div className="gui-instance-manager-error" role="alert">
								{error}
							</div>
						)}
						<div className="gui-instance-manager-actions">
							<button
								type="button"
								className="gui-btn gui-btn-primary"
								disabled={adding || !draft.label.trim() || !draft.url.trim()}
								onClick={() => void addInstance()}
							>
								<MorphIcon
									icon={adding ? LoaderCircleIconData : PlusIconData}
									size={14}
									spring="snappy"
									reducedMotion="user"
									className={adding ? "gui-spin" : undefined}
								/>
								{adding ? t("settings.connecting2") : t("settings.testAndAddInstance")}
							</button>
						</div>
					</section>
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
