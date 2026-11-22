/**
 * Connection targets — the rows the connection manager shows and the shell
 * boots from.
 *
 * A target is a daemon endpoint plus how that endpoint is produced. The
 * endpoint itself is always a plain WebSocket URL, because that is the only
 * thing {@link RpcClient} can open; the target kind only explains where the
 * URL comes from and which command gets a daemon listening there.
 *
 * Ownership boundary (deliberate): this mission stores the endpoint and
 * connects to it. It does not start WSL daemons, open SSH tunnels or run
 * containers — the rows show the exact command to copy, and the managed
 * lifecycle is a follow-up. Nothing here may claim a tunnel is running.
 */

/** How a target's endpoint is produced. */
export type ConnectionTargetKind = "local" | "wsl" | "ssh" | "docker" | "manual";

/** Kinds that need an external process before the endpoint can answer. */
export function isForwardedKind(kind: ConnectionTargetKind): boolean {
	return kind === "wsl" || kind === "ssh" || kind === "docker";
}

/** Default daemon port, matching the shell's `DEFAULT_PORT` fallback. */
export const DEFAULT_DAEMON_PORT = 8300;

/** Reserved id of the always-present local row. */
export const LOCAL_TARGET_ID = "local";

/**
 * One stored target. Field-for-field the persisted `RemoteHost` shape plus the
 * kind and its parameters, so `remote-hosts.ts` stays the single owner of the
 * storage slot (no second store, no migration step).
 */
export interface ConnectionTarget {
	id: string;
	label: string;
	/** WebSocket endpoint the shell connects to (no token; see buildWsUrl). */
	url: string;
	token?: string;
	kind: ConnectionTargetKind;
	/** `wsl` — distribution name as `wsl.exe -l -q` reports it. */
	distro?: string;
	/** `ssh` — `user@host` or `host`. */
	sshHost?: string;
	/** `ssh` — daemon port on the remote side (defaults to the daemon port). */
	remotePort?: number;
	/** `docker` — container name. */
	container?: string;
}

/** Local daemon URL for the default port. */
export function localTargetUrl(port: number = DEFAULT_DAEMON_PORT): string {
	return `ws://127.0.0.1:${port}`;
}

/** The row every install has, even before the user adds anything. */
export function localTarget(port: number = DEFAULT_DAEMON_PORT): ConnectionTarget {
	return {
		id: LOCAL_TARGET_ID,
		label: "local",
		url: localTargetUrl(port),
		kind: "local",
	};
}

/** Is this endpoint a loopback URL (the only kind the shell may spawn for)? */
export function isLoopbackUrl(url: string): boolean {
	try {
		const host = new URL(url).hostname;
		return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
	} catch {
		return false;
	}
}

/**
 * The endpoint without its `?token=`. A stored row keeps its secret out of its
 * own `url` (the token rides the URL only at connect time), so comparing raw
 * strings would leave a token-bearing connection unmatched to its row.
 */
export function stripToken(url: string): string {
	const index = url.indexOf("?");
	if (index === -1) return url;
	const params = new URLSearchParams(url.slice(index));
	params.delete("token");
	const rest = params.toString();
	return rest ? `${url.slice(0, index)}?${rest}` : url.slice(0, index);
}

/**
 * The command a user copies to get a daemon listening on a forwarded endpoint.
 * Empty for `local` (the shell owns that process) and `manual` (the user
 * already has an endpoint).
 */
export function targetCommand(target: ConnectionTarget): string | null {
	switch (target.kind) {
		case "wsl": {
			if (!target.distro) return null;
			const port = portOf(target.url) ?? DEFAULT_DAEMON_PORT;
			return `wsl.exe -d ${shellWord(target.distro)} -- musepi serve --port ${port}`;
		}
		case "ssh": {
			if (!target.sshHost) return null;
			const local = portOf(target.url) ?? DEFAULT_DAEMON_PORT;
			const remote = target.remotePort ?? DEFAULT_DAEMON_PORT;
			const forward = local === remote ? `${local}:127.0.0.1:${remote}` : `${local}:127.0.0.1:${remote}`;
			return `ssh -N -L ${forward} ${shellWord(target.sshHost)}`;
		}
		case "docker": {
			if (!target.container) return null;
			const port = portOf(target.url) ?? DEFAULT_DAEMON_PORT;
			return `docker exec ${shellWord(target.container)} musepi serve --port ${port}`;
		}
		default:
			return null;
	}
}

