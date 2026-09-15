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
 *    The probe now verifies the listener is OUR vite (it dies with it);
 *    a foreign occupant is a hard error telling the user to free the port.
 *
 * Dev data isolation (dsh-desktop parity, 2026-09-15): the dev GUI runs with
 * its OWN daemon data root (PI_CONFIG_DIR), daemon socket dir
 * (MUSEPI_DAEMON_DIR) and Electron userData (MUSEPI_GUI_USER_DATA), all under
 * .desktop-build/development/ — so it never reuses the user's running daemon
 * via the shared tmpdir ws.port discovery and never reads/writes their real
 * sessions/settings. An explicit PI_CONFIG_DIR etc. from the caller wins;
 * MUSEPI_GUI_DEV_SHARED_DATA=1 opts out entirely.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

// Match only Electron binaries inside this repo so unrelated apps (Kimi,
// etc.) are never touched — the same matcher relaunch-gui.mjs uses.
const REPO_ELECTRON =
	/harness-engineering[\\/]musepi-omp[\\/]node_modules[\\/]\.bun[\\/]electron@[^\\/]+[\\/]node_modules[\\/]electron[\\/]dist[\\/](?:Electron\.app\/Contents\/MacOS\/Electron|electron(?:\.exe)?)/;

function repoElectronPids() {
	const pids = [];
	if (process.platform === "win32") {
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

/** Kill stale repo Electron instances (single-instance lock would otherwise
 *  make the new process quit and refocus the frozen old window). */
function sweepStaleElectron() {
	let targets = [];
	try {
		targets = repoElectronPids();
	} catch (err) {
		console.warn("dev-desktop: could not enumerate electron processes:", err instanceof Error ? err.message : err);
		return;
	}
	if (targets.length === 0) return;
	console.log(`dev-desktop: stopping stale Electron instance(s) ${targets.join(", ")}…`);
	for (const pid of targets) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// already gone
		}
	}
	const deadline = Date.now() + 4000;
	while (Date.now() < deadline) {
		const alive = repoElectronPids().filter((pid) => targets.includes(pid));
		if (alive.length === 0) return;
		for (const pid of alive) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
	}
}

// `electron .` (directory app path) fails on this Windows setup
// ("Unable to find Electron app") — pass the main entry file directly;
// main.cjs resolves its own __dirname for relative requires either way.
const ELECTRON_MAIN = "electron/main.cjs";
const electronBin =
	process.platform === "win32"
		? "node_modules/electron/dist/electron.exe"
		: "node_modules/.bin/electron";

sweepStaleElectron();

// A pre-existing :5173 listener must fail the run LOUDLY. The old probe
// accepted any listener and pointed Electron at a stale dev server.
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
