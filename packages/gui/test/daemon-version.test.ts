import { expect, test } from "bun:test";
import { shouldRestartDaemon } from "../src/lib/daemon-version";

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
