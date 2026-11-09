#!/usr/bin/env bun
/**
 * `bun run desktop:dev` — Vite dev server (HMR renderer) + Electron pointed
 * at it via MUSEPI_GUI_DEV=1. Ctrl-C / Electron exit tears both down.
 * Extra args are forwarded to Electron (e.g. --remote-debugging-port=9222).
 *
 * Two stale-process traps this script now guards against (both reproduced
 * live on Windows, see .workbuddy handoff 2026-09-15):
 *
 * 1. A leftover repo Electron hits main.cjs's requestSingleInstanceLock:
 *    the new process quits and the OLD (frozen) window is focused, reading
 *    as "dev started but is stuck". Spawn therefore happens only after the
 *    repo-scoped stale-instance sweep (same matcher as relaunch-gui.mjs).
 * 2. A leftover vite from a previous run holds :5173. `vite --strictPort`
 *    exits, but the old port-open probe treated ANY listener as success and
 *    spawned Electron against the STALE dev server — fixes never loaded.
 *    The probe now waits for the previous run's vite to exit and reaps it by
 *    PID when a killed run left it behind; only this repo's vite is ever
 *    reaped, so a foreign occupant stays a hard error.
 *
 * Dev data isolation (dsh-desktop parity, 2026-09-15): the dev GUI runs with
 * its OWN daemon data root (PI_CONFIG_DIR), daemon socket dir
 * (MUSEPI_DAEMON_DIR) and Electron userData (MUSEPI_GUI_USER_DATA), all under
 * .desktop-build/development/ — so it never reuses the user's running daemon
 * via the shared tmpdir ws.port discovery and never reads/writes their real
 * sessions/settings. An explicit PI_CONFIG_DIR etc. from the caller wins;
 * MUSEPI_GUI_DEV_SHARED_DATA=1 opts out entirely.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { requestGracefulQuit, waitForPidsExit } from "./graceful-quit.mjs";
import { repoElectronPids } from "./repo-electron.mjs";

const VITE_PORT = 5173;
const argv = process.argv.slice(2);

function portOpen(port) {
	return new Promise((res) => {
		const s = net.connect(port, "127.0.0.1");
		s.on("connect", () => { s.destroy(); res(true); });
		s.on("error", () => res(false));
	});
}
async function waitPort(port, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await portOpen(port)) return true;
		await new Promise((r) => setTimeout(r, 200));
	}
	return false;
}

async function waitPortClosed(port, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!(await portOpen(port))) return true;
		await new Promise((r) => setTimeout(r, 200));
	}
	return false;
}

/** PID and command line of the process listening on `port`. */
function portListener(port) {
	if (process.platform === "win32") {
		const script =
			"$c = Get-NetTCPConnection -LocalPort " +
			port +
			' -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -gt 0 } | Select-Object -First 1; if ($c) { $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"; if ($p) { "$($p.ProcessId)`t$($p.CommandLine)" } }';
		// lsof/PowerShell exit non-zero when nothing listens; read stdout anyway.
		const out = spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" }).stdout ?? "";
		const [pidStr, ...rest] = out.trim().split("\t");
		const pid = Number.parseInt(pidStr ?? "", 10);
		if (!Number.isFinite(pid)) return undefined;
		return { pid, command: rest.join("\t") };
	}
	const pidStr = spawnSync("lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout ?? "";
	const pid = Number.parseInt(pidStr.trim().split("\n")[0] ?? "", 10);
	if (!Number.isFinite(pid)) return undefined;
	const command = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).stdout ?? "";
	return { pid, command };
}

const REPO_VITE_ENTRY = path
	.join(path.resolve(import.meta.dir, ".."), "node_modules", "vite", "bin", "vite.js")
	.replace(/\\/g, "/")
	.toLowerCase();

/** A run that was killed outright leaves its vite behind and `--strictPort`
 *  then blocks the next start. Reap it only when the listener is THIS repo's
 *  vite; any other occupant keeps the loud failure below. */
async function reapStaleVite() {
	const listener = portListener(VITE_PORT);
	if (!listener || !listener.command.replace(/\\/g, "/").toLowerCase().includes(REPO_VITE_ENTRY)) return false;
	console.log(`dev-desktop: stopping leftover vite (pid ${listener.pid}) from a previous run…`);
	try {
		process.kill(listener.pid, "SIGKILL");
	} catch {
		return false;
	}
	return waitPortClosed(VITE_PORT, 8000);
}

