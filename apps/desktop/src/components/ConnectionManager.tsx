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
import { connectionPresentation } from "../lib/connection/presentation";
import {
	type CatalogHost,
	hasManagedLifecycle,
	type ManagedTargetStatus,
	managedFailureText,
	managedRowState,
	managedStartBlocker,
	shellBridge,
	targetFromCatalogHost,
} from "../lib/connection/remote-lifecycle";
import { catalogEntryFor } from "../lib/connection/ssh-config";
import { type ConnectionState, showsFailureCopy } from "../lib/connection/state";
import type { TargetStatusMap } from "../lib/connection/target-store";
import {
	type ConnectionTarget,
	type ConnectionTargetKind,
	createTarget,
	DEFAULT_DAEMON_PORT,
	daemonPortOf,
	isForwardedKind,
	stripToken,
	type TargetLocation,
	targetAxes,
	targetCommand,
	targetPublishHint,
} from "../lib/connection/targets";
import { defaultWslRunner, detectWsl, isWindowsShell, type WslDetection, type WslRunner } from "../lib/connection/wsl";
import { normalizeRemoteHostUrl } from "../lib/remote-hosts";
import type { IconName } from "../vendor/oc-icons";
import { Icon } from "../vendor/oc-icons";

interface Draft {
	kind: ConnectionTargetKind;
	/**
	 * The form's chosen location, kept apart from `sshHost`.
	 *
	 * A stored row answers "remote?" from whether it carries a host, which is
	 * the only durable fact it has. A row *being typed* cannot: the user picks
	 * 远端主机 before naming one, and if the chip were derived from the empty
	 * field it would flip back to 本机 the moment it was clicked. So the form
	 * holds the intent, and `kind` stays the stored discriminant.
	 */
	location: Exclude<TargetLocation, "unknown">;
	label: string;
	url: string;
	token: string;
	distro: string;
	sshHost: string;
	remotePort: string;
	/** `ssh`/`docker` — ssh(1)'s own port, when the catalog entry names a non-default one. */
	sshPort: string;
	/** `ssh`/`docker` — `ProxyJump` chain carried from the catalog entry. */
	proxyJump: string;
	/** `ssh`/`docker` — identity file carried from the catalog entry. */
	keyPath: string;
	/** Name of the catalog entry the fields were filled from ("" = typed by hand). */
	catalogName: string;
	container: string;
}
const emptyDraft = (
	kind: ConnectionTargetKind = "manual",
	location: Exclude<TargetLocation, "unknown"> = "local",
): Draft => ({
	kind,
	location,
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
	const axes = targetAxes(target.kind, target.sshHost);
	return {
		kind: target.kind === "local" ? "manual" : target.kind,
		// An existing row's location is a fact it carries, not an intent: a
		// `manual` endpoint names no machine, so it opens as 本机 rather than
		// claiming a remote it cannot describe.
		location: axes.location === "remote" ? "remote" : "local",
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
	| { state: "ready"; containers: Array<{ name: string; hostPort: number; containerPort: number }> }
	/**
	 * The daemon answered `docker info` but `docker ps` failed — a socket
	 * permission problem, typically. Kept apart from `ready` with an empty list
	 * because "no container publishes this port" and "the list could not be
	 * read" send the user to different fixes.
	 */
	| { state: "list-failed"; error?: string };

export function ConnectionManager({
	state,
	targets = [],
	statuses = {},
	activeTargetId = null,
	busyId = null,
	lastError = null,
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
	onShapeChange,
	onFormClosed,
	children,
	/** Rendered inside another surface (the locations dialog's instance axis):
	 *  the host already states which axis this is, so the brand header would
	 *  repeat it and the dialog's own head sits directly above. */
	embedded = false,
	/** Render only the add form. The locations dialog already owns the list
	 *  and its rows; this is how it offers the same four ways to add an
	 *  instance (typed endpoint, WSL, SSH forward, container) without a
	 *  second implementation that can drift. */
	formOnly = false,
}: {
	state: ConnectionState;
	/** Stored rows, local first (see `target-store.loadTargets`). */
	targets?: readonly ConnectionTarget[];
	/** Status beside the list — a failed attempt never rewrites a row. */
	statuses?: TargetStatusMap;
	/** Row selected as the current target (token-insensitive), if any. */
	activeTargetId?: string | null;
	/** Id of the target with an attempt in flight, if any. */
	busyId?: string | null;
	/** Last attempt error for the row being attempted. */
	lastError?: string | null;
	/** WSL runner seam — tests inject a stub; the shell passes the default. */
	detect?: WslRunner;
	platform?: string;
	/**
	 * Hosts from the merged catalog (MusePi's ssh.json + `~/.ssh/config`).
	 *
	 * Passed in rather than read here so the instance form and the workspace
	 * wizard answer from one read (see `useHostCatalog`); an empty list keeps the
	 * manual form exactly as it was.
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
	/** Reports the form's shape (`adding` + kind + editing row) whenever it
	 *  changes, so a hosting dialog can spring its own height instead of
	 *  snapping when the form opens or switches kind. */
	onShapeChange?(shape: string): void;
	/**
	 * The form was dismissed without adding anything.
	 *
	 * A hosting dialog used the form in place of its own 添加实例 button, so
	 * cancelling left it showing neither: the form gone, its trigger gone. The
	 * dialog owns that decision, so it is told rather than guessing from
	 * `onShapeChange`.
	 */
	onFormClosed?(): void;
	/** Extra actions the entrance owns (导出诊断 on the failure surface). */
	children?: ReactNode;
	embedded?: boolean;
	formOnly?: boolean;
}): ReactNode {
	const [adding, setAdding] = useState(formOnly);
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
	/** The two axes the draft currently expresses.
	 *
	 *  Location comes from the draft's own intent (see `Draft.location`), so a
	 *  chosen 远端主机 does not disappear while its host field is still empty.
	 *  Environment comes from `kind`, which stays the stored discriminant. */
	const environment = targetAxes(draft.kind).environment;
	const axes = { location: draft.location, environment };
	/** True for a container reached over ssh rather than on this machine. */
	const remoteContainer = draft.kind === "docker" && draft.location === "remote";

	const runDockerDetection = useCallback(async (): Promise<void> => {
		const bridge = shellBridge();
		if (!bridge?.detectDocker) {
			setDocker({ state: "unavailable", reason: "no-bridge" });
			return;
		}
		// A container on another host is probed on that host: asking this machine
		// would answer about a docker daemon the container has nothing to do with.
		const transport = remoteContainer
			? {
					destination: draft.sshHost.trim(),
					sshPort: Number.parseInt(draft.sshPort, 10) || undefined,
					keyPath: draft.keyPath.trim() || undefined,
					proxyJump: draft.proxyJump.trim() || undefined,
				}
			: undefined;
		setDocker("checking");
		const detected = await bridge.detectDocker({ transport });
		if (!detected.available) {
			setDocker({ state: "unavailable", reason: detected.reason, error: detected.error });
			return;
		}
		const listed = await bridge.dockerContainers?.({ daemonPort: DEFAULT_DAEMON_PORT, transport });
		// A failed list keeps its own reason: rendering it as "no containers"
		// would drop a socket-permission error the user needs to see.
		if (!listed) {
			setDocker({ state: "list-failed" });
			return;
		}
		if (!listed.ok) {
			setDocker({ state: "list-failed", error: listed.error ?? listed.reason });
			return;
		}
		setDocker({ state: "ready", containers: listed.containers ?? [] });
	}, [remoteContainer, draft.sshHost, draft.sshPort, draft.keyPath, draft.proxyJump]);

	useEffect(() => {
		if (!adding || draft.kind !== "docker" || docker !== "idle") return;
		// A remote container cannot be probed until the host is named, so the
		// probe waits for one instead of asking this machine by mistake.
		if (remoteContainer && !draft.sshHost.trim()) return;
		void runDockerDetection();
	}, [adding, draft.kind, docker, remoteContainer, draft.sshHost, runDockerDetection]);

	/**
	 * Which machine the docker probe is about.
	 *
	 * A probe result describes one host's daemon. Moving the form to another
	 * host — or from local to remote — has to discard it, or the container list
	 * would offer names from a machine the user is no longer pointing at.
	 */
	const dockerScope = draft.kind === "docker" ? (remoteContainer ? `remote:${draft.sshHost.trim()}` : "local") : "";
	useEffect(() => {
		setDocker("idle");
	}, [dockerScope]);

	/**
	 * The three ways to reach a daemon, as cards.
	 *
	 * The axis chips ask *where* and *in what*; these cards are the concrete
	 * transports that pair resolves to. They lead with the transport because
	 * that is what a user is actually configuring — an ssh host, a container
	 * name, a distribution — and the pair becomes a consequence of the card
	 * rather than a second question asked before one.
	 *
	 * A card also says whether it is ready: the container card carries the
	 * probe's answer and the WSL card the distribution list's, so a transport
	 * that cannot work is visibly blocked at the point of choosing it instead
	 * of failing after submit.
	 */
	const transportCards: Array<{
		kind: "ssh" | "docker" | "wsl";
		label: string;
		hint: string;
		icon: "server" | "stack" | "terminal-box";
		state: "ready" | "checking" | "blocked";
	}> = [
		{
			kind: "ssh",
			label: t("settings.connectionKindSsh"),
			hint: t("settings.connectionSshCardHint"),
			icon: "server",
			state: "ready",
		},
		{
			kind: "docker",
			label: t("settings.connectionKindDocker"),
			hint: t("settings.connectionDockerCardHint"),
			icon: "stack",
			// A probe only runs once this transport is chosen, so an unopened
			// card reports nothing rather than claiming to be checking: `idle`
			// means nobody asked, not that an answer is on its way.
			state:
				docker === "idle"
					? "ready"
					: docker === "checking"
						? "checking"
						: docker.state === "ready"
							? "ready"
							: "blocked",
		},
		{
			kind: "wsl",
			label: t("settings.connectionKindWsl"),
			hint: t("settings.connectionWslCardHint"),
			icon: "terminal-box",
			state: wsl === "idle" ? "ready" : wsl === "checking" ? "checking" : wsl.status === "ok" ? "ready" : "blocked",
		},
	];

	/**
	 * What the *remote* host can run, asked on that host.
	 *
	 * The environment chips above are enabled or disabled by this answer, so a
	 * remote machine without docker no longer offers a container the user cannot
	 * reach. Absent a bridge the probe reports `unknown`, and the chips stay
	 * disabled rather than guessing.
	 */
	const [remote, setRemote] = useState<
		| { state: "idle" }
		| { state: "probing" }
		| { state: "ok"; docker: boolean; wsl: boolean }
		| { state: "failed"; error: string }
	>({ state: "idle" });
	useEffect(() => {
		if (!adding || draft.kind !== "ssh" || remote.state === "probing") return;
		const host = draft.sshHost.trim();
		if (!host) return;
		const bridge = shellBridge();
		if (!bridge?.probeRemoteCapabilities) {
			setRemote({ state: "failed", error: t("settings.remoteProbeNoBridge") });
			return;
		}
		setRemote({ state: "probing" });
		void bridge
			.probeRemoteCapabilities({
				destination: host,
				sshPort: Number.parseInt(draft.sshPort, 10) || undefined,
				keyPath: draft.keyPath.trim() || undefined,
				proxyJump: draft.proxyJump.trim() || undefined,
			})
			.then(result => {
				if (!result.ok) {
					setRemote({ state: "failed", error: result.error ?? result.reason });
					return;
				}
				setRemote({
					state: "ok",
					docker: result.docker?.available === true,
					wsl: result.wsl?.available === true,
				});
			});
	}, [adding, draft.kind, draft.sshHost, draft.sshPort, draft.keyPath, draft.proxyJump, remote.state]);

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
			// A remote container is reached through a host, so the host is as
			// required as the container name; without it the row would silently
			// fall back to this machine's docker and exec a same-named container.
			if (remoteContainer && !draft.sshHost.trim()) {
				setFormError(t("settings.connectionHostRequired"));
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
		// Editing keeps the row's id (and therefore its status/error and its
		// last-used marker); creating mints a new one.
		const id = editingId ?? `target-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		/**
		 * A row picked from the catalog is built from that entry, so the host
		 * facts come from one place instead of being reassembled from form
		 * strings. `catalogEntryFor` resolves the draft's own `sshHost` too, which
		 * is why an edited row keeps matching its entry after the catalog changes.
		 *
		 * A remote container asks the same question a shell does, so it reads the
		 * catalog the same way — one host read, two kinds that consume it.
		 */
		const hostKind = draft.kind === "ssh" || draft.kind === "docker";
		const entry =
			hostKind && draft.sshHost.trim()
				? catalogEntryFor({ id, label, url, kind: "ssh", sshHost: draft.sshHost }, catalog)
				: null;
		const fromCatalog = entry ? targetFromCatalogHost(entry, daemonPortOf(url)) : null;
		onAdd(
			createTarget({
				id,
				label,
				url,
				token: draft.token.trim() || undefined,
				kind: draft.kind,
				distro: draft.kind === "wsl" ? draft.distro : undefined,
				sshHost: hostKind ? (fromCatalog?.sshHost ?? draft.sshHost.trim()) || undefined : undefined,
				remotePort: hostKind
					? Number.parseInt(draft.remotePort, 10) || fromCatalog?.remotePort || undefined
					: undefined,
				sshPort: hostKind ? Number.parseInt(draft.sshPort, 10) || fromCatalog?.sshPort || undefined : undefined,
				proxyJump: hostKind ? draft.proxyJump.trim() || fromCatalog?.proxyJump || undefined : undefined,
				keyPath: hostKind ? draft.keyPath.trim() || fromCatalog?.keyPath || undefined : undefined,
				container: draft.kind === "docker" ? draft.container.trim() : undefined,
			}),
		);
		setDraft(emptyDraft());
		setAdding(false);
		setEditingId(null);
	};

	useEffect(() => {
		onShapeChange?.(`${adding ? "add" : "rest"}:${draft.kind}:${editingId ?? ""}`);
	}, [adding, draft.kind, editingId, onShapeChange]);

	const renderRow = (target: ConnectionTarget): ReactNode => {
		// Row facts feed the one presentation mapping; the row renders its answer
		// instead of deciding what "disconnected" means (see `lib/connection/presentation`).
		const rowFacts =
			busyId === target.id
				? { connected: false, connecting: true }
				: state === "connected" && target.id === activeTargetId
					? { connected: true }
					: (() => {
							const stored = statuses[target.id];
							return {
								connected: false,
								lastError: stored?.lastError ?? null,
								// An attempt that succeeded before is history, not a socket.
								lastUsed: Boolean(stored?.lastAttemptAt !== null && stored?.lastAttemptAt !== undefined),
							};
						})();
		const managedForPresentation = managedRowState(managed?.[target.id]);
		const shown = connectionPresentation({
			...rowFacts,
			// `idle` means "no managed process", which the model expresses as absent.
			managed: managedForPresentation === "idle" ? null : managedForPresentation,
		});
		/** CSS still keys on the row's own status word; it is derived from the
		 *  phase so there is one source and the stylesheet keeps its selectors. */
		const status: RowStatus =
			shown.phase === "connected"
				? "connected"
				: shown.phase === "connecting"
					? "connecting"
					: shown.phase === "failed"
						? "failed"
						: rowFacts.connected === false && "lastUsed" in rowFacts && rowFacts.lastUsed
							? "last-used"
							: "unknown";
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
						<span className="gui-conn-status-word">{t(shown.labelKey)}</span>
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
		<div className="gui-conn" data-state={state} data-embedded={embedded ? "true" : "false"}>
			{embedded || formOnly ? null : (
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
					{/* The same sentence the locations dialog leads with. This surface
					 * sets the instance axis only, and saying so is what stops the row
					 * list from reading as "all the places MusePi can be". */}
					<p className="gui-conn-axis">{t("settings.instanceAxisHint")}</p>
				</header>
			)}

			{formOnly ? null : (
				<section className="gui-conn-section" aria-labelledby="gui-conn-targets">
					<h2 className="gui-conn-title" id="gui-conn-targets">
						{t("settings.instanceAxisTitle")}
					</h2>
					<ul className="gui-conn-list">{targets.map(renderRow)}</ul>
				</section>
			)}

			{adding ? (
				<section
					className="gui-conn-section gui-conn-form"
					aria-label={editingId ? t("settings.connectionEditTarget") : t("settings.addInstance")}
				>
					{/* Choose the transport first, as cards. The chips below then
					 * refine the pair (this machine or a host; the host's system, a
					 * container or WSL) instead of asking a user to pick a vocabulary
					 * before they know which one they want. */}
					<div className="gui-conn-cards" role="radiogroup" aria-label={t("settings.connectionKind")}>
						{transportCards.map(card => {
							const selected = draft.kind === card.kind;
							return (
								<button
									key={card.kind}
									type="button"
									role="radio"
									aria-checked={selected}
									data-state={card.state}
									className="gui-conn-card gui-conn-transport-card"
									onClick={() => {
										setDraft(current => ({
											...current,
											kind: card.kind,
											// A transport implies a location. WSL and a local
											// container run here; ssh is the remote case, which is
											// what the location chip then shows.
											location: card.kind === "ssh" ? "remote" : current.location,
										}));
									}}
								>
									<span className="gui-conn-transport-icon" aria-hidden>
										<Icon name={card.icon} className="h-4 w-4" />
									</span>
									<span className="gui-conn-transport-copy">
										<span className="gui-conn-transport-label">{card.label}</span>
										<span className="gui-conn-transport-hint">{card.hint}</span>
									</span>
									{card.state === "checking" && (
										<span className="gui-conn-transport-state">
											{card.kind === "docker"
												? t("settings.connectionDetectingDocker")
												: t("settings.connectionDetecting")}
										</span>
									)}
									{card.state === "blocked" && (
										<span className="gui-conn-transport-state" data-tone="blocked">
											{t("settings.connectionTransportBlocked")}
										</span>
									)}
								</button>
							);
						})}
					</div>

					{/* Two questions instead of one `kind`: where the daemon runs,
					 * and in what. The pair is the whole model, and it is what keeps a
					 * remote container honest: it is a real pair now, so the chip is
					 * offered and the transport is carried, rather than refused. */}
					{/* Location is a real question for exactly one transport.
					 * A container can be on this machine or on a host; a WSL
					 * distribution is local by definition, and an ssh host IS the
					 * remote location. Asking it for all three restated what the
					 * card had already said, which is what made the form read as
					 * two competing pickers instead of one. */}
					{draft.kind === "docker" && (
						<div className="gui-conn-axis">
							<span className="gui-conn-axis-label">{t("settings.instanceLocation")}</span>
							<div className="gui-conn-kinds" role="radiogroup" aria-label={t("settings.instanceLocation")}>
								{(["local", "remote"] as const).map(location => (
									<button
										key={location}
										type="button"
										role="radio"
										aria-checked={axes.location === location}
										className="gui-conn-kind-btn"
										onClick={() => setDraft(current => ({ ...current, location }))}
									>
										<Icon name={location === "local" ? "computer" : "server"} className="h-3.5 w-3.5" />
										{location === "local"
											? t("settings.locationThisComputer")
											: t("settings.locationRemoteHost")}
									</button>
								))}
							</div>
						</div>
					)}

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

					{/* Host facts, asked once per host rather than once per kind: a
					 * daemon on a build box and a container on that same box differ
					 * only in what runs there, so they answer the same questions. */}
					{(draft.kind === "ssh" || remoteContainer) && (
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
							{draft.kind === "ssh" && (
								<label className="gui-field">
									<span className="gui-field-label">{t("settings.connectionRemotePort")}</span>
									<input
										className="gui-input font-mono"
										value={draft.remotePort}
										inputMode="numeric"
										onChange={e => setDraft(current => ({ ...current, remotePort: e.target.value }))}
									/>
								</label>
							)}
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
							{/* One control for one value. The picker and a free-text field
							 * were both bound to `container`, so a name from the list
							 * appeared twice in two shapes — the same fact rendered as a
							 * choice and as a duplication. The picker leads; the field
							 * appears only when the list cannot supply the name. */}
							{docker !== "checking" &&
							docker !== "idle" &&
							docker.state === "ready" &&
							docker.containers.length > 0 ? (
								<>
									<p className="gui-conn-note" role="status">
										{t("settings.connectionDockerContainers")}
									</p>
									<select
										className="gui-input font-mono"
										value={docker.containers.some(row => row.name === draft.container) ? draft.container : ""}
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
							) : (
								<input
									className="gui-input font-mono"
									value={draft.container}
									spellCheck={false}
									aria-label={t("settings.connectionContainer")}
									onChange={e => setDraft(current => ({ ...current, container: e.target.value }))}
								/>
							)}
							{docker !== "checking" &&
								docker !== "idle" &&
								docker.state === "ready" &&
								docker.containers.length === 0 && (
									<p className="gui-conn-note" role="status">
										{t("settings.connectionDockerNone")}
									</p>
								)}
							{docker !== "checking" && docker !== "idle" && docker.state === "list-failed" && (
								<p className="gui-conn-note" role="status">
									{t("settings.connectionDockerListFailed")}
									{docker.error ? ` — ${docker.error}` : ""}
								</p>
							)}
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
								// Embedded in the locations dialog, dismissing has to
								// re-offer the action that opened this form. Left alone, the
								// dialog kept a closed form and no way back to it: the list
								// said 添加实例 but the button that says it is what the form
								// replaced. The handler is the one path that knows a form was
								// dismissed rather than a target added.
								onFormClosed?.();
							}}
						>
							{t("settings.cancel")}
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
