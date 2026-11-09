/**
 * Apply a plugin change to sessions that are already running.
 *
 * Installing, upgrading, enabling or removing a plugin currently only changes
 * what the *next* session loads; a GUI that reports "installed" while the open
 * session keeps running the old code is telling the truth about the disk and
 * lying about the thing the person can see. This module closes that gap the
 * way the host recomposes plugins elsewhere: hand the affected entry paths to
 * every live session and let each session decide whether it can swap now.
 *
 * The session is the authority on timing, not this module. A streaming session
 * parks the operation until its next idle boundary and reports
 * `deferred: true`; that is a normal outcome, not an error, and it is counted
 * separately so the caller can say "applies after this turn" instead of
 * claiming the change is live.
 *
 * Failure isolation is per operation and per session: one session whose entry
 * throws must not stop the other sessions from receiving the change, and the
 * errors are collected rather than thrown so a caller with one failed session
 * still learns what succeeded.
 */

import path from "node:path";
import { logger } from "@musepi/pi-utils";

/** What changed, expressed as entry paths rather than as a package. */
export interface LiveApplyTarget {
	/** Entries of a newly installed or newly enabled package. */
	readonly add?: readonly string[];
	/** Entries whose package was upgraded in place. */
	readonly reload?: readonly string[];
	/** Entries of a removed or disabled package. */
	readonly remove?: readonly string[];
}

/** The slice of a live session this module needs. */
export interface LiveApplySession {
	/** Stable id for error attribution when the session exposes one. */
	readonly sessionId?: string;
	listLoadedExtensions(): Array<{ path: string }>;
	loadExtension(entryPath: string): Promise<{ errors: string[]; deferred: boolean }>;
	reloadExtension(entryPath: string): Promise<{ errors: string[]; deferred: boolean }>;
	unloadExtension(entryPath: string): Promise<{ errors: string[]; deferred: boolean }>;
}

export interface LiveApplySummary {
	/** Sessions that had at least one applicable operation. */
	sessions: number;
	/** Entry operations performed immediately. */
	applied: number;
	/** Entry operations parked for the session's next idle boundary. */
	deferred: number;
	/** Per-session, per-entry failures; empty when everything applied. */
	errors: string[];
}

type EntryOp = "load" | "reload" | "unload";

interface PlannedOp {
	readonly entryPath: string;
	readonly op: EntryOp;
}

/**
 * Build the per-session operation list: `add` loads an entry the session does
 * not have and reloads one it already has (an upgrade replaces a mounted
 * module), `remove` only touches entries the session actually mounted.
 */
function planForSession(session: LiveApplySession, target: LiveApplyTarget): PlannedOp[] {
	const loaded = new Set(session.listLoadedExtensions().map(entry => path.resolve(entry.path)));
	const wanted = new Map<string, EntryOp>();
	const put = (entryPath: string, op: EntryOp) => {
		wanted.set(path.resolve(entryPath), op);
	};
	for (const entryPath of target.add ?? []) put(entryPath, loaded.has(path.resolve(entryPath)) ? "reload" : "load");
	for (const entryPath of target.reload ?? []) put(entryPath, "reload");
	for (const entryPath of target.remove ?? []) put(entryPath, "unload");

	const ops: PlannedOp[] = [];
	for (const [entryPath, op] of wanted) {
		if (op === "unload" && !loaded.has(entryPath)) continue;
		ops.push({ entryPath, op: op === "reload" && !loaded.has(entryPath) ? "load" : op });
	}
	return ops;
}

async function applyToSession(
	session: LiveApplySession,
	ops: readonly PlannedOp[],
	summary: LiveApplySummary,
): Promise<void> {
	let touched = false;
	for (const { entryPath, op } of ops) {
		touched = true;
		try {
			const result =
				op === "load"
					? await session.loadExtension(entryPath)
					: op === "reload"
						? await session.reloadExtension(entryPath)
						: await session.unloadExtension(entryPath);
			if (result.errors.length === 0) {
				if (result.deferred) summary.deferred += 1;
				else summary.applied += 1;
			}
			for (const error of result.errors) {
				summary.errors.push(`${sessionLabel(session)} ${entryPath}: ${error}`);
			}
		} catch (error) {
			summary.errors.push(
				`${sessionLabel(session)} ${entryPath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	if (touched) summary.sessions += 1;
}

function sessionLabel(session: LiveApplySession): string {
	return session.sessionId ? `[${session.sessionId}]` : "[session]";
}

/** Apply one plugin change to every session, isolating failures per entry. */
export async function applyPluginChangeToSessions(
	sessions: Iterable<LiveApplySession>,
	target: LiveApplyTarget,
): Promise<LiveApplySummary> {
	const summary: LiveApplySummary = { sessions: 0, applied: 0, deferred: 0, errors: [] };
	for (const session of sessions) {
		const ops = planForSession(session, target);
		if (ops.length === 0) continue;
		await applyToSession(session, ops, summary);
	}
	return summary;
}

/** Host capabilities a package-level change needs. */
export interface PackageApplyDeps {
	/** Entry paths contributed by a package; read before a removal deletes it. */
	resolvePackagePaths?(name: string): Promise<string[]>;
	/** Apply the change to sessions that are already running. */
	applyLive?(target: LiveApplyTarget): Promise<LiveApplySummary>;
	/** Broadcast the outcome so a watching GUI can say what happened. */
	onApplyState?(payload: Record<string, unknown>): void;
}

/**
 * Resolve a package's entries, apply the change, and announce the outcome.
 *
 * Returns `undefined` when the host has no live-apply surface (a partial host in
 * tests) or the package contributes no entries — both mean "nothing to apply",
 * which is not a failure. Resolve errors are announced as an error result
 * rather than thrown: the package operation itself already succeeded, and a
 * caller must not turn an apply failure into an install failure.
 */
export async function applyPackageChange(
	deps: PackageApplyDeps,
	change: "install" | "uninstall",
	packageName: string | undefined,
	knownPaths?: string[],
): Promise<LiveApplySummary | undefined> {
	if (!deps.applyLive || !packageName) return undefined;
	let summary: LiveApplySummary;
	try {
		const paths = knownPaths ?? (await deps.resolvePackagePaths?.(packageName)) ?? [];
		if (paths.length === 0) return undefined;
		summary = await deps.applyLive(change === "install" ? { add: paths } : { remove: paths });
	} catch (error) {
		summary = {
			sessions: 0,
			applied: 0,
			deferred: 0,
			errors: [error instanceof Error ? error.message : String(error)],
		};
	}
	// Nothing to do and nothing wrong: an install into a daemon with no open
	// session must not surface as "applied to 0 sessions". A failure is always
	// announced, even when no session was reached.
	if (summary.sessions === 0 && summary.errors.length === 0) return summary;
	try {
		deps.onApplyState?.({
			type: "plugins.apply.state",
			change,
			packageName,
			application: summary.deferred > 0 ? "pending" : "applied",
			applied: summary.applied,
			deferred: summary.deferred,
			errors: summary.errors,
			at: Date.now(),
		});
	} catch (error) {
		// Announcement is best-effort: the package operation and the live apply
		// already happened, and a closed event stream must not turn that into a
		// failed install.
		logger.warn("plugin apply state broadcast failed", {
			packageName,
			error: error instanceof Error ? error.message : String(error),
		});
	}
	return summary;
}
