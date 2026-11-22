/**
 * ConnectionManager — the surface a shell with no live daemon shows.
 *
 * One component, three entrances: the deliberate-disconnect page, the
 * connection-failure page (which adds 导出诊断 on top), and the avatar menu's
 * connection section. There is no second implementation, so the list a user
 * sees after 断开 is the same list they see when a connect attempt failed.
 *
 * Model:
 *  - every known endpoint is a ROW with its own status, never just "the
 *    current one";
 *  - a failed row keeps its error inline and stays in the list — a failure
 *    never replaces the list;
 *  - the manual `ws://` form is one row kind beside local/wsl/ssh/docker, not
 *    an advanced disclosure for people who know the address;
 *  - per-target status lives outside the row (see `target-store.ts`).
 *
 * What this component does NOT do: spawn a process itself. A forwarded row can
 * ask the main process to start its tunnel/daemon, and the answer — including
 * ssh's own stderr — is rendered in the row; the renderer never owns a handle.
 */

import { t } from "@musepi/client-core";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
	type CatalogHost,
	hasManagedLifecycle,
	type ManagedTargetStatus,
	managedFailureText,
	managedRowState,
	managedStartBlocker,
	shellBridge,
} from "../lib/connection/remote-lifecycle";
import { type ConnectionState, showsFailureCopy } from "../lib/connection/state";
import type { TargetStatusMap } from "../lib/connection/target-store";
import {
	type ConnectionTarget,
	type ConnectionTargetKind,
	createTarget,
	DEFAULT_DAEMON_PORT,
	isForwardedKind,
	stripToken,
	targetCommand,
	targetPublishHint,
} from "../lib/connection/targets";
import { defaultWslRunner, detectWsl, isWindowsShell, type WslDetection, type WslRunner } from "../lib/connection/wsl";
import { normalizeRemoteHostUrl } from "../lib/remote-hosts";
import type { IconName } from "../vendor/oc-icons";
import { Icon } from "../vendor/oc-icons";

/** Kinds the add form can create. `local` is the built-in row. */
const ADDABLE_KINDS: readonly ConnectionTargetKind[] = ["manual", "wsl", "ssh", "docker"];

interface Draft {
	kind: ConnectionTargetKind;
	label: string;
	url: string;
	token: string;
	distro: string;
	sshHost: string;
	remotePort: string;
	/** `ssh` — ssh(1)'s own port, when the catalog entry names a non-default one. */
	sshPort: string;
	/** `ssh` — `ProxyJump` chain carried from the catalog entry. */
	proxyJump: string;
	/** `ssh` — identity file carried from the catalog entry. */
	keyPath: string;
	/** Name of the catalog entry the fields were filled from ("" = typed by hand). */
	catalogName: string;
	container: string;
}

const emptyDraft = (kind: ConnectionTargetKind = "manual"): Draft => ({
	kind,
	label: "",
	url: "",
	token: "",
	distro: "",
	sshHost: "",
	remotePort: String(DEFAULT_DAEMON_PORT),
	sshPort: "",
	proxyJump: "",
	keyPath: "",
	catalogName: "",
	container: "",
});

/** Product wordmark: a proper noun, not translated copy. */
const MUSEPI_BRAND = "MusePi";

/** Keys this component asks the translator for; the locale files own the text. */
type CopyKey =
	| "settings.connectionKindLocal"
	| "settings.connectionKindWsl"
	| "settings.connectionKindSsh"
	| "settings.connectionKindDocker"
	| "settings.connectionKindManual"
	| "settings.connectionStatusConnected"
	| "settings.connectionStatusConnecting"
	| "settings.connectionStatusFailed"
	| "settings.connectionStatusLastUsed"
	| "settings.connectionStatusUnknown";

/** Seed the form from an existing row so editing reuses one code path. */
function draftFromTarget(target: ConnectionTarget): Draft {
	return {
		kind: target.kind === "local" ? "manual" : target.kind,
		label: target.label,
		url: target.url,
		token: target.token ?? "",
		distro: target.distro ?? "",
		sshHost: target.sshHost ?? "",
		remotePort: String(target.remotePort ?? DEFAULT_DAEMON_PORT),
		sshPort: target.sshPort ? String(target.sshPort) : "",
		proxyJump: target.proxyJump ?? "",
		keyPath: target.keyPath ?? "",
		catalogName: "",
		container: target.container ?? "",
	};
}

