/**
 * Target persistence — one storage slot, shared with the existing host
 * registry.
 *
 * The host list already lives at `musepi-gui-hosts` and the active endpoint at
 * `musepi-gui-url`; adding a second store would mean two sources of truth for
 * "where does this shell connect". So this module owns that same slot and
 * widens the rows in place: a row written before targets existed has no
 * `kind` and reads back as `manual`, which is exactly what it was. Nothing is
 * migrated. `remote-hosts.ts` keeps owning the URL normalizer and token
 * handling; the persisted list itself moved here.
 *
 * Per-target status is kept beside the list rather than inside it, so a probe
 * result never rewrites the user's rows: a target that fails stays listed with
 * its error instead of being replaced by it.
 */

import {
	asTarget,
	bootTarget,
	type ConnectionTarget,
	isForwardedKind,
	LOCAL_TARGET_ID,
	localTarget,
	removeTarget,
	stripToken,
	upsertTarget,
} from "./targets";

const TARGETS_KEY = "musepi-gui-hosts";
const CHOSEN_KEY = "musepi-gui-target-id";
const STATUS_KEY = "musepi-gui-target-status";

/** What the last attempt against one target produced. */
/**
 * Per-row status, kept beside the list (never inside it) so a failed attempt
 * cannot rewrite a user's target.
 */
interface TargetStatus {
	/** Unix ms of the last attempt, or null when never attempted. */
	lastAttemptAt: number | null;
	/** Last error, or null when the last attempt succeeded. */
	lastError: string | null;
}

/** Status keyed by target id. */
export type TargetStatusMap = Record<string, TargetStatus>;

function readStorage(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeStorage(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// storage unavailable (private mode) — the list simply won't persist
	}
}

/** Stored rows exactly as the slot holds them (no local row added). */
export function loadStoredTargets(): ConnectionTarget[] {
	const raw = readStorage(TARGETS_KEY);
	if (!raw) return [];
	const rows: ConnectionTarget[] = [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		for (const entry of parsed) {
			const target = asTarget(entry);
			if (target && !rows.some(row => row.id === target.id)) rows.push(target);
		}
	} catch {
		// corrupt slot: the caller falls back to its own default
	}
	return rows;
}

/** Every stored target, local row first. Never returns an empty list. */
export function loadTargets(port?: number): ConnectionTarget[] {
	const rows = loadStoredTargets();
	const local = localTarget(port);
	const index = rows.findIndex(row => row.id === local.id);
	if (index === -1) return [local, ...rows];
	// The local row's endpoint follows the shell's daemon port, which can be
	// overridden at launch (MUSEPI_GUI_DAEMON_PORT); the stored label/kind win
	// only for the fields the user can edit.
	const next = [...rows];
	next[index] = { ...local, ...rows[index] };
	return next;
}

export function saveTargets(targets: readonly ConnectionTarget[]): void {
	writeStorage(TARGETS_KEY, JSON.stringify(targets));
}

/** Id of the target the last successful connection used. */
export function loadChosenTargetId(): string | null {
	const value = readStorage(CHOSEN_KEY);
	return value && value.length > 0 ? value : null;
}

export function saveChosenTargetId(id: string | null): void {
	if (id === null) {
		try {
			localStorage.removeItem(CHOSEN_KEY);
		} catch {
			// storage unavailable
		}
		return;
	}
	writeStorage(CHOSEN_KEY, id);
}

/**
 * The endpoint the next launch boots from.
 *
 * The chooser names the row the last attempt started from — a failed row stays
 * chosen so the user can retry it. Two rows must not be pinned as a boot
 * endpoint when they did not answer:
 *
 *  - `wsl` / `ssh` / `docker` reach their daemon through a process this build
 *    does not manage yet (a forwarded port), so a silent endpoint has nothing
 *    left for boot to do and would fail the next launch the same way. Boot
 *    falls back to the local row, which it can probe and spawn, and the row
 *    stays listed with its error.
 *  - a `manual` row is the user's own chosen address: it is never silently
 *    replaced, because nothing else knows where that daemon is.
 */
