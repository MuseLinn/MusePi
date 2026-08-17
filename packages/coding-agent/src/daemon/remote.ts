/**
 * Daemon remote-workspace RPC handlers.
 *
 * Turns an `omp ssh` host into a session workspace by mounting the remote
 * filesystem via sshfs (`~/.musepi/remote/<name>/`). Once mounted, the mount
 * path is an ordinary local path, so every existing tool (read/bash/glob/
 * write) works on the remote directory unchanged — the session simply gets
 * `cwd = <mountPath>/<remoteDir>`.
 *
 * Conditions surfaced to the GUI:
 * - sshfs availability (hasSshfs) — missing binary gets a platform hint
 * - host existence (omp ssh add) — connect fails with a clear message
 * - key-based auth only for now (daemon has no TTY for interactive prompts)
 * - mount idempotency (already-mounted returns the same mount path)
 * - browse is jailed to the mount path (no path traversal)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getSSHConfigPath } from "@musepi/pi-utils";
import { readSSHConfigFile, type SSHHostConfig, writeSSHConfigFile } from "../ssh/config-writer";
import { ensureHostInfo } from "../ssh/connection-manager";
import { getMountPath, hasSshfs, isMounted, mountRemote, unmountRemote } from "../ssh/sshfs-mount";

export interface RemoteHostEntry extends SSHHostConfig {
	name: string;
}

export interface RemoteHostList {
	hosts: RemoteHostEntry[];
	sshfs: boolean;
}

export interface RemoteConnectResult {
	mountPath: string;
	os: string;
	shell: string;
	alreadyMounted: boolean;
}

export interface RemoteBrowseEntry {
	name: string;
	dir: boolean;
}

export interface RemoteBrowseResult {
	path: string;
	parent: string | null;
	entries: RemoteBrowseEntry[];
}

interface RemoteHelpers {
	sshConfigPath(): string;
	hasSshfs(): boolean;
	getMountPath(target: { name: string; host: string }): string;
	isMounted(mountPath: string): Promise<boolean>;
	mountRemote(target: unknown, remotePath: string): Promise<string | undefined>;
	unmountRemote(target: unknown): Promise<boolean>;
	ensureHostInfo(target: unknown): Promise<{ os: string; shell: string }>;
}

const helpers: RemoteHelpers = {
	sshConfigPath: () => getSSHConfigPath("user"),
	hasSshfs,
	getMountPath: target => getMountPath(target),
	isMounted: mountPath => isMounted(mountPath),
	mountRemote: (target, remotePath) => mountRemote(target as never, remotePath),
	unmountRemote: target => unmountRemote(target as never),
	ensureHostInfo: target => ensureHostInfo(target as never),
};

/** Test seam (mirrors connection-manager's `_sshHelpersForTests`). */
export const _remoteForTests = {
	setHelpers(partial: Partial<RemoteHelpers>): void {
		Object.assign(helpers, partial);
	},
};

/** List saved hosts from the user ssh.json (what `omp ssh list` shows). */
export async function listRemoteHosts(): Promise<RemoteHostList> {
	const config = await readSSHConfigFile(helpers.sshConfigPath());
	const hosts: RemoteHostEntry[] = Object.entries(config.hosts ?? {}).map(([name, cfg]) => ({ name, ...cfg }));
	return { hosts, sshfs: helpers.hasSshfs() };
}

async function getHostConfig(name: string): Promise<RemoteHostEntry> {
	const config = await readSSHConfigFile(helpers.sshConfigPath());
	const cfg = config.hosts?.[name];
	if (!cfg) throw new Error(`Host "${name}" not found — add it first (omp ssh add <name> --host <addr>)`);
	return { name, ...cfg };
}

/**
 * Connect to a saved host: probe the remote (OS/shell) and mount its
 * filesystem at ~/.musepi/remote/<name>/. Mounting the root gives the GUI
 * the whole remote tree to browse for a workspace directory.
 */