const KIND_LABEL: Record<ConnectionTargetKind, CopyKey> = {
	local: "settings.connectionKindLocal",
	wsl: "settings.connectionKindWsl",
	ssh: "settings.connectionKindSsh",
	docker: "settings.connectionKindDocker",
	manual: "settings.connectionKindManual",
} as const;

const KIND_GLYPH: Record<ConnectionTargetKind, IconName> = {
	local: "computer",
	wsl: "terminal-box",
	ssh: "server",
	docker: "stack",
	manual: "link-unlink-m",
};

/**
 * Human status for one row. Derived, never stored.
 *
 * Only a live socket may read `connected`. A past attempt that succeeded is
 * `last-used`: after 断开 the header says 已断开, so a row claiming 已连接
 * would contradict it — and two rows that each succeeded once would both
 * claim the one connection that cannot exist twice.
 */
type RowStatus = "connected" | "connecting" | "failed" | "last-used" | "unknown";

function rowStatus(
	target: ConnectionTarget,
	activeTargetId: string | null,
	statuses: TargetStatusMap,
	busyId: string | null,
	connected: boolean,
): RowStatus {
	if (busyId === target.id) return "connecting";
	if (connected && target.id === activeTargetId) return "connected";
	const status = statuses[target.id];
	if (!status || status.lastAttemptAt === null) return "unknown";
	return status.lastError ? "failed" : "last-used";
}

/**
 * What a Docker probe found.
 *
 * `unavailable` carries a reason because the two causes need different fixes —
 * installing the CLI, versus granting the daemon socket or starting it — and a
 * single "docker did not work" would send the user to the wrong one.
 */
type DockerProbe =
	| "idle"
	| "checking"
	| { state: "unavailable"; reason?: string; error?: string }
	| { state: "ready"; containers: Array<{ name: string; hostPort: number; containerPort: number }> };

const STATUS_LABEL: Record<RowStatus, CopyKey> = {
	connected: "settings.connectionStatusConnected",
	connecting: "settings.connectionStatusConnecting",
	failed: "settings.connectionStatusFailed",
	"last-used": "settings.connectionStatusLastUsed",
	unknown: "settings.connectionStatusUnknown",
} as const;

