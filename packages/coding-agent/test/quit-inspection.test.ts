import { describe, expect, test } from "bun:test";
import { inspectQuit } from "@musepi/pi-coding-agent/daemon/quit-inspection";

describe("quit inspection", () => {
	test("idle daemon interrupts nothing", () => {
		expect(inspectQuit([], 0)).toEqual({ activeTasks: false, scheduledTasks: false });
	});

	test("a busy, queued, or job-running session is active work", () => {
		expect(inspectQuit([{ busy: true }]).activeTasks).toBe(true);
		expect(inspectQuit([{ queuedMessages: 1 }]).activeTasks).toBe(true);
		expect(inspectQuit([{ runningJobs: 1 }]).activeTasks).toBe(true);
		expect(inspectQuit([], 1).activeTasks).toBe(true);
	});

	test("armed reminders are reported separately from active work", () => {
		expect(inspectQuit([{ armedSchedules: 1 }])).toEqual({ activeTasks: false, scheduledTasks: true });
		expect(inspectQuit([{ busy: true, armedSchedules: 1 }])).toEqual({
			activeTasks: true,
			scheduledTasks: true,
		});
	});
});