/** Secondary line under the command: the container publish requirement. */
export function targetPublishHint(target: ConnectionTarget): string | null {
	if (target.kind !== "docker") return null;
	const port = portOf(target.url) ?? DEFAULT_DAEMON_PORT;
	return `docker run -d -p 127.0.0.1:${port}:${port} --name ${shellWord(target.container ?? "<name>")} musepi`;
}

function portOf(url: string): number | null {
	try {
		const parsed = new URL(url);
		const port = Number.parseInt(parsed.port, 10);
		if (Number.isInteger(port) && port > 0) return port;
		return parsed.protocol === "wss:" ? 443 : 80;
	} catch {
		return null;
	}
}

/** Quote a word for a shell when it is not already plain. */
function shellWord(value: string): string {
	return /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(value) ? value : `"${value.replace(/"/g, '\\"')}"`;
}

/**
 * Build a target from the manager's form draft. The URL is normalized by the
 * caller (`normalizeRemoteHostUrl`); this only attaches the kind parameters.
 */
export function createTarget(input: {
	id: string;
	label: string;
	url: string;
	token?: string;
	kind: ConnectionTargetKind;
	distro?: string;
	sshHost?: string;
	remotePort?: number;
	container?: string;
}): ConnectionTarget {
	const target: ConnectionTarget = {
		id: input.id,
		label: input.label.trim(),
		url: input.url,
		kind: input.kind,
	};
	if (input.token) target.token = input.token;
	if (input.kind === "wsl" && input.distro) target.distro = input.distro;
	if (input.kind === "ssh" && input.sshHost) target.sshHost = input.sshHost;
	if (input.kind === "ssh" && input.remotePort) target.remotePort = input.remotePort;
	if (input.kind === "docker" && input.container) target.container = input.container;
	return target;
}

const KINDS: readonly ConnectionTargetKind[] = ["local", "wsl", "ssh", "docker", "manual"];

/** Coerce a persisted row into a target, or null when it is unusable. */
export function asTarget(value: unknown): ConnectionTarget | null {
	if (typeof value !== "object" || value === null) return null;
	const row = value as Partial<ConnectionTarget>;
	if (typeof row.id !== "string" || typeof row.label !== "string" || typeof row.url !== "string") return null;
	if (!row.id || !row.url) return null;
	const kind = KINDS.includes(row.kind as ConnectionTargetKind) ? (row.kind as ConnectionTargetKind) : "manual";
	const target: ConnectionTarget = { id: row.id, label: row.label, url: row.url, kind };
	if (typeof row.token === "string" && row.token.length > 0) target.token = row.token;
	if (typeof row.distro === "string" && row.distro) target.distro = row.distro;
	if (typeof row.sshHost === "string" && row.sshHost) target.sshHost = row.sshHost;
	if (typeof row.remotePort === "number" && Number.isInteger(row.remotePort) && row.remotePort > 0) {
		target.remotePort = row.remotePort;
	}
	if (typeof row.container === "string" && row.container) target.container = row.container;
	return target;
}

/** Insert or replace a target by id, keeping list order stable. */
export function upsertTarget(targets: readonly ConnectionTarget[], target: ConnectionTarget): ConnectionTarget[] {
	const index = targets.findIndex(row => row.id === target.id);
	if (index === -1) return [...targets, target];
	const next = [...targets];
	next[index] = target;
	return next;
}

/** Remove a target; the local row is not removable. */
export function removeTarget(targets: readonly ConnectionTarget[], id: string): ConnectionTarget[] {
	if (id === LOCAL_TARGET_ID) return [...targets];
	return targets.filter(row => row.id !== id);
}

/** The target a boot should try: an explicitly chosen one, else local. */
export function bootTarget(targets: readonly ConnectionTarget[], chosenId: string | null): ConnectionTarget {
	const chosen = chosenId ? targets.find(row => row.id === chosenId) : undefined;
	return chosen ?? targets[0] ?? localTarget();
}
