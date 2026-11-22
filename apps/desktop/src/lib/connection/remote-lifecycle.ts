/**
 * Managed target lifecycle — the renderer's half.
 *
 * `targets.ts` used to say outright that nothing here starts a tunnel. That is
 * no longer true: a forwarded target now asks the main process to run the
 * process its endpoint needs, and reads back the supervisor's status. The
 * split matters:
 *
 *  - the **process** lives in the main process (`electron/remote-targets.cjs`),
 *    which alone knows which handles this run owns;
 *  - the **decision** (does this row need a process at all? is a status a
 *    failure the row should show?) lives here, pure, so it is testable without
 *    Electron;
 *  - the **bridge** is one injectable object, so a test drives the same code
 *    paths the packaged shell does.
 *
 * The rows keep their copyable command. Managed lifecycle is an offer beside
 * it, not a replacement: a user with their own ssh config and their own tunnel
 * reads the command and runs it, and this module must never claim a tunnel it
 * did not start.
 */

import { mergeHostCatalog, parseSshConfig } from "./ssh-config";
import type { ConnectionTarget } from "./targets";

/** What the main process reports about one target it manages. */
export interface ManagedTargetStatus {
	targetId: string;
	kind: "ssh" | "wsl" | "docker";
	status: "connecting" | "running" | "failed" | "stopped";
	pid: number | null;
	startedAt: number | null;
	listeningPort: number | null;
	/** ssh/docker/wsl's own words when the process failed. */
	error: string | null;
	/** Tail of the process's stderr, kept apart from the error summary. */
	stderr: string;
	command: string | null;
}

/** One catalog host, merged from MusePi's ssh.json and `~/.ssh/config`. */
export interface CatalogHost {
	name: string;
	host: string;
	username?: string;
	port?: number;
	keyPath?: string;
	proxyJump?: string;
	source: "musepi" | "ssh-config";
}

/** Result shape every lifecycle call returns (never throws for a known cause). */
type LifecycleResult =
	| { ok: true; status: ManagedTargetStatus }
	| { ok: false; reason: string; error?: string; status?: ManagedTargetStatus };

/**
 * The preload bridge. Absent outside Electron (and in a test that did not
 * inject one), which is what {@link hasManagedLifecycle} answers.
 */
export interface ShellBridge {
	platform?: string;
	listWslDistributions?(): Promise<string | null>;
	sshConfig?(): Promise<{
		ok: boolean;
		documents: Array<{ path: string; text: string }>;
		musepi?: Array<{ name: string; host: string; username?: string; port?: number; keyPath?: string }>;
		error?: string;
	}>;
	startSshTunnel?(input: {
		id: string;
		localPort: number;
		remotePort: number;
		destination: string;
		sshPort?: number;
		proxyJump?: string;
		keyPath?: string;
	}): Promise<LifecycleResult>;
	startWslDaemon?(input: { id: string; distro: string; port: number }): Promise<LifecycleResult>;
	stopTarget?(targetId: string): Promise<{ ok: boolean; stopped: boolean; reason?: string }>;
	listTargets?(): Promise<ManagedTargetStatus[]>;
	detectDocker?(): Promise<{ available: boolean; version?: string; reason?: string; error?: string }>;
	dockerContainers?(daemonPort: number): Promise<{
		ok: boolean;
		containers?: Array<{ name: string; image: string; hostPort: number; containerPort: number }>;
		reason?: string;
		error?: string;
	}>;
	dockerRun?(input: { name: string; port: number; image?: string }): Promise<LifecycleResult>;
	dockerExec?(input: { id: string; container: string; port: number }): Promise<LifecycleResult>;
	onTargetStatus?(cb: (status: ManagedTargetStatus) => void): () => void;
}

/** Read the injected bridge (or the real preload one) from `window`. */
export function shellBridge(): ShellBridge | null {
	const bridge = (globalThis as { musepiShell?: ShellBridge }).musepiShell;
	return bridge ?? null;
}

/** Can this shell spawn and supervise processes at all? */
export function hasManagedLifecycle(bridge: ShellBridge | null = shellBridge()): boolean {
	return Boolean(bridge?.startSshTunnel);
}

/**
 * Why a managed start is not possible for this row, or `null` when it is.
 *
 * A row that cannot be managed still works — the user runs the command. This
 * only decides whether to offer the button, so the answer has to be honest
 * rather than optimistic: offering 启动 on a row whose command needs a
 * parameter it lacks would fail on the first click.
 */
export function managedStartBlocker(target: ConnectionTarget, platform: string | undefined): string | null {
	if (target.kind === "local" || target.kind === "manual") return "not-managed-kind";
	if (target.kind === "wsl" && platform !== "win32") return "not-this-platform";
	if (target.kind === "ssh" && !target.sshHost) return "missing-host";
	if (target.kind === "docker" && !target.container) return "missing-container";
	if (target.kind === "wsl" && !target.distro) return "missing-distro";
	return null;
}

/**
 * The daemon port on the far side of a forward.
 *
 * The local endpoint and the remote daemon are two different ports whenever
 * the user typed a custom local endpoint, so this must not be the local one.
 */
export function remoteDaemonPort(target: ConnectionTarget, fallback: number): number {
	return target.remotePort ?? fallback;
}

/** What the row's status should read, given the supervisor's last word. */
export type ManagedRowState = "idle" | "starting" | "running" | "failed";