export function bootTargetFor(
	targets: readonly ConnectionTarget[],
	chosenId: string | null,
	statuses: TargetStatusMap,
): ConnectionTarget {
	const chosen = chosenId ? targets.find(row => row.id === chosenId) : undefined;
	const failedForwarded =
		chosen !== undefined && isForwardedKind(chosen.kind) && (statuses[chosen.id]?.lastError ?? null) !== null;
	if (!failedForwarded) return bootTarget(targets, chosenId);
	return targets.find(row => row.id === LOCAL_TARGET_ID) ?? localTarget();
}

export function loadTargetStatuses(): TargetStatusMap {
	const raw = readStorage(STATUS_KEY);
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		const out: TargetStatusMap = {};
		for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof value !== "object" || value === null) continue;
			const row = value as Partial<TargetStatus>;
			out[id] = {
				lastAttemptAt: typeof row.lastAttemptAt === "number" ? row.lastAttemptAt : null,
				lastError: typeof row.lastError === "string" ? stripToken(row.lastError) : null,
			};
		}
		// A slot written before the scrub existed still holds its token; rewrite
		// the scrubbed copy so the old one does not linger on disk.
		if (JSON.stringify(out) !== JSON.stringify(parsed)) writeStorage(STATUS_KEY, JSON.stringify(out));
		return out;
	} catch {
		return {};
	}
}

export function saveTargetStatuses(statuses: TargetStatusMap): void {
	writeStorage(STATUS_KEY, JSON.stringify(statuses));
}

/** Record the outcome of an attempt without touching the target itself. */
export function recordTargetStatus(
	statuses: TargetStatusMap,
	id: string,
	error: string | null,
	at: number = Date.now(),
): TargetStatusMap {
	return { ...statuses, [id]: { lastAttemptAt: at, lastError: error } };
}

/**
 * The status map after one settled attempt.
 *
 * The one place a failure reason becomes storage, so every writer gets the same
 * treatment: the reason is scrubbed of any `?token=` first. `RpcClient` reports
 * the URL it dialled (`cannot connect to <url>`), and the connection URL is the
 * one that carries the token — storing that verbatim put the secret in a second
 * slot that outlived removing the token from the row.
 */
export function settledStatuses(
	statuses: TargetStatusMap,
	id: string,
	ok: boolean,
	reason: string | null,
	at: number = Date.now(),
): TargetStatusMap {
	return recordTargetStatus(statuses, id, ok || !reason ? null : stripToken(reason), at);
}

/**
 * Status after a row is added or edited.
 *
 * A stored error describes the credential that produced it, so a token change
 * (including removing it) drops that row's entry: keeping it would show an
 * error about a secret the row no longer has, and the stored message may have
 * captured the URL that carried it.
 */
export function statusesAfterTargetEdit(
	statuses: TargetStatusMap,
	previous: ConnectionTarget | undefined,
	next: ConnectionTarget,
): TargetStatusMap {
	if (!previous || previous.token === next.token) return statuses;
	if (!(next.id in statuses)) return statuses;
	const { [next.id]: _dropped, ...rest } = statuses;
	return rest;
}

/** Persist a new/edited target and return the full list it belongs to. */
export function storeTarget(targets: readonly ConnectionTarget[], target: ConnectionTarget): ConnectionTarget[] {
	const next = upsertTarget(targets, target);
	saveTargets(next);
	return next;
}

/** Drop a target (the local row is never removable) and its status. */
export function dropTarget(targets: readonly ConnectionTarget[], id: string): ConnectionTarget[] {
	const next = removeTarget(targets, id);
	saveTargets(next);
	const statuses = loadTargetStatuses();
	if (id in statuses) {
		const { [id]: _removed, ...rest } = statuses;
		saveTargetStatuses(rest);
	}
	return next;
}

/**
 * Which row is the shell pointed at right now?
 *
 * The stored endpoint may carry a `?token=` that a row's own `url` does not, so
 * comparing raw strings would leave the active row unhighlighted. Compare the
 * secret-free endpoint instead, and fall back to the chosen id.
 */
export function resolveActiveTargetId(
	targets: readonly ConnectionTarget[],
	daemonUrl: string,
	chosenId: string | null,
): string | null {
	const endpoint = stripToken(daemonUrl);
	const match = targets.find(target => target.url === endpoint);
	if (match) return match.id;
	if (chosenId && targets.some(target => target.id === chosenId)) return chosenId;
	return null;
}
