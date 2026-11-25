/**
 * Quit inspection (dsh's `quit-inspection`).
 *
 * dsh asks the Host at quit time whether stopping it would interrupt work and
 * whether armed reminders would be lost, then chooses the confirmation copy.
 * The counting itself lives in `update-tasks.ts` so the update handoff and the
 * quit dialog can never disagree about what "active" means.
 */
import { summarizeUpdateTasks, type UpdateTaskSession } from "./update-tasks";

export type QuitInspectionSession = UpdateTaskSession;

export interface QuitInspection {
	/** Stopping now interrupts running work or drops queued messages. */
	activeTasks: boolean;
	/** A loaded session holds an armed reminder that would never fire. */
	scheduledTasks: boolean;
}

export function inspectQuit(sessions: readonly QuitInspectionSession[], globalRunningJobs = 0): QuitInspection {
	const { activeTasks, scheduledTasks } = summarizeUpdateTasks(sessions, globalRunningJobs);
	return { activeTasks, scheduledTasks };
}
