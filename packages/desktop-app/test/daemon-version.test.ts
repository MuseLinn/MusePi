import { expect, test } from "bun:test";
import {
	missingDaemonMethods,
	REQUIRED_DAEMON_METHODS,
	shouldRestartDaemon,
	shouldRestartForMissingMethods,
} from "../src/lib/daemon-version";

test("restarts when the daemon was spawned by an older GUI (musepiVersion set, stale)", () => {
	expect(shouldRestartDaemon({ version: "0.4.18", musepiVersion: "0.4.18" }, "0.4.19")).toBe(true);
});

test("does not restart when the daemon matches the GUI (GUI-spawned, current)", () => {
	expect(shouldRestartDaemon({ version: "0.4.19", musepiVersion: "0.4.19" }, "0.4.19")).toBe(false);
});

test("restarts a CLI/self-started daemon with no MUSEPI_VERSION whose binary version is stale", () => {
	// musepiVersion:null → falls back to version; 0.4.18 binary ≠ 0.4.19 GUI.
	expect(shouldRestartDaemon({ version: "0.4.18", musepiVersion: null }, "0.4.19")).toBe(true);
});

test("does not restart a current CLI/self-started daemon that reports the same version", () => {
	expect(shouldRestartDaemon({ version: "0.4.19", musepiVersion: null }, "0.4.19")).toBe(false);
});

test("skips the gate when meta is unavailable or app version is unknown", () => {
	expect(shouldRestartDaemon(null, "0.4.19")).toBe(false);
	expect(shouldRestartDaemon({ version: "0.4.18", musepiVersion: null }, null)).toBe(false);
	expect(shouldRestartDaemon(null, null)).toBe(false);
});

// ── Capability probe: the same-version stale daemon (dev / worktree case) ──
// Version equality is not proof of currency: code advances while
// package.json stays put, so a daemon from before a feature landed reports
// the SAME version as the fresh GUI. Only a capability probe catches it.

test("reports missing methods when the daemon predates them at an identical version", () => {
	// Exactly the observed failure: daemon and GUI both say 0.4.33, yet the
	// daemon has no skills.marketplace.* — version check alone misses it.
	expect(shouldRestartDaemon({ version: "0.4.33", musepiVersion: "0.4.33" }, "0.4.33")).toBe(false);
	const answered = ["skills.list", "marketplace.list", "plugins.packages"];
	expect(missingDaemonMethods(answered)).toEqual([...REQUIRED_DAEMON_METHODS]);
	expect(shouldRestartForMissingMethods(answered)).toBe(true);
});

test("reports nothing missing once every required method answers", () => {
	expect(missingDaemonMethods(REQUIRED_DAEMON_METHODS)).toEqual([]);
	expect(shouldRestartForMissingMethods([...REQUIRED_DAEMON_METHODS, "skills.list"])).toBe(false);
});

test("reports only the methods that are actually absent", () => {
	expect(missingDaemonMethods(["skills.marketplace.query"])).toEqual(
		REQUIRED_DAEMON_METHODS.filter(m => m !== "skills.marketplace.query"),
	);
});

test("treats an empty answered set as a fully stale daemon", () => {
	expect(shouldRestartForMissingMethods([])).toBe(true);
});
