#!/usr/bin/env bun
/**
 * Graceful GUI shutdown for the dev relaunch scripts (relaunch-gui.mjs,
 * dev-desktop.mjs).
 *
 * Why a helper process instead of a signal: on Windows, Node maps SIGTERM
 * to TerminateProcess, which a GUI process cannot catch — before-quit never
 * fires there, and with it the owned-daemon teardown (killOwnedDaemon), so
 * every dev relaunch used to orphan the daemon. The helper instead spawns
 * the shell's own main entry with `--quit-request`: the single-instance
 * lock routes the attempt to the RUNNING instance, whose `second-instance`
 * handler sees the flag and runs the normal quit path (daemon teardown
 * included, active-session guard skipped — a programmatic relaunch is an
 * explicit restart intent). When no instance is running, the helper
 * acquires the lock, sees the flag itself, and exits before any window
 * exists.
 *
 * Callers still keep their force-kill fallback: instances predating the
 * `second-instance` handler (or a wedged quit) are SIGTERM/SIGKILLed after
 * the grace window, exactly as before.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const pkgDir = resolve(import.meta.dirname, "..");

/** Resolve the Electron binary the way the launchers do (desktop-run.mjs). */
function electronBinary() {
	try {
		const require = createRequire(join(pkgDir, "package.json"));
		const resolved = require("electron");
		if (typeof resolved === "string" && existsSync(resolved)) return resolved;
	} catch {
		// fall through to the .bin shim
	}
	const shim = join(pkgDir, "node_modules", ".bin", process.platform === "win32" ? "electron.exe" : "electron");
	return existsSync(shim) ? shim : null;
}

/** Ask the running GUI instance (if any) to quit gracefully. Fire-and-forget. */
export function requestGracefulQuit() {
	const bin = electronBinary();
	if (!bin) return; // no shell to ask — callers' force fallback covers it
	const helper = spawn(bin, [join(pkgDir, "electron", "main.cjs"), "--quit-request"], {
		stdio: "ignore",
		windowsHide: true,
	});
	helper.unref?.();
}

/** Poll `listPids()` until none of `pids` remain (or the deadline). */
export async function waitForPidsExit(pids, listPids, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const alive = pids.filter(pid => listPids().includes(pid));
		if (alive.length === 0) return;
		await new Promise(r => setTimeout(r, 150));
	}
}
