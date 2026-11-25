import { describe, expect, it } from "bun:test";
import { summarizeUpdateTasks } from "@musepi/pi-coding-agent/daemon/update-tasks";

/**
 * The update handoff and the quit dialog share this summary, so a wrong count
 * either restarts over running work or blocks an idle app forever.
 */
describe("summarizeUpdateTasks", () => {
	it("reports idle when nothing is running", () => {
		expect(summarizeUpdateTasks([], 0)).toEqual({
			activeSessions: 0,
			queuedMessages: 0,
			runningJobs: 0,
			pendingApprovals: 0,
			armedSchedules: 0,
			activeTasks: false,
			scheduledTasks: false,
		});
	});

	it("counts each unit of work separately", () => {
		const summary = summarizeUpdateTasks(
			[
				{ busy: true, queuedMessages: 2, runningJobs: 1, pendingApprovals: 1 },
				{ busy: false, armedSchedules: 1 },
			],
			3,
		);
		expect(summary).toMatchObject({
			activeSessions: 1,
			queuedMessages: 2,
			runningJobs: 4,
			pendingApprovals: 1,
			armedSchedules: 1,
			activeTasks: true,
			scheduledTasks: true,
		});
	});

	it("treats queued messages alone as active work", () => {
		expect(summarizeUpdateTasks([{ queuedMessages: 1 }]).activeTasks).toBe(true);
	});

	it("treats an approval waiting on the user as active work", () => {
		expect(summarizeUpdateTasks([{ pendingApprovals: 1 }]).activeTasks).toBe(true);
	});

	it("keeps armed reminders out of activeTasks", () => {
		expect(summarizeUpdateTasks([{ armedSchedules: 2 }])).toMatchObject({
			activeTasks: false,
			scheduledTasks: true,
		});
	});

	it("clamps malformed counts instead of trusting them", () => {
		expect(
			summarizeUpdateTasks([{ queuedMessages: -1, runningJobs: Number.NaN }], Number.POSITIVE_INFINITY),
		).toMatchObject({ queuedMessages: 0, runningJobs: 0, activeTasks: false });
	});
});
