import { describe, expect, it } from "bun:test";
import { UPDATE_ADMISSION_ERROR_CODE, UpdateAdmissionLock } from "@musepi/pi-coding-agent/daemon/update-admission";

/**
 * The lock is the only thing standing between an idle check and a new turn
 * starting while the process is handed to the installer.
 */
describe("UpdateAdmissionLock", () => {
	it("admits work until engaged", () => {
		const lock = new UpdateAdmissionLock();
		expect(() => lock.assertAdmitted()).not.toThrow();
		expect(lock.engage()).toBe(true);
		expect(lock.engaged).toBe(true);
		expect(() => lock.assertAdmitted()).toThrow(UPDATE_ADMISSION_ERROR_CODE);
	});

	it("keeps the first engagement instant", () => {
		const lock = new UpdateAdmissionLock();
		lock.engage();
		const first = lock.engagedAt;
		expect(lock.engage()).toBe(false);
		expect(lock.engagedAt).toBe(first);
	});

	it("releases a failed handoff", () => {
		const lock = new UpdateAdmissionLock();
		lock.engage();
		expect(lock.release()).toBe(true);
		expect(lock.engaged).toBe(false);
		expect(() => lock.assertAdmitted()).not.toThrow();
		expect(lock.release()).toBe(false);
	});

	it("reports the refusal as retryable", () => {
		const lock = new UpdateAdmissionLock();
		lock.engage();
		expect(() => lock.assertAdmitted()).toThrow(/retry/);
	});
});