// Match only Electron binaries inside this repo so unrelated apps (Kimi,
// etc.) are never touched — shared with relaunch-gui.mjs.

/** Stop stale repo Electron instances (single-instance lock would otherwise
 *  make the new process quit and refocus the frozen old window). Graceful
 *  first: the quit-request helper lets the running instance tear its daemon
 *  down through the normal quit path (Windows SIGTERM is an uncatchable
 *  TerminateProcess, so a signal alone orphaned the daemon on every dev
 *  relaunch); force-kill remains the fallback for stragglers. */
async function sweepStaleElectron() {
	let targets = [];
	try {
		targets = repoElectronPids();
	} catch (err) {
		console.warn("dev-desktop: could not enumerate electron processes:", err instanceof Error ? err.message : err);
		return;
	}
	if (targets.length === 0) return;
	console.log(`dev-desktop: asking running GUI instance(s) ${targets.join(", ")} to quit…`);
	requestGracefulQuit();
	await waitForPidsExit(targets, repoElectronPids, 9000);
	// Fall through to the force ladder for whatever ignored the request.
	targets = repoElectronPids();
	if (targets.length === 0) return;
	console.log(`dev-desktop: force-stopping stale Electron instance(s) ${targets.join(", ")}…`);
	for (const pid of targets) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// already gone
		}
	}
	await waitForPidsExit(targets, repoElectronPids, 4000);
	const still = repoElectronPids();
	for (const pid of still) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
	await waitForPidsExit(still, repoElectronPids, 2000);
}

// `electron .` (directory app path) fails on this Windows setup
// ("Unable to find Electron app") — pass the main entry file directly;
// main.cjs resolves its own __dirname for relative requires either way.
const ELECTRON_MAIN = "electron/main.cjs";
const electronBin =
	process.platform === "win32"
		? "node_modules/electron/dist/electron.exe"
		: "node_modules/.bin/electron";

await sweepStaleElectron();

// A pre-existing :5173 listener must fail the run LOUDLY, except for this
// repo's own leftover vite: the previous run's vite exits a few seconds after
// its Electron is swept, and a hard-killed run leaves it behind entirely.
if (await portOpen(VITE_PORT)) await waitPortClosed(VITE_PORT, 10_000);
if (await portOpen(VITE_PORT)) await reapStaleVite();
if (await portOpen(VITE_PORT)) {
	console.error(
		`dev-desktop: port ${VITE_PORT} is already in use by another process.\n` +
			"Find and stop it first (its owner is shown by: netstat -ano | findstr " +
			`":${VITE_PORT}" then tasklist /fi "PID eq <pid>").\n` +
			"Refusing to spawn Electron against an unknown dev server.",
	);
	process.exit(1);
}

const vite = spawn("node_modules/.bin/vite", ["--port", String(VITE_PORT), "--strictPort"], { stdio: "inherit" });
const ok = await waitPort(VITE_PORT, 15000);
if (!ok) {
	console.error("vite did not start on", VITE_PORT);
	vite.kill();
	process.exit(1);
}

// Dev data isolation: see the header note. Caller-provided values win; the
// whole block is skippable with MUSEPI_GUI_DEV_SHARED_DATA=1.
const repoRoot = path.resolve(import.meta.dirname, "../..");
const devDirs = {
	home: path.join(repoRoot, ".desktop-build", "development", "home"),
	userData: path.join(repoRoot, ".desktop-build", "development", "electron-user-data"),
	socket: path.join(repoRoot, ".desktop-build", "development", "daemon-socket"),
};
const devDataEnv =
	process.env.MUSEPI_GUI_DEV_SHARED_DATA === "1"
		? {}
		: {
				...(process.env.PI_CONFIG_DIR ? {} : { PI_CONFIG_DIR: devDirs.home }),
				...(process.env.MUSEPI_GUI_USER_DATA ? {} : { MUSEPI_GUI_USER_DATA: devDirs.userData }),
				...(process.env.MUSEPI_DAEMON_DIR ? {} : { MUSEPI_DAEMON_DIR: devDirs.socket }),
			};
for (const dir of Object.values(devDirs)) fs.mkdirSync(dir, { recursive: true });

const electron = spawn(electronBin, [ELECTRON_MAIN, ...argv], {
	stdio: "inherit",
	env: { ...process.env, MUSEPI_GUI_DEV: "1", ...devDataEnv },
});
electron.on("exit", () => {
	vite.kill();
	process.exit(0);
});
