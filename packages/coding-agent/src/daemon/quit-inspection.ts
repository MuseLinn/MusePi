/**
 * Quit inspection (dsh's `quit-inspection`).
 *
 * dsh asks the Host at quit time whether stopping it would interrupt work and
 * whether armed reminders would be lost, then chooses the confirmation copy.
 * The check is on demand, so a turn that started after the last UI poll still
 * counts. Pure over a small projection so the daemon handler and tests share
 * one definition of "active".
 */
export interface QuitInspectionSession {
	/** Generating, compacting, or running a tool. */
	busy?: boolean;
	/** Messages queued behind the current turn. */
	queuedMessages?: number;
	/** Background jobs still running. */
	runningJobs?: number;
	/** Scheduled reminders whose timers are armed in this process. */
	armedSchedules?: number;
}

export interface QuitInspection {
	/** Stopping now interrupts running work or drops queued messages. */
	activeTasks: boolean;
	/** A loaded session holds an armed reminder that would never fire. */
	scheduledTasks: boolean;
}

export function inspectQuit(sessions: readonly QuitInspectionSession[], globalRunningJobs = 0): QuitInspection {
	let activeTasks = globalRunningJobs > 0;
	let scheduledTasks = false;
	for (const session of sessions) {
		if (session.busy === true) activeTasks = true;
		if ((session.queuedMessages ?? 0) > 0) activeTasks = true;
		if ((session.runningJobs ?? 0) > 0) activeTasks = true;
		if ((session.armedSchedules ?? 0) > 0) scheduledTasks = true;
	}
	return { activeTasks, scheduledTasks };
}
