/**
 * Restart handoff for a downloaded update (dsh `beforeRestart` parity).
 *
 * The updater owns the visible state machine; this module owns the one
 * irreversible step: inspect live work, lock daemon admission, stop the owned
 * daemon and hand the process to the installer. Dependencies are injected so
 * the shell supplies the real daemon RPC/kill and a test supplies fakes.
 *
 * Ordering matters. The lock is engaged only after the idle check, and the
 * post-lock summary is compared with the pre-lock one: work that appeared in
 * between is a reason to keep working, never a reason to interrupt it. A
 * handoff that fails releases the lock so the daemon returns to normal.
 */
"use strict";

const { updateInFlightCount, updateRestartBlockers } = require("./update-logic.cjs");

/** Stable failure reasons the renderer maps to localized copy. */
const RESTART_FAILURE_REASONS = ["busy", "tasks-unavailable", "tasks-changed", "stop-failed", "handoff-failed"];

/**
 * @param {object} deps
 * @param {(method: string, params?: object) => void} [deps.log]
 * @param {() => Promise<object|"unknown"|null>} deps.inspectTasks
 *   Daemon summary, `"unknown"` when a daemon exists but did not answer, or
 *   null when no daemon is running.
 * @param {(mode: "lock") => Promise<object|null>} deps.lockTasks
 *   Post-lock summary; null when the daemon did not answer.
 * @param {() => Promise<unknown>} deps.unlockTasks
 * @param {() => Promise<boolean|void>} deps.stopDaemon
 * @param {() => Promise<unknown>} deps.handoff Installer handoff (quit + install).
 */
function createRestartHandoff({ log = () => {}, inspectTasks, lockTasks, unlockTasks, stopDaemon, handoff }) {
	/** Single-flight: a manual click must never race the idle watchdog. */
	let pending = null;

	const unlock = async () => {
		try {
			await unlockTasks();
		} catch (error) {
			log("restart: admission unlock failed:", error?.message ?? error);
		}
	};

	const inspect = async () => {
		try {
			const summary = await inspectTasks();
			return summary ?? null;
		} catch (error) {
			log("restart: inspect failed:", error?.message ?? error);
			return "unknown";
		}
	};

	const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });

	async function run({ auto }) {
		const before = await inspect();
		// `null` means no daemon is running: nothing to inspect or interrupt.
		if (auto && before !== null) {
			const beforeBlockers = updateRestartBlockers(before);
			if (beforeBlockers.length > 0) {
				return fail(beforeBlockers[0] === "unknown" ? "tasks-unavailable" : "busy", {
					blockers: beforeBlockers,
					inFlight: updateInFlightCount(before) ?? undefined,
				});
			}
		}
		// No daemon at all: there is nothing to lock and nothing to interrupt.
		if (before !== null) {
			let locked = null;
			try {
				locked = await lockTasks();
			} catch (error) {
				log("restart: admission lock failed:", error?.message ?? error);
			}
			if (locked === null || typeof locked !== "object") {
				if (auto) {
					await unlock();
					return fail("tasks-unavailable", { blockers: ["unknown"] });
				}
				// An explicit install must not become impossible just because the
				// daemon is mute; the pre-lock inspection already ran.
				log("restart: admission lock unavailable; continuing on explicit install");
			} else {
				const afterBlockers = updateRestartBlockers(locked);
				if (auto && afterBlockers.length > 0) {
					await unlock();
					return fail("tasks-changed", {
						blockers: afterBlockers,
						inFlight: updateInFlightCount(locked) ?? undefined,
					});
				}
				log("restart: admission locked", auto ? "(auto)" : "(manual)", "inFlight", updateInFlightCount(locked) ?? "?");
			}
		}

		let stopped = false;
		try {
			stopped = (await stopDaemon()) !== false;
		} catch (error) {
			log("restart: daemon stop failed:", error?.message ?? error);
		}
		if (!stopped) {
			await unlock();
			return fail("stop-failed");
		}
		try {
			await handoff();
		} catch (error) {
			log("restart: install handoff failed:", error?.message ?? error);
			return fail("handoff-failed");
		}
		return { ok: true };
	}

	return {
		inspect,
		/** @param {{ auto?: boolean }} [options] */
		install(options = {}) {
			if (pending) return pending;
			pending = run({ auto: options.auto === true })
				.catch(error => fail("handoff-failed", { error: String(error?.message ?? error) }))
				.finally(() => {
					pending = null;
				});
			return pending;
		},
		get busy() {
			return pending !== null;
		},
	};
}

module.exports = { createRestartHandoff, RESTART_FAILURE_REASONS };