export async function connectRemoteHost(params: { name?: unknown }): Promise<RemoteConnectResult> {
	const name = typeof params?.name === "string" ? params.name : "";
	if (!name) throw new Error("remote.connect: name required");
	const entry = await getHostConfig(name);

	if (!helpers.hasSshfs()) {
		throw new Error(
			"sshfs is not installed. macOS: brew install gromgit/fuse/sshfs-mac (or macFUSE + sshfs). Windows: install WinFsp + sshfs-win.",
		);
	}

	const target = {
		name,
		host: entry.host,
		username: entry.username,
		port: entry.port,
		keyPath: entry.keyPath,
		compat: entry.compat,
	};
	const mountPoint = helpers.getMountPath(target);
	const alreadyMounted = await helpers.isMounted(mountPoint);

	// Probe first (auth failures surface here with the ssh stderr), then mount.
	const info = await helpers.ensureHostInfo(target);
	const mountPath = await helpers.mountRemote(target, "/");
	if (!mountPath) throw new Error(`Failed to mount ${name}: sshfs mount returned no mount point`);

	return { mountPath, os: info.os, shell: info.shell, alreadyMounted };
}

/**
 * List a remote directory through the active mount. `path` is relative to
 * the mount root; the result is jailed to the mount path (no traversal).
 */
export async function browseRemoteDir(params: { name?: unknown; path?: unknown }): Promise<RemoteBrowseResult> {
	const name = typeof params?.name === "string" ? params.name : "";
	if (!name) throw new Error("remote.browse: name required");
	const entry = await getHostConfig(name);
	const mountPoint = helpers.getMountPath({ name, host: entry.host });

	if (!(await helpers.isMounted(mountPoint))) {
		throw new Error(`Host "${name}" is not connected — connect first`);
	}

	const rel = typeof params.path === "string" && params.path.length > 0 ? params.path : "/";
	const abs = path.resolve(mountPoint, rel.replace(/^\/+/, ""));
	if (abs !== mountPoint && !abs.startsWith(mountPoint + path.sep)) {
		throw new Error(`remote.browse: path escapes mount (${rel})`);
	}

	let stat: fs.Stats;
	try {
		stat = await fs.promises.stat(abs);
	} catch {
		throw new Error(`remote.browse: no such path (${rel})`);
	}
	if (!stat.isDirectory()) throw new Error(`remote.browse: not a directory (${rel})`);

	let names: string[];
	try {
		names = await fs.promises.readdir(abs);
	} catch (err) {
		throw new Error(`remote.browse: cannot read ${rel}: ${err instanceof Error ? err.message : String(err)}`);
	}

	const entries: RemoteBrowseEntry[] = [];
	for (const nameEntry of names) {
		// Skip dotfiles for a clean picker; stat per entry (dirs sort first).
		if (nameEntry.startsWith(".")) continue;
		let dir = false;
		try {
			dir = (await fs.promises.stat(path.join(abs, nameEntry))).isDirectory();
		} catch {
			// unreadable entry — list as file
		}
		entries.push({ name: nameEntry, dir });
	}
	entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));

	const displayPath = rel === "/" ? "/" : rel.replace(/\/+$/, "");
	const parent =
		displayPath === "/" ? null : path.posix.dirname(displayPath) === "." ? "/" : path.posix.dirname(displayPath);
	return { path: displayPath, parent, entries };
}

/** Unmount a connected host and report whether it was mounted. */
export async function disconnectRemoteHost(params: { name?: unknown }): Promise<{ unmounted: boolean }> {
	const name = typeof params?.name === "string" ? params.name : "";
	if (!name) throw new Error("remote.disconnect: name required");
	const entry = await getHostConfig(name);
	const target = {
		name,
		host: entry.host,
		username: entry.username,
		port: entry.port,
		keyPath: entry.keyPath,
		compat: entry.compat,
	};
	const unmounted = await helpers.unmountRemote(target);
	return { unmounted };
}

/** Add a host to the user ssh.json (GUI "new host" form). */
export async function addRemoteHost(params: {
	name?: unknown;
	host?: unknown;
	username?: unknown;
	port?: unknown;
	keyPath?: unknown;
}): Promise<{ ok: boolean }> {
	const name = typeof params?.name === "string" ? params.name.trim() : "";
	const host = typeof params?.host === "string" ? params.host.trim() : "";
	if (!name || !host) throw new Error("remote.hostAdd: name and host required");
	const config = await readSSHConfigFile(helpers.sshConfigPath());
	config.hosts = config.hosts ?? {};
	config.hosts[name] = {
		host,
		...(typeof params.username === "string" && params.username.length > 0 ? { username: params.username } : {}),
		...(typeof params.port === "number" && params.port > 0 ? { port: params.port } : {}),
		...(typeof params.keyPath === "string" && params.keyPath.length > 0 ? { keyPath: params.keyPath } : {}),
	};
	await writeSSHConfigFile(helpers.sshConfigPath(), config);
	return { ok: true };
}
