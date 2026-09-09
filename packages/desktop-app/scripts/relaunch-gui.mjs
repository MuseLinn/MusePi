#!/usr/bin/env bun
/**
 * Kill any already-running MusePi Electron instance before `desktop` spawns a
 * fresh one. The dist bundle is rebuilt by `desktop` (rm -rf dist), but an
 * old window process keeps serving the previous bundle forever — with no
 * single-instance lock, `electron .` just stacks another window on top and
 * the stale one stays visible. Match only Electron binaries inside this repo
 * so unrelated apps (Kimi, etc.) are never touched.
 */
import { execFileSync, spawn } from "node:child_process";

// Match only Electron binaries inside this repo so unrelated apps (Kimi,
// etc.) are never touched. Per-platform layout: macOS runs from the .app
// bundle, Windows/Linux from dist/electron(.exe).
const REPO_ELECTRON =
	/harness-engineering[\\/]musepi-omp[\\/]node_modules[\\/]\.bun[\\/]electron@[^\\/]+[\\/]node_modules[\\/]electron[\\/]dist[\\/](?:Electron\.app\/Contents\/MacOS\/Electron|electron(?:\.exe)?)/;

function runningPids() {
	const pids = [];
	if (process.platform === "win32") {
		// tasklist has no command line; PowerShell CIM is the supported
		// route. Lines: "<pid>\t<executable path>".
		const out = execFileSync(
			"powershell",
			[
				"-NoProfile",
				"-Command",
				"Get-CimInstance Win32_Process -Filter \"Name='electron.exe'\" | Where-Object { $_.ExecutablePath } | ForEach-Object { \"$($_.ProcessId)`t$($_.ExecutablePath)\" }",
			],
			{ encoding: "utf8" },
		);
		for (const line of out.split(/\r?\n/)) {
			const [pidStr, ...rest] = line.split("\t");
			if (rest.length === 0 || !REPO_ELECTRON.test(rest.join("\t"))) continue;
			const pid = Number.parseInt(pidStr, 10);
			if (Number.isFinite(pid)) pids.push(pid);
		}
		return pids;
	}
	const out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
	for (const line of out.split("\n")) {
		if (!REPO_ELECTRON.test(line)) continue;
		const pid = Number.parseInt(line.trim().split(/\s+/)[0], 10);
		if (Number.isFinite(pid)) pids.push(pid);
	}
	return pids;
}

async function waitExit(pids, timeoutMs = 4000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const alive = pids.filter((pid) => runningPids().includes(pid));
		if (alive.length === 0) return;
		await new Promise((r) => setTimeout(r, 150));
	}
}

const targets = runningPids();
if (targets.length > 0) {
	console.log(`relaunch: stopping stale GUI instance(s) ${targets.join(", ")}…`);
	for (const pid of targets) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// already gone
		}
	}
	await waitExit(targets);
	const still = runningPids();
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
