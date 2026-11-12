/**
 * Process-level session ownership.
 *
 * The daemon is the single writer for a live session; CLI/TUI processes that
 * open the same session file directly must not append or rewrite it behind the
 * daemon's back. This lock protects that process boundary — not client
 * concurrency. Any number of GUI/mobile/IM clients may attach to the daemon.
 *
 * The holder file is `<dir>/<sessionId>.owner`:
 *   { token, pid, hostname, startedAt, instanceId, heartbeatAt }
 *
 * Stale ownership is claimed automatically (same host: pid gone; any host:
 * heartbeat older than `staleMs`). An explicit takeover can be requested by
 * the caller when the holder is still alive.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { withFileLock } from "@musepi/pi-utils/file-lock";

export interface SessionOwner {
	token: string;
	pid: number;
	hostname: string;
	startedAt: number;
	instanceId: string;
	heartbeatAt: number;
}

export interface SessionOwnerLock {
	readonly owner: SessionOwner;
	release(): Promise<void>;
}

export interface AcquireSessionOwnerOptions {
	/** Consider a holder stale after this long without a heartbeat. */
	staleMs?: number;
	/** Force-release a live holder. Only for an explicit user takeover. */
	takeover?: boolean;
	/** Daemon instance id written into the holder for diagnostics. */
	instanceId?: string;
	/** Heartbeat period; defaults to `HEARTBEAT_MS`. */
	heartbeatMs?: number;
	/** Called once when this process loses the file to another holder. */
	onLost?: () => void;
}

export class SessionOwnedError extends Error {
	readonly holder: SessionOwner;

	constructor(holder: SessionOwner) {
		super(
			`Session is owned by another MusePi process (pid ${holder.pid} on ${holder.hostname}). ` +
				"Close it there, or take over explicitly.",
		);
		this.name = "SessionOwnedError";
		this.holder = holder;
	}
}

const DEFAULT_STALE_MS = 30_000;
const HEARTBEAT_MS = 10_000;

/** Directory shared by the daemon and CLI/TUI owner checks. */
export function sessionLocksDir(): string {
	return path.join(process.env.MUSEPI_DAEMON_DIR || path.join(os.tmpdir(), "musepi-daemon"), "session-locks");
}

interface HeldLock {
	owner: SessionOwner;
	refs: number;
	timer: ReturnType<typeof setInterval> | null;
	/** Set once the heartbeat finds a different token in the file. */
	lost: boolean;
	/** Called when ownership is lost, so the live session disposes instead of
	 *  appending to a journal another process now owns. */
	onLost: (() => void) | null;
}

/** In-process refcount: two LiveSession instances for the same id (or two
 *  daemon hosts in one test process) share one file owner instead of fighting. */
const held = new Map<string, HeldLock>();

function safeSessionName(sessionId: string): string {
	return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function lockFile(dir: string, sessionId: string): string {
	return path.join(dir, `${safeSessionName(sessionId)}.owner`);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists but belongs to another user.
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function isStale(owner: SessionOwner, staleMs: number): boolean {
	if (Date.now() - owner.heartbeatAt > staleMs) return true;
	return owner.hostname === os.hostname() && !isProcessAlive(owner.pid);
}

async function readOwner(file: string): Promise<SessionOwner | null> {
	try {
		const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return null;
		const owner = parsed as Partial<SessionOwner>;
		if (
			typeof owner.token !== "string" ||
			typeof owner.pid !== "number" ||
			typeof owner.hostname !== "string" ||
			typeof owner.startedAt !== "number" ||
			typeof owner.instanceId !== "string" ||
			typeof owner.heartbeatAt !== "number"
		) {
			return null;
		}
		return owner as SessionOwner;
	} catch {
		return null;
	}
}

async function writeOwner(file: string, owner: SessionOwner): Promise<void> {
	const temp = `${file}.${owner.token}.tmp`;
	await fs.writeFile(temp, JSON.stringify(owner), { mode: 0o600 });
	await fs.rename(temp, file);
}

function handleFor(file: string, lock: HeldLock): SessionOwnerLock {
	return {
		owner: lock.owner,
		async release() {
			lock.refs -= 1;
			if (lock.refs > 0) return;
			if (lock.timer) clearInterval(lock.timer);
			held.delete(file);
			await withFileLock(file, async () => {
				const current = await readOwner(file);
				if (current?.token === lock.owner.token) {
					await fs.unlink(file).catch(() => {});
				}
			});
		},
	};
}

/**
 * Acquire ownership of one session for this process. Throws
 * `SessionOwnedError` when another live process holds it and takeover was not
 * requested.
 */
export async function acquireSessionOwnerLock(
	sessionId: string,
	dir: string,
	options: AcquireSessionOwnerOptions = {},
): Promise<SessionOwnerLock> {
	const file = lockFile(dir, sessionId);
	const existing = held.get(file);
	if (existing) {
		existing.refs += 1;
		return handleFor(file, existing);
	}

	await fs.mkdir(dir, { recursive: true });
	const owner: SessionOwner = {
		token: randomUUID(),
		pid: process.pid,
		hostname: os.hostname(),
		startedAt: Date.now(),
		instanceId: options.instanceId ?? randomUUID(),
		heartbeatAt: Date.now(),
	};

	return withFileLock(file, async () => {
		for (let attempt = 0; attempt < 2; attempt += 1) {
			try {
				const handle = await fs.open(file, "wx");
				try {
					await handle.writeFile(JSON.stringify(owner), "utf8");
				} finally {
					await handle.close();
				}
				const claimed = await readOwner(file);
				if (claimed !== null && claimed.token !== owner.token) throw new SessionOwnedError(claimed);
				if (claimed === null) continue;
				const lock: HeldLock = { owner, refs: 1, timer: null, lost: false, onLost: options.onLost ?? null };
				lock.timer = setInterval(() => {
					void (async () => {
						const lost = await withFileLock(file, async () => {
							const current = await readOwner(file);
							if (current?.token !== owner.token) return true;
							owner.heartbeatAt = Date.now();
							await writeOwner(file, owner).catch(() => {});
							return false;
						}).catch(() => false);
						if (!lost || lock.lost) return;
						if (lock.timer) clearInterval(lock.timer);
						lock.timer = null;
						lock.lost = true;
						held.delete(file);
						const onLost = lock.onLost;
						lock.onLost = null;
						onLost?.();
					})();
				}, options.heartbeatMs ?? HEARTBEAT_MS);
				lock.timer.unref?.();
				held.set(file, lock);
				return handleFor(file, lock);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const clearStale = async (): Promise<void> => {
					const aside = `${file}.stale.${owner.token}`;
					await fs.rename(file, aside).catch(() => {});
					await fs.unlink(aside).catch(() => {});
				};
				const current = await readOwner(file);
				if (!current) {
					// Unreadable/corrupt holder: treat as stale.
					await clearStale();
					continue;
				}
				if (options.takeover === true || isStale(current, options.staleMs ?? DEFAULT_STALE_MS)) {
					await clearStale();
					continue;
				}
				throw new SessionOwnedError(current);
			}
		}

		const current = await readOwner(file);
		if (current) throw new SessionOwnedError(current);
		throw new Error(`Could not acquire session owner lock for ${sessionId}`);
	});
}

/** Read the current owner without acquiring (diagnostics / takeover UI). */
export async function readSessionOwner(sessionId: string, dir: string): Promise<SessionOwner | null> {
	return readOwner(lockFile(dir, sessionId));
}
