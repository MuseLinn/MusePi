/**
 * Work-in-progress summary for the desktop update handoff.
 *
 * One definition of "busy" feeds both the quit confirmation and the update
 * restart gate. The shell asks at handoff time, not from a cached poll, so a
 * turn that started since the last UI refresh still counts.
 */

/** One live session's contribution to the summary. */
export interface UpdateTaskSession {
	/** Generating, compacting, running a tool, or holding an approval. */
	busy?: boolean;
	/** Messages queued behind the current turn. */
	queuedMessages?: number;
	/** Background jobs still running in this session. */
	runningJobs?: number;
	/** Tool approvals waiting on the user. */
	pendingApprovals?: number;
	/** Scheduled reminders whose timers are armed in this process. */
	armedSchedules?: number;
}

/** Counts the shell shows and gates on, never a boolean-only answer. */
export interface UpdateTasksSummary {
	activeSessions: number;
	queuedMessages: number;
	runningJobs: number;
	pendingApprovals: number;
	armedSchedules: number;
	/** Replacing the process now interrupts running work or drops queued messages. */
	activeTasks: boolean;
	/** A loaded session holds an armed reminder that would never fire. */
	scheduledTasks: boolean;
}

/** Clamp an untrusted count to a non-negative integer. */
function count(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * @param sessions - Live sessions (main, subagent, advisor) and their work.
 * @param globalRunningJobs - Detached async jobs owned by the daemon process.
 */
export function summarizeUpdateTasks(
	sessions: readonly UpdateTaskSession[],
	globalRunningJobs = 0,
): UpdateTasksSummary {
	let activeSessions = 0;
	let queuedMessages = 0;
	let runningJobs = count(globalRunningJobs);
	let pendingApprovals = 0;
	let armedSchedules = 0;
	for (const session of sessions) {
		if (session.busy === true) activeSessions += 1;
		queuedMessages += count(session.queuedMessages);
		runningJobs += count(session.runningJobs);
		pendingApprovals += count(session.pendingApprovals);
		armedSchedules += count(session.armedSchedules);
	}
	return {
		activeSessions,
		queuedMessages,
		runningJobs,
		pendingApprovals,
		armedSchedules,
		activeTasks: activeSessions + queuedMessages + runningJobs + pendingApprovals > 0,
		scheduledTasks: armedSchedules > 0,
	};
}
