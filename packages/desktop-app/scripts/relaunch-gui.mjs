#!/usr/bin/env bun
/**
 * Kill any already-running MusePi Electron instance before `desktop` spawns a
 * fresh one. The dist bundle is rebuilt by `desktop` (rm -rf dist), but an
 * old window process keeps serving the previous bundle forever — with no
 * single-instance lock, `electron .` just stacks another window on top and
 * the stale one stays visible. Match only Electron binaries inside this repo
 * so unrelated apps (Kimi, etc.) are never touched.
 */
import { requestGracefulQuit, waitForPidsExit } from "./graceful-quit.mjs";
import { repoElectronPids } from "./repo-electron.mjs";

async function waitExit(pids, timeoutMs = 4000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const alive = pids.filter((pid) => repoElectronPids().includes(pid));
		if (alive.length === 0) return;
		await new Promise((r) => setTimeout(r, 150));
	}
}

const targets = repoElectronPids();
if (targets.length > 0) {
	console.log(`relaunch: asking running GUI instance(s) ${targets.join(", ")} to quit…`);
	// Graceful first: the helper routes through the single-instance lock so
	// the running instance executes its normal quit path (daemon teardown
	// included). Generous window: the owned-daemon shutdown ladder can take
	// a few seconds; stragglers (or instances predating the handler) fall
	// through to the force-kill sweep below.
	requestGracefulQuit();
	await waitForPidsExit(targets, repoElectronPids, 9000);
}
const remaining = repoElectronPids();
if (remaining.length > 0) {
	console.log(`relaunch: stopping stale GUI instance(s) ${remaining.join(", ")}…`);
	for (const pid of remaining) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// already gone
		}
	}
	await waitExit(remaining);
	const still = repoElectronPids();
	for (const pid of still) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
	await waitExit(still, 2000);
	console.log("relaunch: stale instance(s) stopped.");
}
