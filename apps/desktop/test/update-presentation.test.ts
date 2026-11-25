import { describe, expect, it } from "bun:test";
import type { UpdateRestartProgress } from "../src/lib/electron";
import { restartHint } from "../src/lib/update-presentation";

/**
 * Banner copy for the idle handoff: the main process ships ids/counts, the
 * renderer picks the wording. A blocked reason must never render as "waiting",
 * or the user keeps waiting for a restart that will not happen.
 */
function progress(overrides: Partial<UpdateRestartProgress> = {}): UpdateRestartProgress {
	return { auto: true, status: "waiting", inFlight: 0, scheduled: 0, blockers: [], ...overrides };
}

describe("restartHint", () => {
	it("shows nothing while no handoff is armed", () => {
		expect(restartHint(undefined)).toBeNull();
		expect(restartHint(progress({ status: "idle", auto: false }))).toBeNull();
	});

	it("counts the requests still running", () => {
		expect(restartHint(progress({ inFlight: 2, blockers: ["active-sessions"] }))).toEqual({
			key: "update.restartWaitingWithCount",
			params: { count: "2" },
		});
	});

	it("announces the handoff once work has settled", () => {
		expect(restartHint(progress())).toEqual({ key: "update.restartImminent" });
	});

	it("names the armed reminders that pause the automatic restart", () => {
		expect(restartHint(progress({ scheduled: 3, blockers: ["scheduled-reminders"] }))).toEqual({
			key: "update.restartBlockedScheduled",
			params: { count: "3" },
		});
	});

	it("keeps a generic line for queued work without a running turn", () => {
		expect(restartHint(progress({ blockers: ["queued-messages"] }))).toEqual({ key: "update.restartWaiting" });
	});

	it("says when the daemon cannot be read yet", () => {
		expect(restartHint(progress({ blockers: ["unknown"] }))).toEqual({
			key: "update.restartWaitingUnavailable",
		});
	});

	it("does not promise a restart after a blocked handoff", () => {
		expect(restartHint(progress({ status: "blocked", blockers: ["tasks-unavailable"] }))).toEqual({
			key: "update.restartBlockedUnavailable",
		});
		expect(restartHint(progress({ status: "blocked", blockers: ["tasks-changed"] }))).toEqual({
			key: "update.restartBlockedBusy",
		});
		expect(restartHint(progress({ status: "blocked", blockers: ["stop-failed"] }))).toEqual({
			key: "update.restartBlockedFailed",
		});
	});

	it("marks the install grace window", () => {
		expect(restartHint(progress({ status: "installing" }))).toEqual({ key: "update.installingUpdate" });
	});

	it("stays quiet for a manual install with nothing to announce", () => {
		expect(restartHint(progress({ auto: false }))).toBeNull();
	});
});
