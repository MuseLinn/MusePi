/**
 * Electron shell daemon lifecycle — ported 1:1 from the removed Tauri shell
 * (src-tauri/src/lib.rs) so the GUI keeps the same probe/spawn semantics:
 *
 * - `probe()`: read the daemon's ws.port file (written next to daemon.sock on
 *   startup) and return the port, or null.
 * - `start(port)`: resolve the `musepi serve` launch command (PATH binary
 *   first, repo checkout fallback), spawn it detached, then poll until the
 *   port actually accepts TCP connections (file + connect check approximates
 *   a ready message). Rejects on spawn failure or 10s timeout.
 *
 * Pure Node — no electron import — so it is unit-testable standalone.
 */
"use strict";

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SOCKET_DIR = path.join(os.tmpdir(), "musepi-daemon");
const PORT_FILE = path.join(SOCKET_DIR, "ws.port");
const STARTUP_TIMEOUT_MS = 10_000;

/** GUI package version (brand version for the spawned daemon). */
function guiVersion() {
	try {
		return require("../package.json").version ?? "";
	} catch {
		return "";
	}
}

/** Discover a running daemon's WebSocket port from the ws.port file. */
function probe() {
	try {
		const port = Number.parseInt(fs.readFileSync(PORT_FILE, "utf8").trim(), 10);
		return Number.isInteger(port) && port > 0 ? port : null;
	} catch {
		return null;
	}
}

/** True if `127.0.0.1:port` accepts TCP connections. */
function portOpen(port) {
	return new Promise(resolve => {
		const sock = net.connect({ host: "127.0.0.1", port });
		const done = ok => {
			sock.removeAllListeners();
			sock.destroy();
			resolve(ok);
		};
		sock.once("connect", () => done(true));
		sock.once("error", () => done(false));
		sock.setTimeout(500, () => done(false));
	});
}

/**
 * Resolve the `musepi serve` launch command. Prefers the `musepi` binary on
 * PATH (installed builds); then the daemon binary shipped with the packaged
 * app (vendor/daemon, unpacked beside app.asar); falls back to the repo
 * checkout under development (`bun packages/coding-agent/src/cli.ts serve`)
 * by walking up from this file's location.
 */
function daemonCommand(port) {
	const win = process.platform === "win32";
	const inPath = (process.env.PATH ?? "")
		.split(win ? ";" : ":")
		.some(dir => fs.existsSync(path.join(dir, win ? "musepi.exe" : "musepi")));
	if (inPath) {
		return {
			program: "musepi",
			args: ["serve", "--port", String(port)],
		};
	}
	// Packaged app: the compiled daemon binary is asarUnpacked so it can be
	// spawned directly (asar contents are not executable).
	const unpacked = path.join(
		process.resourcesPath ?? "",
		"app.asar.unpacked",
		"vendor",
		"daemon",
		win ? "musepi.exe" : "musepi",
	);
	if (fs.existsSync(unpacked)) {
		return { program: unpacked, args: ["serve", "--port", String(port)] };
	}
	// Dev checkout: electron/ sits at <repo>/packages/gui/electron/.
	let dir = path.resolve(__dirname);
	while (true) {
		const cli = path.join(dir, "packages", "coding-agent", "src", "cli.ts");
		if (fs.existsSync(cli)) {
			return { program: "bun", args: [cli, "serve", "--port", String(port)] };
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error("neither `musepi` nor the repo checkout is available");
}

/**
 * Launch `musepi serve --port <port>` detached and wait for the listener.
 * Resolves the bound port (matches the requested one) or rejects.
 */
async function start(port, env = {}) {
	const { program, args } = daemonCommand(port);
	console.error("[daemon] start", program, args.join(" "));
	const child = spawn(program, args, {
		detached: true,
		stdio: "ignore",
		// Brand the spawned daemon with the GUI's own version: the daemon
		// runs from src/cli.ts (not musepi.ts), so without this system.meta
		// reports the OMP engine version as the MusePi version.
		env: { ...process.env, MUSEPI_VERSION: guiVersion(), ...env },
	});
	child.unref();

	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const bound = probe();
		// Only accept OUR port — a stale ws.port from another daemon must not
		// satisfy the wait (the spawned process writes its own --port).
		if (bound === port && (await portOpen(bound))) {
			console.error("[daemon] bound on :" + bound);
			return bound;
		}
		// The spawned process died during startup.
		if (child.exitCode !== null || child.signalCode !== null) {
			console.error("[daemon] child exited", child.exitCode, child.signalCode);
			throw new Error("daemon exited during startup");
		}
		await new Promise(r => setTimeout(r, 100));
	}
	throw new Error("timed out waiting for daemon to bind");
}

/** Resolve the pid of the process listening on 127.0.0.1:port (lsof).
 *  NOTE: `-iTCP:<port>` must stay ONE argument — splitting it makes lsof
 *  treat the port as a file name and fail. */
function listenerPid(port) {
	return new Promise(resolve => {
		const lsof = spawn("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		let out = "";
		lsof.stdout.on("data", chunk => {
			out += chunk;
		});
		lsof.on("error", () => resolve(null));
		lsof.on("close", () => {
			const pid = Number.parseInt(out.trim().split("\n")[0] ?? "", 10);
			resolve(Number.isInteger(pid) && pid > 0 ? pid : null);
		});
	});
}

/**
 * Stop the daemon listening on `port`: SIGTERM the listener, wait for the
 * port to free. Resolves once the port is closed (or immediately if no
 * listener was found).
 */
async function kill(port) {
	const pid = await listenerPid(port);
	if (pid !== null) {
		console.error("[daemon] kill", pid, "on :" + port);
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// already gone — proceed
		}
		// Grace window for a clean SIGTERM shutdown (a turn or a hung call
		// can hold the process briefly). Short on purpose — the restart is
		// an explicit user action; a 5s+3s wait reads as a frozen GUI.
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline) {
			if (!(await portOpen(port))) return;
			await new Promise(r => setTimeout(r, 100));
		}
		// SIGTERM was ignored (stuck daemon): escalate to SIGKILL so the
		// restart really replaces the listener. Without this, start() would
		// spawn a fresh daemon, watch it bind a FALLBACK port (the old one
		// still holds ours) and report success while the old process keeps
		// serving — a restart that visibly does nothing.
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
		console.error("[daemon] SIGKILL", pid);
		const killDeadline = Date.now() + 2000;
		while (Date.now() < killDeadline) {
			if (!(await portOpen(port))) return;
			await new Promise(r => setTimeout(r, 100));
		}
		throw new Error(`daemon on :${port} did not exit after SIGTERM + SIGKILL`);
	}
}

/**
 * Restart the daemon (instance menu 重启 daemon): SIGTERM the current
 * listener on `port`, wait for the port to free, then spawn a fresh
 * daemon (new code) and wait for it to bind. Resolves the new port.
 * The daemon is detached from the GUI, so a GUI relaunch alone never
 * refreshes it — this is the explicit refresh path (openchamber
 * /api/config/reload analog for process-level changes).
 */
async function restart(port, env = {}) {
	await kill(port);
	return start(port, env);
}

module.exports = { probe, start, restart, kill, portOpen, daemonCommand, SOCKET_DIR, PORT_FILE };