export function ConnectionManager({
	state,
	targets,
	statuses,
	activeTargetId,
	busyId,
	lastError,
	detect = defaultWslRunner,
	platform,
	catalog = [],
	managed,
	onStartManaged,
	onStopManaged,
	onConnect,
	onAdd,
	onRemove,
	onCopy,
	children,
}: {
	state: ConnectionState;
	/** Stored rows, local first (see `target-store.loadTargets`). */
	targets: readonly ConnectionTarget[];
	/** Status beside the list — a failed attempt never rewrites a row. */
	statuses: TargetStatusMap;
	/** Row selected as the current target (token-insensitive), if any. */
	activeTargetId: string | null;
	/** Id of the target with an attempt in flight, if any. */
	busyId: string | null;
	/** Last attempt error for the row being attempted. */
	lastError: string | null;
	/** WSL runner seam — tests inject a stub; the shell passes the default. */
	detect?: WslRunner;
	platform?: string;
	/**
	 * Hosts from the merged catalog (MusePi's ssh.json + `~/.ssh/config`).
	 *
	 * Passed in rather than read here: the shell already loads it once for the
	 * workspace wizard, and two loads would be two answers. An empty list keeps
	 * the manual form exactly as it was.
	 */
	catalog?: readonly CatalogHost[];
	/**
	 * Managed-process status per target id (tunnels, WSL daemons, containers).
	 * Beside the list like `statuses`, and derived from the supervisor rather
	 * than from a connect attempt: a tunnel can die while the shell is idle.
	 */
	managed?: Record<string, ManagedTargetStatus>;
	/** Start the process a forwarded row needs; absent = the shell has no bridge. */
	onStartManaged?(target: ConnectionTarget): void;
	onStopManaged?(target: ConnectionTarget): void;
	onConnect(target: ConnectionTarget): void;
	onAdd(target: ConnectionTarget): void;
	onRemove(id: string): void;
	onCopy(text: string): void;
	/** Extra actions the entrance owns (导出诊断 on the failure surface). */
	children?: ReactNode;
}): ReactNode {
	const [adding, setAdding] = useState(false);
	/** Row being edited; null means the form is creating a new target. */
	const [editingId, setEditingId] = useState<string | null>(null);
	const [draft, setDraft] = useState<Draft>(emptyDraft);
	const [formError, setFormError] = useState<string | null>(null);
	const [expanded, setExpanded] = useState<string | null>(null);
	const [wsl, setWsl] = useState<WslDetection | "checking" | "idle">("idle");
	/**
	 * Docker detection and the containers publishing the daemon port.
	 *
	 * Probed when the Docker kind is first shown, the way WSL detection is: a
	 * user who never opens the picker never pays for a `docker info` that may
	 * block on a dead socket. The two answers stay separate, because "the CLI is
	 * missing" and "the daemon will not answer" lead to different fixes.
	 */
	const [docker, setDocker] = useState<DockerProbe>("idle");
	const showFailure = showsFailureCopy(state);

	const runDockerDetection = useCallback(async (): Promise<void> => {
		const bridge = shellBridge();
		if (!bridge?.detectDocker) {
			setDocker({ state: "unavailable", reason: "no-bridge" });
			return;
		}
		setDocker("checking");
		const detected = await bridge.detectDocker();
		if (!detected.available) {
			setDocker({ state: "unavailable", reason: detected.reason, error: detected.error });
			return;
		}
		const listed = await bridge.dockerContainers?.(DEFAULT_DAEMON_PORT);
		setDocker({ state: "ready", containers: listed?.ok ? (listed.containers ?? []) : [] });
	}, []);

	useEffect(() => {
		if (!adding || draft.kind !== "docker" || docker !== "idle") return;
		void runDockerDetection();
	}, [adding, draft.kind, docker, runDockerDetection]);

	const runDetection = useCallback(async (): Promise<void> => {
		setWsl("checking");
		setWsl(await detectWsl(detect));
	}, [detect]);

	// Detection runs when the WSL kind is first shown, not on mount: a user
	// who never opens the picker never pays for a probe that may not exist.
	useEffect(() => {
		if (!adding || draft.kind !== "wsl" || wsl !== "idle") return;
		void runDetection();
	}, [adding, draft.kind, wsl, runDetection]);

	const submit = (): void => {
		setFormError(null);
		const label = draft.label.trim();
		if (!label) {
			setFormError(t("settings.connectionLabelRequired"));
			return;
		}
		let url = draft.url.trim();
		if (draft.kind === "wsl") {
			if (!draft.distro) {
				setFormError(t("settings.connectionDistroRequired"));
				return;
			}
			// WSL2 forwards localhost, so the Windows-side endpoint is loopback.
			url = url || `ws://127.0.0.1:${DEFAULT_DAEMON_PORT}`;
		}
		if (draft.kind === "ssh") {
			if (!draft.sshHost.trim()) {
				setFormError(t("settings.connectionHostRequired"));
				return;
			}
			url = url || `ws://127.0.0.1:${DEFAULT_DAEMON_PORT}`;
		}
		if (draft.kind === "docker") {
			if (!draft.container.trim()) {
				setFormError(t("settings.connectionContainerRequired"));
				return;
			}
			url = url || `ws://127.0.0.1:${DEFAULT_DAEMON_PORT}`;
		}
		if (!url) {
			setFormError(t("settings.connectionUrlRequired"));
			return;
		}
		// This endpoint becomes the next launch's boot target, so it must parse.
		// The sibling instance dialog accepts a bare `host:port`, and users type
		// that here too; `normalizeRemoteHostUrl` adds the scheme and refuses
		// anything that is not ws/wss/http/https — a stored `ftp://nope` would
		// otherwise strand boot on a URL it cannot parse.
		try {
			url = normalizeRemoteHostUrl(url);
		} catch {
			setFormError(t("settings.instanceUrlInvalid"));
			return;
		}
		onAdd(
			createTarget({
				// Editing keeps the row's id (and therefore its status/error and
				// its last-used marker); creating mints a new one.
				id: editingId ?? `target-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
				label,
				url,
				token: draft.token.trim() || undefined,
				kind: draft.kind,
				distro: draft.kind === "wsl" ? draft.distro : undefined,
				sshHost: draft.kind === "ssh" ? draft.sshHost.trim() : undefined,
				remotePort: draft.kind === "ssh" ? Number.parseInt(draft.remotePort, 10) || undefined : undefined,
				sshPort: draft.kind === "ssh" ? Number.parseInt(draft.sshPort, 10) || undefined : undefined,
				proxyJump: draft.kind === "ssh" ? draft.proxyJump.trim() || undefined : undefined,
				keyPath: draft.kind === "ssh" ? draft.keyPath.trim() || undefined : undefined,
				container: draft.kind === "docker" ? draft.container.trim() : undefined,
			}),
		);
		setDraft(emptyDraft());
		setAdding(false);
		setEditingId(null);
	};

	const renderRow = (target: ConnectionTarget): ReactNode => {
		const status = rowStatus(target, activeTargetId, statuses, busyId, state === "connected");
		// Scrubbed at the display too: a status slot written by an older build
		// may still hold a message that quotes the token-bearing URL.
		const error =
			stripToken((target.id === busyId ? lastError : (statuses[target.id]?.lastError ?? null)) ?? "") || null;
		const command = targetCommand(target);
		const publish = targetPublishHint(target);
		const isOpen = expanded === target.id;
		// Managed process state is independent of the connect attempt: a tunnel
		// that died while the shell sat idle still has to say so.
		const managedStatus = managed?.[target.id];
		const managedState = managedRowState(managedStatus);
		const managedFailure = managedFailureText(managedStatus);
		const blocker = managedStartBlocker(target, platform);
		const canManage = onStartManaged !== undefined && blocker === null;
		const running = managedState === "running" || managedState === "starting";
		const canExpand =
			command !== null || (error !== null && status === "failed") || managedFailure !== null || running;
		return (
			<li
				key={target.id}
				className="gui-conn-row"
				data-status={status}
				data-kind={target.kind}
				data-managed={managedState}
			>
				<div className="gui-conn-row-main">
					<span className="gui-conn-glyph" aria-hidden>
						<Icon name={KIND_GLYPH[target.kind]} className="h-3.5 w-3.5" />
					</span>
					<span className="gui-conn-copy">
						<span className="gui-conn-name">
							<span className="gui-conn-label">{target.label}</span>
							<span className="gui-conn-kind">{t(KIND_LABEL[target.kind])}</span>
							{target.id === activeTargetId && (
								<span className="gui-conn-chip">{t("settings.currentInstanceBadge")}</span>
							)}
						</span>
						<span className="gui-conn-url" title={target.url}>
							{target.url}
						</span>
					</span>
					<span className="gui-conn-status" data-status={status}>
						<span className="gui-conn-dot" aria-hidden />
						{/* The word is the accessible status; the dot is colour only,
						 * so a narrow window hides the word but keeps it for readers. */}
						<span className="gui-conn-status-word">{t(STATUS_LABEL[status])}</span>
					</span>
					{managedState !== "idle" && (
						<span className="gui-conn-managed" data-managed={managedState}>
							{managedState === "starting"
								? t("settings.connectionManagedStarting")
								: managedState === "running"
									? t("settings.connectionManagedRunning")
									: t("settings.connectionManagedFailed")}
						</span>
					)}
					<span className="gui-conn-actions">
						{canManage && (
							<button
								type="button"
								className="gui-tool-btn gui-conn-manage"
								disabled={managedState === "starting"}
								aria-label={
									running ? t("settings.connectionStopManaged") : t("settings.connectionStartManaged")
								}
								title={running ? t("settings.connectionStopManaged") : t("settings.connectionStartManaged")}
								onClick={() => (running ? onStopManaged?.(target) : onStartManaged?.(target))}
							>
								<Icon name={running ? "stop" : "play"} className="h-3.5 w-3.5" />
							</button>
						)}
						{canExpand && (
							<button
								type="button"
								className="gui-tool-btn"
								aria-expanded={isOpen}
								aria-label={t("settings.connectionDetails")}
								title={t("settings.connectionDetails")}
								onClick={() => setExpanded(isOpen ? null : target.id)}
							>
								<Icon name={isOpen ? "arrow-up-s" : "arrow-down-s"} className="h-3.5 w-3.5" />
							</button>
						)}
						{target.kind !== "local" && (
							<button
								type="button"
								className="gui-tool-btn"
								aria-label={t("settings.edit")}
								title={t("settings.edit")}
								onClick={() => {
									setDraft(draftFromTarget(target));
									setEditingId(target.id);
									setFormError(null);
									setAdding(true);
								}}
							>
								<Icon name="edit" className="h-3.5 w-3.5" />
							</button>
						)}
						{target.kind !== "local" && (
							<button
								type="button"
								className="gui-tool-btn"
								aria-label={t("general.remove")}
								title={t("general.remove")}
								onClick={() => onRemove(target.id)}
							>
								<Icon name="delete-bin" className="h-3.5 w-3.5" />
							</button>
						)}
						<button
							type="button"
							className="gui-btn gui-btn-primary gui-conn-connect"
							disabled={busyId !== null}
							onClick={() => onConnect(target)}
						>
							{busyId === target.id ? t("settings.connectionStatusConnecting") : t("settings.connect")}
						</button>
					</span>
				</div>
				{isOpen && (
					<div className="gui-conn-detail">
						{error && (
							<p className="gui-conn-error" role="alert">
								{error}
							</p>
						)}
						{/* ssh's own words, not a generic failure: "Permission denied
						 * (publickey)" and "bind: Address already in use" are what a
						 * user can act on, so they are shown verbatim. */}
						{managedFailure && (
							<div className="gui-conn-managed-error" role="alert">
								<span className="gui-conn-command-label">{t("settings.connectionManagedStderr")}</span>
								<pre>{managedFailure}</pre>
							</div>
						)}
						{command && (
							<div className="gui-conn-command">
								<span className="gui-conn-command-label">
									{isForwardedKind(target.kind)
										? t("settings.connectionCommandHint")
										: t("settings.connectionCommand")}
								</span>
								<code>{command}</code>
								<button
									type="button"
									className="gui-tool-btn"
									aria-label={t("settings.connectionCopyCommand")}
									title={t("settings.connectionCopyCommand")}
									onClick={() => onCopy(command)}
								>
									<Icon name="file-copy" className="h-3.5 w-3.5" />
								</button>
							</div>
						)}
						{publish && (
							<div className="gui-conn-command">
								<span className="gui-conn-command-label">{t("settings.connectionPublishHint")}</span>
								<code>{publish}</code>
								<button
									type="button"
									className="gui-tool-btn"
									aria-label={t("settings.connectionCopyCommand")}
									title={t("settings.connectionCopyCommand")}
									onClick={() => onCopy(publish)}
								>
									<Icon name="file-copy" className="h-3.5 w-3.5" />
								</button>
							</div>
						)}
						{isForwardedKind(target.kind) && !canManage && blocker === null && (
							<p className="gui-conn-note">
								{t(
									hasManagedLifecycle()
										? "settings.connectionManagedUnsupported"
										: "settings.connectionManagedNoBridge",
								)}
							</p>
						)}
						{isForwardedKind(target.kind) && (
							<p className="gui-conn-note">{t("settings.connectionForwardingNote")}</p>
						)}
						{target.kind === "wsl" && (
							<p className="gui-conn-note">{t("settings.connectionWslForwardingNote")}</p>
						)}
					</div>
				)}
			</li>
		);
	};

	return (
		<div className="gui-conn" data-state={state}>
			<header className="gui-conn-head">
				<div className="gui-brand">
					<span className="gui-brand-mark">π</span> {MUSEPI_BRAND}
				</div>
				<p className="gui-conn-sub">
					{showFailure
						? t("settings.cannotReachLocalDaemon")
						: state === "unconfigured"
							? t("settings.connectionUnconfigured")
							: state === "starting"
								? t("settings.connecting2")
								: state === "connected"
									? t("settings.connectionConnectedHint")
									: t("settings.connectionDisconnected")}
				</p>
			</header>

			<section className="gui-conn-section" aria-labelledby="gui-conn-targets">
				<h2 className="gui-conn-title" id="gui-conn-targets">
					{t("settings.connectionTargets")}
				</h2>
				<ul className="gui-conn-list">{targets.map(renderRow)}</ul>
			</section>

			{adding ? (
				<section
					className="gui-conn-section gui-conn-form"
					aria-label={editingId ? t("settings.connectionEditTarget") : t("settings.addInstance")}
				>
					<div className="gui-conn-kinds" role="tablist" aria-label={t("settings.connectionKind")}>
						{ADDABLE_KINDS.map(kind => (
							<button
								key={kind}
								type="button"
								role="tab"
								aria-selected={draft.kind === kind}
								className="gui-conn-kind-btn"
								onClick={() => setDraft(current => ({ ...current, kind }))}
							>
								<Icon name={KIND_GLYPH[kind]} className="h-3.5 w-3.5" />
								{t(KIND_LABEL[kind])}
							</button>
						))}
					</div>

					<label className="gui-field">
						<span className="gui-field-label">{t("settings.instanceLabel")}</span>
						<input
							className="gui-input"
							value={draft.label}
							onChange={e => setDraft(current => ({ ...current, label: e.target.value }))}
						/>
					</label>

					{draft.kind === "wsl" && (
						<div className="gui-field">
							<span className="gui-field-label">{t("settings.connectionDistro")}</span>
							{wsl === "checking" && <p className="gui-conn-note">{t("settings.connectionDetecting")}</p>}
							{wsl !== "checking" && wsl !== "idle" && wsl.status === "unsupported" && (
								<p className="gui-conn-note" role="status">
									{isWindowsShell(platform)
										? t("settings.connectionWslUnavailable")
										: t("settings.connectionWslNotWindows")}
								</p>
							)}
							{wsl !== "checking" && wsl !== "idle" && wsl.status === "unavailable" && (
								<p className="gui-conn-note" role="status">
									{t("settings.connectionWslFailed", { error: wsl.error })}
								</p>
							)}
							{wsl !== "checking" && wsl !== "idle" && wsl.status === "ok" && wsl.distros.length === 0 && (
								<p className="gui-conn-note" role="status">
									{t("settings.connectionWslNone")}
								</p>
							)}
							{wsl !== "checking" && wsl !== "idle" && wsl.status === "ok" && wsl.distros.length > 0 && (
								<select
									className="gui-input"
									value={draft.distro}
									onChange={e => setDraft(current => ({ ...current, distro: e.target.value }))}
								>
									<option value="">{t("settings.connectionDistroPick")}</option>
									{wsl.distros.map(distro => (
										<option key={distro.name} value={distro.name}>
											{distro.name}
											{distro.isDefault ? ` ${t("settings.connectionDistroDefault")}` : ""}
										</option>
									))}
								</select>
							)}
							{wsl !== "checking" && (
								<button type="button" className="gui-btn gui-conn-retry" onClick={() => void runDetection()}>
									{t("settings.retry")}
								</button>
							)}
						</div>
					)}

					{draft.kind === "ssh" && (
						<>
							{catalog.length > 0 && (
								<label className="gui-field">
									<span className="gui-field-label">{t("settings.connectionCatalogHost")}</span>
									<select
										className="gui-input"
										value={draft.catalogName}
										onChange={e => {
											const entry = catalog.find(host => host.name === e.target.value);
											setDraft(current =>
												entry
													? {
															...current,
															catalogName: entry.name,
															label: current.label || entry.name,
															sshHost: entry.username ? `${entry.username}@${entry.host}` : entry.host,
															sshPort: entry.port ? String(entry.port) : "",
															proxyJump: entry.proxyJump ?? "",
															keyPath: entry.keyPath ?? "",
														}
													: { ...current, catalogName: "" },
											);
										}}
									>
										<option value="">{t("settings.connectionCatalogPick")}</option>
										{catalog.map(host => (
											<option key={host.name} value={host.name}>
												{host.name}
												{host.host !== host.name ? ` — ${host.host}` : ""}
												{host.source === "ssh-config"
													? ` (${t("settings.connectionCatalogFromSshConfig")})`
													: ""}
											</option>
										))}
									</select>
								</label>
							)}
							<label className="gui-field">
								<span className="gui-field-label">{t("settings.connectionSshHost")}</span>
								<input
									className="gui-input font-mono"
									value={draft.sshHost}
									placeholder={t("settings.connectionSshHostPlaceholder")}
									spellCheck={false}
									onChange={e => setDraft(current => ({ ...current, sshHost: e.target.value }))}
								/>
							</label>
							<label className="gui-field">
								<span className="gui-field-label">{t("settings.connectionRemotePort")}</span>
								<input
									className="gui-input font-mono"
									value={draft.remotePort}
									inputMode="numeric"
									onChange={e => setDraft(current => ({ ...current, remotePort: e.target.value }))}
								/>
							</label>
						</>
					)}

					{draft.kind === "docker" && (
						<div className="gui-field">
							<span className="gui-field-label">{t("settings.connectionContainer")}</span>
							{docker === "checking" && <p className="gui-conn-note">{t("settings.connectionDetecting")}</p>}
							{docker !== "checking" && docker !== "idle" && docker.state === "unavailable" && (
								<p className="gui-conn-note" role="status">
									{docker.reason === "docker-not-found"
										? t("settings.connectionDockerNotFound")
										: docker.reason === "daemon-unreachable"
											? t("settings.connectionDockerDaemonDown")
											: t("settings.connectionManagedNoBridge")}
									{docker.reason === "daemon-unreachable" && docker.error ? ` — ${docker.error}` : ""}
								</p>
							)}
							{docker !== "checking" &&
								docker !== "idle" &&
								docker.state === "ready" &&
								docker.containers.length > 0 && (
									<>
										<p className="gui-conn-note" role="status">
											{t("settings.connectionDockerContainers")}
										</p>
										<select
											className="gui-input font-mono"
											value={draft.container}
											onChange={e => setDraft(current => ({ ...current, container: e.target.value }))}
										>
											<option value="">{t("settings.connectionContainerPick")}</option>
											{docker.containers.map(container => (
												<option key={container.name} value={container.name}>
													{container.name} — 127.0.0.1:{container.hostPort}→{container.containerPort}
												</option>
											))}
										</select>
									</>
								)}
							{docker !== "checking" &&
								docker !== "idle" &&
								docker.state === "ready" &&
								docker.containers.length === 0 && (
									<p className="gui-conn-note" role="status">
										{t("settings.connectionDockerNone")}
									</p>
								)}
							<input
								className="gui-input font-mono"
								value={draft.container}
								spellCheck={false}
								onChange={e => setDraft(current => ({ ...current, container: e.target.value }))}
							/>
							{docker !== "checking" && (
								<button
									type="button"
									className="gui-btn gui-conn-retry"
									onClick={() => void runDockerDetection()}
								>
									{t("settings.retry")}
								</button>
							)}
						</div>
					)}

					<label className="gui-field">
						<span className="gui-field-label">{t("settings.instanceUrlLabel")}</span>
						<input
							className="gui-input font-mono"
							value={draft.url}
							placeholder={
								draft.kind === "manual"
									? t("settings.hostUrlPlaceholder")
									: t("settings.connectionLoopbackPlaceholder", { port: String(DEFAULT_DAEMON_PORT) })
							}
							spellCheck={false}
							onChange={e => setDraft(current => ({ ...current, url: e.target.value }))}
						/>
					</label>
					<label className="gui-field">
						<span className="gui-field-label">{t("settings.remoteToken")}</span>
						<input
							className="gui-input font-mono"
							type="password"
							value={draft.token}
							onChange={e => setDraft(current => ({ ...current, token: e.target.value }))}
						/>
					</label>

					{formError && (
						<p className="gui-conn-error" role="alert">
							{formError}
						</p>
					)}

					<div className="gui-conn-form-actions">
						<button
							type="button"
							className="gui-btn"
							onClick={() => {
								setAdding(false);
								setEditingId(null);
								setDraft(emptyDraft());
								setFormError(null);
							}}
						>
							{t("settings.dismiss")}
						</button>
						<button type="button" className="gui-btn gui-btn-primary" onClick={submit}>
							{t("settings.connectionAddTarget")}
						</button>
					</div>
				</section>
			) : (
				<button
					type="button"
					className="gui-btn gui-conn-add"
					onClick={() => {
						setEditingId(null);
						setDraft(emptyDraft());
						setAdding(true);
					}}
				>
					<Icon name="add" className="h-3.5 w-3.5" />
					{t("settings.addInstance")}
				</button>
			)}

			{/* Entrance-owned actions: the failure surface adds 导出诊断 / 重启;
			 * the calm surface must not look like an error page. */}
			{children && <footer className="gui-conn-foot">{children}</footer>}
		</div>
	);
}
