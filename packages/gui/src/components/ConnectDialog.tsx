import { t } from "@musepi/collab-web";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { Icon } from "../vendor/oc-icons";
import { DialogFrame } from "./DialogFrame";

interface RemoteHostEntry {
	name: string;
	host: string;
	username?: string;
	port?: number;
	keyPath?: string;
	description?: string;
}

interface RemoteBrowseResult {
	path: string;
	parent: string | null;
	entries: Array<{ name: string; dir: boolean }>;
}

interface ConnectState {
	mountPath: string;
	os: string;
	shell: string;
}

/**
 * ZCode-style connection wizard: a 4-step modal (method → config →
 * connecting → directory) for attaching a remote workspace. SSH is real:
 * hosts come from the daemon's ssh.json (`remote.hosts`), connecting probes
 * the remote and mounts it via sshfs (`remote.connect`), and the directory
 * step browses the mounted tree (`remote.browse`) before opening a session
 * with cwd = the chosen remote directory. Docker stays a disabled card
 * (no container backend yet); collab-link joining plugs into the same shell
 * later.
 */
export function ConnectDialog({
	open,
	onClose,
	rpc,
	onOpenWorkspace,
}: {
	open: boolean;
	onClose(): void;
	rpc: RpcClient | null;
	onOpenWorkspace(cwd: string): void;
}): ReactNode {
	const [step, setStep] = useState(0);
	const [method, setMethod] = useState<"ssh" | "docker" | null>(null);
	// Host list (step 1).
	const [hosts, setHosts] = useState<RemoteHostEntry[] | null>(null);
	const [sshfs, setSshfs] = useState(true);
	const [hostsError, setHostsError] = useState<string | null>(null);
	const [selectedHost, setSelectedHost] = useState<string | null>(null);
	const [newHostMode, setNewHostMode] = useState(false);
	// New-host form.
	const [formName, setFormName] = useState("");
	const [formHost, setFormHost] = useState("");
	const [formUser, setFormUser] = useState("");
	const [formPort, setFormPort] = useState("");
	const [formKey, setFormKey] = useState("");
	const [savingHost, setSavingHost] = useState(false);
	// Connect (step 2).
	const [connecting, setConnecting] = useState(false);
	const [connectError, setConnectError] = useState<string | null>(null);
	const [connected, setConnected] = useState<ConnectState | null>(null);
	// Directory browse (step 3).
	const [browse, setBrowse] = useState<RemoteBrowseResult | null>(null);
	const [selectedDir, setSelectedDir] = useState<string | null>(null);
	const [browseBusy, setBrowseBusy] = useState(false);
	const [browseError, setBrowseError] = useState<string | null>(null);
	const [disconnecting, setDisconnecting] = useState(false);

	// Reset on open so a previous run never leaks into the next one.
	useEffect(() => {
		if (!open) return;
		setStep(0);
		setMethod(null);
		setHosts(null);
		setSshfs(true);
		setHostsError(null);
		setSelectedHost(null);
		setNewHostMode(false);
		setConnectError(null);
		setConnected(null);
		setBrowse(null);
		setSelectedDir(null);
		setBrowseError(null);
		setDisconnecting(false);
	}, [open]);

	// Load the saved-host list when the config step becomes visible.
	useEffect(() => {
		if (!open || step !== 1 || hosts !== null || !rpc) return;
		let cancelled = false;
		rpc.request<{ hosts: RemoteHostEntry[]; sshfs: boolean }>("remote.hosts")
			.then(res => {
				if (cancelled) return;
				setHosts(res.hosts ?? []);
				setSshfs(res.sshfs);
				if (res.hosts?.length === 1) setSelectedHost(res.hosts[0].name);
			})
			.catch(err => {
				if (!cancelled) setHostsError(err instanceof Error ? err.message : String(err));
			});
		return () => {
			cancelled = true;
		};
	}, [open, step, hosts, rpc]);

	const saveHost = async (): Promise<void> => {
		if (!rpc || !formName || !formHost) return;
		setSavingHost(true);
		setHostsError(null);
		try {
			await rpc.request("remote.hostAdd", {
				name: formName,
				host: formHost,
				username: formUser.length > 0 ? formUser : undefined,
				port: formPort.length > 0 ? Number(formPort) : undefined,
				keyPath: formKey.length > 0 ? formKey : undefined,
			});
			const res = await rpc.request<{ hosts: RemoteHostEntry[]; sshfs: boolean }>("remote.hosts");
			setHosts(res.hosts ?? []);
			setSelectedHost(formName);
			setNewHostMode(false);
			setFormName("");
			setFormHost("");
			setFormUser("");
			setFormPort("");
			setFormKey("");
		} catch (err) {
			setHostsError(err instanceof Error ? err.message : String(err));
		} finally {
			setSavingHost(false);
		}
	};

	const loadBrowse = async (p: string): Promise<void> => {
		if (!rpc || !selectedHost) return;
		setBrowseBusy(true);
		setBrowseError(null);
		try {
			const res = await rpc.request<RemoteBrowseResult>("remote.browse", { name: selectedHost, path: p });
			setBrowse(res);
			setSelectedDir(res.path);
		} catch (err) {
			setBrowseError(err instanceof Error ? err.message : String(err));
		} finally {
			setBrowseBusy(false);
		}
	};

	const doConnect = async (): Promise<void> => {
		if (!rpc || !selectedHost) return;
		setConnecting(true);
		setConnectError(null);
		try {
			const res = await rpc.request<ConnectState>("remote.connect", { name: selectedHost });
			setConnected(res);
			setStep(3);
			await loadBrowse("/");
		} catch (err) {
			setConnectError(err instanceof Error ? err.message : String(err));
		} finally {
			setConnecting(false);
		}
	};

	const doDisconnect = async (): Promise<void> => {
		if (!rpc || !selectedHost) return;
		setDisconnecting(true);
		try {
			await rpc.request("remote.disconnect", { name: selectedHost });
			setConnected(null);
			setBrowse(null);
			setSelectedDir(null);
			setStep(1);
		} catch (err) {
			setConnectError(err instanceof Error ? err.message : String(err));
		} finally {
			setDisconnecting(false);
		}
	};

	const openWorkspace = (): void => {
		if (!connected || !selectedDir) return;
		const cwd = selectedDir === "/" ? connected.mountPath : `${connected.mountPath}${selectedDir}`;
		onOpenWorkspace(cwd);
	};

	const steps = [t("select method"), t("fill config"), t("connecting…"), t("select directory")];
	const canNext =
		step === 0
			? method !== null
			: step === 1
				? newHostMode
					? formName.length > 0 && formHost.length > 0
					: selectedHost !== null
				: true;

	return (
		<DialogFrame open={open} onClose={onClose} label={t("remote connection")}>
			<div className="gui-dialog-head">
				<span className="text-[14px] font-semibold">{t("remote connection")}</span>
				<button type="button" className="gui-tool-btn" onClick={onClose} aria-label={t("close")}>
					<Icon name="close" className="h-4 w-4" />
				</button>
			</div>
			<div className="flex min-h-0 flex-1">
				{/* Step rail. */}
				<div className="w-36 flex-shrink-0 border-r border-[var(--border)] p-3">
					{steps.map((label, i) => (
						<div key={label} className="mb-3 flex items-center gap-2">
							<span
								className={`grid h-5 w-5 flex-shrink-0 place-items-center rounded-full text-[13px] ${
									i < step
										? "bg-[var(--color-ok)] text-[var(--color-bg)]"
										: i === step
											? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
											: "border border-[var(--border)] text-[var(--color-text-faint)]"
								}`}
							>
								{i < step ? "✓" : i + 1}
							</span>
							<span
								className={`text-[13px] ${i === step ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}
							>
								{label}
							</span>
						</div>
					))}
				</div>
				{/* Step content. */}
				<div className="flex min-w-0 flex-1 flex-col p-4">
					{step === 0 && (
						<>
							<h2 className="mb-1 text-[15px] font-semibold">{t("select connection method")}</h2>
							<p className="mb-4 text-[13px] text-[var(--color-text-muted)]">
								{t("choose how to reach the workspace")}
							</p>
							<div className="flex gap-3">
								<button
									type="button"
									className={`gui-conn-card${method === "ssh" ? " gui-conn-card--active" : ""}`}
									onClick={() => setMethod("ssh")}
								>
									<Icon name="server" className="h-5 w-5" />
									<span className="font-medium">SSH</span>
									<span className="text-[13px] text-[var(--color-text-muted)]">{t("remote host")}</span>
								</button>
								<button
									type="button"
									className="gui-conn-card relative opacity-60"
									disabled
									aria-disabled="true"
									title={t("docker coming soon")}
								>
									<span className="absolute right-2 top-2 rounded-full bg-[var(--color-surface-raised)] px-2 py-0.5 text-[11px] text-[var(--color-text-faint)] ring-1 ring-[var(--border)]">
										{t("docker coming soon")}
									</span>
									<Icon name="archive-stack" className="h-5 w-5" />
									<span className="font-medium">Docker</span>
									<span className="text-[13px] text-[var(--color-text-muted)]">{t("local container")}</span>
								</button>
							</div>
						</>
					)}
					{step === 1 && (
						<>
							<h2 className="mb-1 text-[15px] font-semibold">{t("remote host")}</h2>
							{hostsError && (
								<div className="mb-3 rounded-lg border border-[var(--color-danger-bd)] bg-[var(--color-danger-soft)] px-3 py-2 text-[13px] text-[var(--color-danger)]">
									{hostsError}
								</div>
							)}
							{!sshfs && (
								<div className="mb-3 rounded-lg border border-[var(--color-warn-bd)] bg-[var(--color-warn-soft)] px-3 py-2 text-[13px] text-[var(--color-warn)]">
									{t("sshfs missing hint")}
								</div>
							)}
							{hosts === null ? (
								<div className="flex flex-1 items-center justify-center">
									<Icon name="loader" className="h-6 w-6 animate-spin" />
								</div>
							) : newHostMode ? (
								<div className="flex max-w-sm flex-col gap-3">
									<div className="gui-field">
										<label className="gui-field-label" htmlFor="rc-name">
											{t("host name")}
										</label>
										<input
											id="rc-name"
											className="gui-input"
											value={formName}
											onChange={e => setFormName(e.target.value)}
											placeholder="nas"
											spellCheck={false}
										/>
									</div>
									<div className="gui-field">
										<label className="gui-field-label" htmlFor="rc-host">
											{t("host address")}
										</label>
										<input
											id="rc-host"
											className="gui-input"
											value={formHost}
											onChange={e => setFormHost(e.target.value)}
											placeholder="192.168.1.100"
											spellCheck={false}
										/>
									</div>
									<div className="grid grid-cols-2 gap-3">
										<div className="gui-field">
											<label className="gui-field-label" htmlFor="rc-user">
												{t("username")}
											</label>
											<input
												id="rc-user"
												className="gui-input"
												value={formUser}
												onChange={e => setFormUser(e.target.value)}
												placeholder="root"
												spellCheck={false}
											/>
										</div>
										<div className="gui-field">
											<label className="gui-field-label" htmlFor="rc-port">
												{t("port")}
											</label>
											<input
												id="rc-port"
												className="gui-input"
												value={formPort}
												onChange={e => setFormPort(e.target.value.replace(/[^0-9]/g, ""))}
												placeholder="22"
												inputMode="numeric"
												spellCheck={false}
											/>
										</div>
									</div>
									<div className="gui-field">
										<label className="gui-field-label" htmlFor="rc-key">
											{t("ssh key path")}
										</label>
										<input
											id="rc-key"
											className="gui-input"
											value={formKey}
											onChange={e => setFormKey(e.target.value)}
											placeholder="~/.ssh/id_ed25519"
											spellCheck={false}
										/>
									</div>
									<button
										type="button"
										className="text-[13px] text-[var(--color-accent)] hover:underline"
										onClick={() => setNewHostMode(false)}
									>
										← {t("saved hosts")}
									</button>
								</div>
							) : (
								<div className="flex min-h-0 flex-1 flex-col">
									{hosts.length === 0 ? (
										<p className="mb-3 text-[13px] text-[var(--color-text-muted)]">{t("no saved hosts")}</p>
									) : (
										<div className="max-h-56 min-h-0 overflow-y-auto pr-1">
											{hosts.map(h => (
												<button
													key={h.name}
													type="button"
													className={`mb-1.5 flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-[13px] transition-colors ${
														selectedHost === h.name
															? "border-[var(--color-accent)] bg-[var(--color-accent-soft)]"
															: "border-[var(--border)] bg-[var(--color-surface-raised)] hover:border-[var(--color-accent-bd)]"
													}`}
													onClick={() => setSelectedHost(h.name)}
												>
													<Icon
														name="server"
														className="h-4 w-4 flex-shrink-0 text-[var(--color-text-muted)]"
													/>
													<span className="min-w-0 flex-1 truncate">
														<span className="font-medium text-[var(--color-text)]">{h.name}</span>
														<span className="ml-2 text-[var(--color-text-muted)]">
															{h.username ? `${h.username}@` : ""}
															{h.host}
															{h.port ? `:${h.port}` : ""}
														</span>
													</span>
												</button>
											))}
										</div>
									)}
									<button
										type="button"
										className="mt-3 self-start text-[13px] text-[var(--color-accent)] hover:underline"
										onClick={() => setNewHostMode(true)}
									>
										+ {t("new host")}
									</button>
								</div>
							)}
						</>
					)}
					{step === 2 && (
						<div className="flex flex-1 items-center justify-center">
							<div className="text-center">
								{connecting ? (
									<>
										<Icon name="loader" className="mx-auto h-8 w-8 animate-spin" />
										<p className="mt-3 text-[13px] text-[var(--color-text-muted)]">
											{t("connecting to {host}…", { host: selectedHost ?? "" })}
										</p>
									</>
								) : (
									<>
										{connectError && (
											<div className="max-w-sm rounded-lg border border-[var(--color-danger-bd)] bg-[var(--color-danger-soft)] px-3 py-2 text-left text-[13px] text-[var(--color-danger)]">
												<div className="mb-1 font-medium">{t("connect failed")}</div>
												<div className="break-words whitespace-pre-wrap">{connectError}</div>
											</div>
										)}
										<button
											type="button"
											className="gui-btn gui-btn-primary mt-4"
											disabled={!selectedHost}
											onClick={() => void doConnect()}
										>
											{t("retry")}
										</button>
									</>
								)}
							</div>
						</div>
					)}
					{step === 3 && (
						<>
							<div className="mb-2 flex items-center gap-2">
								<h2 className="text-[15px] font-semibold">
									{t("select a remote directory to open as a workspace")}
								</h2>
								<div className="ml-auto flex items-center gap-1">
									{connected && (
										<span className="mr-1 rounded-full bg-[var(--color-ok-soft)] px-2 py-0.5 text-[11px] text-[var(--color-ok)]">
											{connected.os} · {t("connected")}
										</span>
									)}
									<button
										type="button"
										className="gui-tool-btn"
										onClick={() => void loadBrowse(browse?.parent ?? "/")}
										disabled={!browse?.parent || browseBusy}
										title={t("parent directory")}
									>
										<Icon name="arrow-up" className="h-4 w-4" />
									</button>
									<button
										type="button"
										className="gui-tool-btn"
										onClick={() => void loadBrowse("/")}
										disabled={browseBusy}
										title={t("refresh")}
									>
										<Icon name="refresh" className="h-4 w-4" />
									</button>
									<button
										type="button"
										className="gui-tool-btn"
										onClick={() => void doDisconnect()}
										disabled={disconnecting}
										title={t("disconnect")}
									>
										<Icon name="close-circle" className="h-4 w-4" />
									</button>
								</div>
							</div>
							<div className="mb-2 truncate rounded-lg bg-[var(--color-surface-raised)] px-3 py-1.5 text-[12px] text-[var(--color-text-muted)] ring-1 ring-[var(--border)]">
								{connected?.mountPath}
								{browse ? (browse.path === "/" ? "" : browse.path) : ""}
							</div>
							{browseError && (
								<div className="mb-3 rounded-lg border border-[var(--color-danger-bd)] bg-[var(--color-danger-soft)] px-3 py-2 text-[13px] text-[var(--color-danger)]">
									{browseError}
								</div>
							)}
							<div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-[var(--border)]">
								{browseBusy && browse === null ? (
									<div className="flex h-32 items-center justify-center">
										<Icon name="loader" className="h-6 w-6 animate-spin" />
									</div>
								) : browse && browse.entries.length === 0 ? (
									<p className="p-4 text-[13px] text-[var(--color-text-muted)]">∅</p>
								) : (
									(browse?.entries ?? []).map(entry => (
										<button
											key={entry.name}
											type="button"
											className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-[var(--color-surface-raised)] ${
												selectedDir ===
													(browse?.path === "/" ? `/${entry.name}` : `${browse?.path}/${entry.name}`) &&
												entry.dir
													? "bg-[var(--color-accent-soft)]"
													: ""
											}`}
											onClick={() => {
												const target =
													browse?.path === "/" ? `/${entry.name}` : `${browse?.path}/${entry.name}`;
												if (entry.dir) {
													setSelectedDir(target);
													void loadBrowse(target);
												} else {
													setSelectedDir(target);
												}
											}}
										>
											<Icon
												name={entry.dir ? "folder" : "file"}
												className={`h-4 w-4 flex-shrink-0 ${entry.dir ? "text-[var(--color-accent)]" : "text-[var(--color-text-faint)]"}`}
											/>
											<span
												className={`min-w-0 flex-1 truncate ${entry.dir ? "font-medium" : "text-[var(--color-text-muted)]"}`}
											>
												{entry.name}
											</span>
											{selectedDir ===
												(browse?.path === "/" ? `/${entry.name}` : `${browse?.path}/${entry.name}`) && (
												<Icon name="check" className="h-4 w-4 flex-shrink-0 text-[var(--color-accent)]" />
											)}
										</button>
									))
								)}
							</div>
						</>
					)}
					<div className="mt-auto flex justify-end gap-2 pt-4">
						<button
							type="button"
							className="gui-btn"
							onClick={() => {
								if (step === 0) onClose();
								else if (step === 3) {
									// Back from the picker keeps the mount alive; a
									// later connect is idempotent (already-mounted).
									setStep(1);
								} else setStep(s => s - 1);
							}}
							disabled={connecting}
						>
							{step === 0 ? t("Cancel") : t("back")}
						</button>
						{step === 1 && newHostMode ? (
							<button
								type="button"
								className="gui-btn gui-btn-primary"
								disabled={!canNext || savingHost}
								onClick={() => void saveHost()}
							>
								{savingHost ? t("saving") : t("add host")}
							</button>
						) : step === 2 && connecting ? (
							<button type="button" className="gui-btn gui-btn-primary" disabled>
								{t("connecting…")}
							</button>
						) : (
							<button
								type="button"
								className="gui-btn gui-btn-primary"
								disabled={!canNext || connecting}
								onClick={() => {
									if (step === 0) {
										setStep(1);
									} else if (step === 1) {
										setStep(2);
										void doConnect();
									} else if (step === 2) {
										setStep(1);
									} else {
										openWorkspace();
									}
								}}
							>
								{step === 0
									? t("next")
									: step === 1
										? t("connect")
										: step === 2
											? t("back")
											: t("open workspace")}
							</button>
						)}
					</div>
				</div>
			</div>
		</DialogFrame>
	);
}