/**
 * Fold a supervisor status into the row's state.
 *
 * `stopped` is `idle`, not `failed`: a user who pressed 停止 got what they
 * asked for, and showing an error for it would make an intentional action look
 * like a fault — the same distinction the connection state model makes between
 * a deliberate disconnect and an unreachable daemon.
 */
export function managedRowState(status: ManagedTargetStatus | undefined): ManagedRowState {
	if (!status) return "idle";
	switch (status.status) {
		case "connecting":
			return "starting";
		case "running":
			return "running";
		case "failed":
			return "failed";
		default:
			return "idle";
	}
}

/**
 * The failure text a row shows for a managed target.
 *
 * ssh's own stderr is the answer when it exists: "Permission denied
 * (publickey)" and "bind: Address already in use" are actionable in a way that
 * "tunnel failed" never is. The summary stands in only when stderr was silent.
 */
export function managedFailureText(status: ManagedTargetStatus | undefined): string | null {
	if (status?.status !== "failed") return null;
	const stderr = status.stderr.trim();
	if (stderr) return stderr;
	const error = (status.error ?? "").trim();
	return error || null;
}

/** Merge a pushed status into a status map without dropping other rows. */
export function applyTargetStatus(
	statuses: Record<string, ManagedTargetStatus>,
	status: ManagedTargetStatus,
): Record<string, ManagedTargetStatus> {
	return { ...statuses, [status.targetId]: status };
}

/**
 * Drop statuses whose target no longer exists.
 *
 * A removed row would otherwise leave a live process behind with nothing on
 * screen naming it, so removal has to stop it first; this only cleans the map
 * once that happened.
 */
export function pruneTargetStatuses(
	statuses: Record<string, ManagedTargetStatus>,
	targets: readonly ConnectionTarget[],
): Record<string, ManagedTargetStatus> {
	const live = new Set(targets.map(target => target.id));
	const next: Record<string, ManagedTargetStatus> = {};
	for (const [id, status] of Object.entries(statuses)) {
		if (live.has(id)) next[id] = status;
	}
	return next;
}

/** The `ssh` argv the tunnel builder would produce, for the row's preview. */
export function tunnelPreview(input: {
	localPort: number;
	remotePort: number;
	destination: string;
	sshPort?: number;
	proxyJump?: string;
	keyPath?: string;
}): string {
	const parts = ["ssh", "-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes"];
	if (input.sshPort && input.sshPort !== 22) parts.push("-p", String(input.sshPort));
	if (input.keyPath) parts.push("-i", input.keyPath);
	if (input.proxyJump) parts.push("-J", input.proxyJump);
	parts.push("-L", `${input.localPort}:127.0.0.1:${input.remotePort}`, input.destination);
	return parts.join(" ");
}

/**
 * The one host catalog both surfaces read.
 *
 * Two sources feed it — MusePi's `ssh.json` and the user's `~/.ssh/config` —
 * and {@link mergeHostCatalog} states the precedence (MusePi wins a name
 * collision). A missing or malformed `~/.ssh/config` contributes nothing
 * instead of failing, so a user with no ssh setup still gets their MusePi
 * hosts, and a user with only an ssh config still gets theirs.
 *
 * Reading goes through the shell bridge because the renderer cannot touch the
 * filesystem; without the bridge (a browser build, or a test) the catalog is
 * empty and every caller keeps its manual form.
 */
export async function loadHostCatalog(bridge: ShellBridge | null = shellBridge()): Promise<CatalogHost[]> {
	if (!bridge?.sshConfig) return [];
	let payload: Awaited<ReturnType<NonNullable<ShellBridge["sshConfig"]>>>;
	try {
		payload = await bridge.sshConfig();
	} catch {
		// A bridge that threw is the same as no bridge: no catalog, manual form.
		return [];
	}
	const documents = Array.isArray(payload?.documents) ? payload.documents : [];
	const fromSshConfig = parseSshConfig(documents);
	const fromMusepi = (Array.isArray(payload?.musepi) ? payload.musepi : []).map(row => ({
		name: row.name,
		host: row.host,
		...(row.username ? { username: row.username } : {}),
		...(row.port ? { port: row.port } : {}),
		...(row.keyPath ? { keyPath: row.keyPath } : {}),
	}));
	return mergeHostCatalog(fromMusepi, fromSshConfig);
}

/**
 * A target row for a catalog host, ready for the manager's list.
 *
 * The endpoint is loopback with the daemon default because that is what the
 * tunnel publishes; the host facts ride along so the managed start can build
 * the same forward, and `sshHost` stays the raw destination so a row written
 * before the catalog existed still matches its entry.
 */
export function targetFromCatalogHost(
	entry: CatalogHost,
	port: number,
): Omit<ConnectionTarget, "url"> & { url: string } {
	return {
		id: `ssh-${entry.name}`,
		label: entry.name,
		url: `ws://127.0.0.1:${port}`,
		kind: "ssh",
		sshHost: entry.username ? `${entry.username}@${entry.host}` : entry.host,
		remotePort: port,
		...(entry.port ? { sshPort: entry.port } : {}),
		...(entry.proxyJump ? { proxyJump: entry.proxyJump } : {}),
		...(entry.keyPath ? { keyPath: entry.keyPath } : {}),
	};
}
