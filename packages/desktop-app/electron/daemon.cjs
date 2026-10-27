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
const { spawn, spawnSync } = require("node:child_process");

// Socket/port discovery dir. MUSEPI_DAEMON_DIR (dev-desktop data isolation)
// keeps a dev GUI's ws.port discovery away from the user's running daemon —
// the daemon (coding-agent server.ts) honors the same variable when writing.
// `let`, not `const`: `resetSocketDirForTests` repoints them at a private dir
// (see there).
let SOCKET_DIR = process.env.MUSEPI_DAEMON_DIR || path.join(os.tmpdir(), "musepi-daemon");
let PORT_FILE = path.join(SOCKET_DIR, "ws.port");
let WEB_PORT_FILE = path.join(SOCKET_DIR, "web.port");
let CLIENT_PID_FILE = path.join(SOCKET_DIR, "client.pid");
const STARTUP_TIMEOUT_MS = 60_000;
const pendingStarts = new Map();
/**
 * How long the daemon gets to finish a cooperative `system.shutdown` (release
 * sessions, kill PTYs, flush the journal) before the shell escalates to
 * signalling the tree. Long enough for an orderly teardown, short enough that a
 * quit does not read as a frozen window.
 */
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5000;
// Managed-daemon registry: one file per daemon WE spawned, so a later run can
// recognise and reclaim a genuinely orphaned daemon instead of blindly killing
// whatever listens on the port. The two files above answer "where is the daemon
// running NOW"; this directory answers "which daemons did we ever start, and is
// each one still owned by a live shell".
let REGISTRY_DIR = path.join(SOCKET_DIR, "managed");

/**
 * TEST-ONLY seam: repoint the discovery/registry paths at a private directory
 * (null restores the default resolution). Setting MUSEPI_DAEMON_DIR before
 * import cannot isolate a test — the suite runs every test file in ONE
 * process, so the first file to import this module fixes the paths for all
 * later ones. Never called from app code.
 */
function resetSocketDirForTests(dir) {
	SOCKET_DIR = dir ?? process.env.MUSEPI_DAEMON_DIR ?? path.join(os.tmpdir(), "musepi-daemon");
	PORT_FILE = path.join(SOCKET_DIR, "ws.port");
	WEB_PORT_FILE = path.join(SOCKET_DIR, "web.port");
	CLIENT_PID_FILE = path.join(SOCKET_DIR, "client.pid");
	REGISTRY_DIR = path.join(SOCKET_DIR, "managed");
}

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

/** Discover the daemon-served compat renderer origin (web.port file, written
 *  by startDaemon when the desktop-shell extension is enabled). Returns the
 *  loopback URL or null — null = the shell loads its local bundle. */
function probeWeb() {
	try {
		const port = Number.parseInt(fs.readFileSync(WEB_PORT_FILE, "utf8").trim(), 10);
		if (!Number.isInteger(port) || port <= 0) return null;
		return `http://127.0.0.1:${port}/`;
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
/**
 * Desktop-shell state (dsh-desktop compat): the Electron shell serves the
 * runtime-rendered guest-client ONLY when the desktop-shell extension is
 * explicitly enabled (settings shell.enabled === true). Default OFF — the
 * compat path loads guest-client, which is the collab client ("musepi 协作"
 * connect screen), not the full working GUI; users who want the shell
 * wrapper enable it in the extension center. When off, spawn the daemon
 * WITHOUT --web-port so it never binds a random web port / writes
 * web.port — the shell loads its local bundle.
 */
function shellEnabled() {
	const home = os.homedir();
	for (const base of [path.join(home, ".musepi", "agent"), path.join(home, ".musepi")]) {
		try {
			const raw = JSON.parse(fs.readFileSync(path.join(base, "settings.json"), "utf8"));
			const v = raw["shell.enabled"];
			if (v !== undefined) return v === true;
		} catch {
			// missing/unreadable — fall through to the next candidate
		}
	}
	return false;
}

function daemonCommand(port) {
	const win = process.platform === "win32";
	// --web-port only when the desktop-shell extension is enabled (see
	// shellEnabled); 0 = a random loopback port the daemon persists to
	// web.port for the compat shell to discover.
	const webArgs = shellEnabled() ? ["--web-port", "0"] : [];

	// Resolution order: packaged binary → dev checkout → PATH. A stale PATH
	// shim (bunx launcher whose global package was uninstalled) spawns and
	// exits instantly ("Module not found") — the GUI would report "daemon
	// exited during startup", so the checkout the GUI actually runs from
	// and the binary shipped inside the install must both beat PATH.
	const candidates = [];
	candidates.push(
		path.join(
			process.resourcesPath ?? "",
			"app.asar.unpacked",
			"vendor",
			"daemon",
			win ? "musepi.exe" : "musepi",
		),
	);
	let dir = path.resolve(__dirname);
	while (true) {
		const cli = path.join(dir, "packages", "coding-agent", "src", "cli.ts");
		if (fs.existsSync(cli)) {
			candidates.push({ bunCli: cli });
			break;
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	for (const pathDir of (process.env.PATH ?? "").split(win ? ";" : ":")) {
		if (pathDir.trim().length === 0) continue;
		candidates.push(path.resolve(pathDir, win ? "musepi.exe" : "musepi"));
	}

	for (const candidate of candidates) {
		if (typeof candidate === "object") {
			// Dev checkout — the cli.ts existence was already verified in the scan.
			return { program: "bun", args: [candidate.bunCli, "serve", "--port", String(port), ...webArgs] };
		}
		if (candidate.length === 0 || !fs.existsSync(candidate)) continue;
		// A bun package shim on Windows is a tiny launcher .exe paired with a
		// sibling .bunx script; when the global package is gone the shim still
		// exists but exits instantly. The compiled daemon is a fat binary —
		// skip small executables whose .bunx sibling is missing.
		const stat = fs.statSync(candidate);
		if (stat.isFile() && stat.size < 256 * 1024) {
			const bunxScript = candidate.replace(/\.exe$/i, ".bunx");
			if (!fs.existsSync(bunxScript)) continue;
		}
		return { program: candidate, args: ["serve", "--port", String(port), ...webArgs] };
	}
	throw new Error("neither `musepi` nor the repo checkout is available");
}

/**
 * Launch `musepi serve --port <port>` detached and wait for the listener.
 * Resolves the bound port (matches the requested one) or rejects.
 */
async function startInternal(port, env = {}) {
	if (probe() === port && (await portOpen(port))) {
		console.error("[daemon] adopt existing listener on :" + port);
		return port;
	}
	const { program, args } = daemonCommand(port);
	console.error("[daemon] start", program, args.join(" "));
	let daemonStderr = "";
	const child = spawn(program, args, {
		detached: true,
		stdio: ["ignore", "ignore", "pipe"],
		// Windows: without this the spawned daemon opens a visible console
		// window every GUI launch (same fix proma/opencode/kimi apply to
		// every child spawn from Electron main).
		windowsHide: true,
		// Brand the spawned daemon with the GUI's own version: the daemon
		// runs from src/cli.ts (not musepi.ts), so without this system.meta
		// reports the OMP engine version as the MusePi version.
		env: { ...process.env, MUSEPI_VERSION: guiVersion(), ...env },
	});
	child.stderr.on("data", chunk => {
		daemonStderr = `${daemonStderr}${chunk.toString()}`.slice(-4000);
	});
	child.unref();

	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const bound = probe();
		// Only accept OUR port — a stale ws.port from another daemon must not
		// satisfy the wait (the spawned process writes its own --port).
		if (bound === port && (await portOpen(bound))) {
			console.error("[daemon] bound on :" + bound);
			// Shell-disabled: the daemon does not serve guest-client, so a
			// stale web.port from an earlier shell-enabled daemon must not
			// send the GUI to the collab-client renderer next launch.
			if (!shellEnabled()) {
				try {
					fs.unlinkSync(WEB_PORT_FILE);
				} catch {
					// already gone
				}
			}
			// Ownership marker: THIS GUI instance spawned the daemon. Quitting
			// GUIs compare their pid against this file and only the owner
			// tears the daemon down; a crash never runs the quit path, so the
			// detached daemon survives (client.pid goes stale and is
			// reclaimed on the next start()).
			try {
				fs.writeFileSync(CLIENT_PID_FILE, String(process.pid), "utf8");
			} catch {
				// best-effort: worst case the daemon outlives the GUI
			}
			// Registry entry: records the daemon pid + owning shell pid + the
			// launch command, which is what lets a FUTURE run decide "this is
			// ours and its owner is gone" instead of "something listens on
			// 8300, kill it". Written after the listener proves it bound: a
			// process that never became ready is not worth reclaiming.
			registerManagedDaemon({ pid: child.pid, ownerPid: process.pid, port: bound, command: [program, ...args] });
			return bound;
		}
		// A quarantine/stale/arch-mismatched `musepi.exe` shows up here as an
		// instant exit, and "daemon exited during startup" alone left the user
		// with nothing to act on (ARM Windows report: 找不到可执行程序).
		if (child.exitCode !== null || child.signalCode !== null) {
			console.error("[daemon] child exited", child.exitCode, child.signalCode, "program:", program);
			throw new Error(`daemon exited during startup (${program})${daemonStderr.trim() ? `: ${daemonStderr.trim()}` : ""}`);
		}
		await new Promise(r => setTimeout(r, 100));
	}
	throw new Error(`timed out waiting for daemon to bind${daemonStderr.trim() ? `: ${daemonStderr.trim()}` : ""}`);
}

/** Share one startup per daemon directory and port. */
async function start(port, env = {}) {
	const key = `${SOCKET_DIR}\0${port}`;
	const pending = pendingStarts.get(key);
	if (pending) return pending;
	const startup = startInternal(port, env);
	pendingStarts.set(key, startup);
	try {
		return await startup;
	} finally {
		pendingStarts.delete(key);
	}
}

/** Resolve the pid of the process listening on 127.0.0.1:port.
 *  Windows: `netstat -ano` (lsof does not exist there — the old code's
 *  spawn("lsof") errored, so listenerPid always resolved null and kill()
 *  silently did nothing: daemon-restart/daemon-start spawned a fresh daemon
 *  while the old one still held the port → EADDRINUSE crash at startup).
 *  macOS/Linux: lsof, with `-iTCP:<port>` kept as ONE argument (splitting
 *  it makes lsof treat the port as a file name and fail). */
function listenerPid(port) {
	return new Promise(resolve => {
		if (process.platform === "win32") {
			const netstat = spawn("netstat", ["-ano"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
			let out = "";
			netstat.stdout.on("data", chunk => {
				out += chunk;
			});
			netstat.on("error", () => resolve(null));
			netstat.on("close", () => {
				const line = out
					.split(/\r?\n/)
					.find(l => l.includes(`:${port}`) && l.includes("LISTENING"));
				const pid = Number.parseInt((line ?? "").trim().split(/\s+/).pop() ?? "", 10);
				resolve(Number.isInteger(pid) && pid > 0 ? pid : null);
			});
			return;
		}
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
 * Ask the daemon to shut itself down over its own RPC channel.
 *
 * Why an RPC and not a signal: on Windows Node's `SIGTERM` is
 * `TerminateProcess`, which cannot be caught — so `process.on("SIGTERM")` in
 * the daemon never runs there and every teardown was a hard kill that lost
 * in-flight turns. The RPC travels the channel the daemon already serves, so it
 * behaves identically on every platform and lets the daemon release sessions,
 * terminals and extension handles in order.
 *
 * Transport is the daemon's newline-delimited JSON-RPC socket (`daemon.sock`,
 * a unix socket or a Windows named pipe), NOT a WebSocket. The WS client emits
 * an uncatchable `error` event when the peer is not a WS server or has already
 * vanished — measured as a process-level "Unhandled error. (ErrorEvent)" that
 * took down unrelated tests sharing the process. A plain socket has no such
 * surface: connect errors arrive as an `error` event on a stream, which we own.
 *
 * Resolves true when the daemon acknowledged (acknowledged, not finished — the
 * socket closes because teardown is running).
 */
function requestGracefulShutdown(timeoutMs = 2000) {
	const { promise, resolve: done } = Promise.withResolvers();
	let settled = false;
	let socket = null;
	let buffer = "";
	const finish = ok => {
		if (settled) return;
		settled = true;
		try {
			socket?.destroy();
		} catch {
			// already closed
		}
		done(ok);
	};
	const timer = setTimeout(() => finish(false), timeoutMs);
	try {
		socket = net.connect(socketPath());
	} catch {
		clearTimeout(timer);
		finish(false);
		return promise;
	}
	socket.setEncoding("utf8");
	socket.on("connect", () => {
		try {
			socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "system.shutdown", params: {} })}\n`);
		} catch {
			clearTimeout(timer);
			finish(false);
		}
	});
	socket.on("data", chunk => {
		buffer += chunk;
		const idx = buffer.indexOf("\n");
		if (idx === -1) return;
		clearTimeout(timer);
		try {
			const msg = JSON.parse(buffer.slice(0, idx));
			finish(msg && msg.id === 1 && !msg.error);
		} catch {
			finish(false);
		}
	});
	// Stream errors are OURS to handle — never process-level.
	socket.on("error", () => {
		clearTimeout(timer);
		finish(false);
	});
	socket.on("close", () => {
		clearTimeout(timer);
		// Closed without a reply: the daemon went away without acking.
		finish(false);
	});
	return promise;
}

/** The daemon's JSON-RPC socket path (unix socket, or named pipe on Windows). */
function socketPath() {
	return path.join(SOCKET_DIR, "daemon.sock");
}

/**
 * Every live descendant pid of `pid`.
 *
 * Snapshotted BEFORE the root is signalled. `taskkill /T` and `pgrep -P` both
 * walk live parent links, so a `detached` child — which the daemon deliberately
 * orphans at spawn (PTY hosts, extension sidecars) — is unreachable once its
 * parent is gone. Taking the set first is what makes the escalation able to
 * reclaim those children.
 *
 * Best-effort by design: an unreadable process table yields an empty set, and
 * the caller still kills the root.
 */
function descendantPids(pid) {
	const out = [];
	if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(out);
	const collectWin32 = () => {
		// Process-table read on Windows. `wmic` is deprecated/absent on recent
		// builds, and `tasklist` does not expose a parent pid at all — so the CIM
		// query is the only enumeration available. Measured caveat: a cold
		// PowerShell start costs ~5.5s on a loaded machine, which is exactly why
		// the timeout here is generous (20s) rather than tight: a TIMEOUT yields
		// an empty snapshot, and during teardown an empty snapshot means children
		// escape. The caller also falls back to `taskkill /T` (which walks live
		// links itself) when the snapshot is empty.
		try {
			const ps = spawnSync(
				"powershell",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					"Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)\" }",
				],
				{ encoding: "utf8", timeout: 20_000, windowsHide: true },
			);
			const edges = new Map();
			for (const line of String(ps.stdout ?? "").split(/\r?\n/)) {
				const [childRaw, parentRaw] = line.trim().split("\t");
				const child = Number.parseInt(childRaw ?? "", 10);
				const parent = Number.parseInt(parentRaw ?? "", 10);
				if (!Number.isInteger(child) || !Number.isInteger(parent)) continue;
				if (!edges.has(parent)) edges.set(parent, []);
				edges.get(parent).push(child);
			}
			// Breadth-first over the edge map, so grandchildren are included.
			const queue = [pid];
			const seen = new Set([pid]);
			while (queue.length > 0) {
				for (const child of edges.get(queue.shift()) ?? []) {
					if (seen.has(child)) continue;
					seen.add(child);
					out.push(child);
					queue.push(child);
				}
			}
		} catch {
			// no process table — root-only kill still proceeds
		}
	};
	if (process.platform === "win32") {
		collectWin32();
		return Promise.resolve(out);
	}
	// POSIX: walk the tree with pgrep, which is present wherever the daemon runs.
	try {
		const queue = [pid];
		const seen = new Set([pid]);
		while (queue.length > 0) {
			const current = queue.shift();
			const res = spawnSync("pgrep", ["-P", String(current)], { encoding: "utf8", timeout: 3000 });
			for (const line of String(res.stdout ?? "").split(/\r?\n/)) {
				const child = Number.parseInt(line.trim(), 10);
				if (!Number.isInteger(child) || seen.has(child)) continue;
				seen.add(child);
				out.push(child);
				queue.push(child);
			}
		}
	} catch {
		// no pgrep — root-only kill still proceeds
	}
	return Promise.resolve(out);
}

/** Has the port stopped accepting within `timeoutMs`? */
async function waitForPortClosed(port, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (!(await portOpen(port))) return true;
		if (Date.now() >= deadline) return false;
		await new Promise(r => setTimeout(r, 100));
	}
}

/** Kill a recorded descendant set plus `pid` itself, leaves first. */
function forceKillPids(descendants, pid) {
	// Deepest-first: killing a parent can reparent its children to init, after
	// which the recorded pids still address the right processes (pids are not
	// reassigned while alive), so carrying the snapshot is what matters.
	for (const child of [...descendants].reverse()) {
		if (!Number.isInteger(child) || child === pid) continue;
		try {
			process.kill(child, "SIGKILL");
		} catch {
			// already gone
		}
	}
	forceKillTree(pid);
}

/**
 * Force-terminate a process AND its descendants.
 *
 * `process.kill(pid)` reaches only the root, which is how the old code left
 * children holding the inherited listening socket: the port keeps accepting TCP
 * with no server behind it, `connect()` never settles, and the shell hangs on
 * the splash until the machine reboots (docs/gui-implementation.md §8). Both
 * platforms must kill the tree:
 *   win32  — `taskkill /T` walks children; `/F` forces. `/T` must run while the
 *            parent still exists, or it cannot find them.
 *   POSIX  — the daemon is spawned `detached`, so it leads its own process
 *            group; `-pid` signals the whole group.
 */
function forceKillTree(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return;
	if (process.platform === "win32") {
		try {
			// windowsHide + stdio ignore: this runs from the Electron main
			// process, where a console flash is user-visible.
			spawnSync("taskkill", ["/pid", String(pid), "/f", "/t"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
			return;
		} catch {
			// fall through to the single-pid signal below
		}
	} else {
		try {
			process.kill(-pid, "SIGKILL");
			return;
		} catch {
			// no process group (not detached, or already a zombie) — fall back
		}
	}
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// already gone
	}
}

/**
 * Stop the daemon listening on `port`.
 *
 * Escalation ladder — cheapest and least destructive first:
 *   1. `system.shutdown` RPC (cooperative: releases sessions/terminals/handles,
 *      works on Windows where signals are uncatchable),
 *   2. SIGTERM to the process tree (POSIX graceful path; a no-op force on
 *      Windows where only the kill matters),
 *   3. SIGKILL / `taskkill /F` to the whole tree.
 * Resolves once the port is free (or immediately when no listener exists).
 */
async function kill(port) {
	// Cheap existence check first: the boot path calls kill() unconditionally,
	// and opening a socket just to discover nobody is listening would cost the
	// full graceful-RPC timeout on every launch.
	if (!(await portOpen(port))) return;
	const pid = await listenerPid(port);
	if (pid === null) return;

	// `requestGracefulShutdown` speaks to `<SOCKET_DIR>/daemon.sock`, which is
	// the daemon THIS shell knows about. If `port` is not that daemon's port
	// (a second instance under another MUSEPI_DAEMON_DIR, or a foreign `musepi
	// serve`), the request would either reach the wrong process or reach nobody
	// — and "acknowledged by someone else's daemon" is indistinguishable from
	// success. Only ask when the socket's own discovery file names this port.
	const knownPort = probe();
	if (knownPort === port) {
		console.error("[daemon] shutdown request on :" + port);
		// 1. Cooperative. A busy daemon may legitimately need longer than the
		//    probe timeout to finish; the port drop is the real completion signal.
		const acked = await requestGracefulShutdown();
		const coopDeadline = Date.now() + (acked ? GRACEFUL_SHUTDOWN_TIMEOUT_MS : 0);
		while (Date.now() < coopDeadline) {
			if (!(await portOpen(port))) return;
			await new Promise(r => setTimeout(r, 100));
		}
	}

	// 2. On Windows, `taskkill /T` is the tree walk — and it only works while
	//    the ROOT IS ALIVE (it follows live parent links; `detached` children
	//    are deliberately orphaned at spawn, so once the root exits they are
	//    unreachable). Running it here, before any signal, is what actually
	//    reclaims the tree: SIGTERM would terminate the root and dissolve the
	//    links first.
	//
	//    The escalation below still records a descendant snapshot, but only as a
	//    SECOND attempt for the rare case where /T could not see a child. It is
	//    not the primary mechanism because reading the Windows process table
	//    costs a PowerShell start (~2.7s measured, ~5.5s under load) and a quit
	//    must not pay that.
	if (process.platform === "win32") {
		console.error("[daemon] taskkill tree", pid, "on :" + port);
		try {
			spawnSync("taskkill", ["/pid", String(pid), "/f", "/t"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
		} catch {
			// fall through to the snapshot/signal ladder
		}
		// /F /T is synchronous and forceful; if the port is free we are done.
		if (await waitForPortClosed(port, 2000)) return;
	}

	// 3. Signal the root. On POSIX this is the ordinary graceful path; on
	//    Windows Node maps SIGTERM to TerminateProcess (uncatchable), so it only
	//    serves as a further force.
	console.error("[daemon] SIGTERM", pid, "on :" + port);
	const tree = await descendantPids(pid);
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		// already gone — proceed
	}
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		if (!(await portOpen(port))) {
			// Root exited; reclaim anything it left behind, from the snapshot.
			forceKillPids(tree, pid);
			return;
		}
		await new Promise(r => setTimeout(r, 100));
	}

	// 4. Hard kill, whole tree. Without this, start() would spawn a fresh
	// daemon, watch it bind a FALLBACK port (the old one still held) and report
	// success while the old process keeps serving — a restart that visibly does
	// nothing.
	forceKillPids(tree, pid);
	console.error("[daemon] SIGKILL tree", pid);
	const killDeadline = Date.now() + 2000;
	while (Date.now() < killDeadline) {
		if (!(await portOpen(port))) return;
		await new Promise(r => setTimeout(r, 100));
	}
	throw new Error(`daemon on :${port} did not exit after SIGTERM + SIGKILL`);
}

/**
 * True when the CURRENT GUI process owns the running daemon (it spawned
 * it and has not yet been torn down with it). GUI quit paths consult this
 * before killing the daemon: a daemon the GUI merely CONNECTED to (spawned
 * by another GUI instance, launch-at-login, or a terminal `musepi serve`)
 * must survive this GUI's exit. A crashed GUI never reaches the quit path,
 * so its daemon survives the crash — the stale client.pid is reclaimed by
 * the next start().
 */
function ownsDaemon() {
	try {
		return fs.readFileSync(CLIENT_PID_FILE, "utf8").trim() === String(process.pid);
	} catch {
		return false;
	}
}

/* ── Managed-daemon registry + orphan reaper ──────────────────────────────
 *
 * Why: the daemon is spawned `detached` + `unref`ed on purpose, so it outlives
 * a GUI crash and a running turn finishes. The cost is that a hard-killed GUI
 * leaves a daemon nobody owns. The old recovery was `daemon-start`'s blind
 * `kill(port)` — it SIGTERMs whatever listens on the port, which is how a dev
 * instance whose package version differed from a daemon started by the
 * installed app took down `:8300` (docs/gui-implementation.md §8 hazards).
 *
 * The registry replaces "something holds the port → kill it" with evidence:
 * we only ever consider pids WE recorded, we re-verify the live process still
 * matches the recorded identity, and we kill only when the recorded owner is
 * provably gone. A daemon spawned by another GUI, by launch-at-login, or by a
 * terminal `musepi serve` is never registered here, so it is never a candidate.
 * Design mirrors openchamber's managed-process-registry.
 *
 * Storage is ONE FILE PER DAEMON (`<pid>.json`): several shells and worktrees
 * can run concurrently against different MUSEPI_DAEMON_DIRs, and a shared JSON
 * file would be clobbered by concurrent read-modify-write.
 */

/** Liveness probe; EPERM means "exists but not ours to signal" → alive. */
function pidAlive(pid) {
	if (!Number.isInteger(pid)) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err && err.code === "EPERM";
	}
}

/**
 * Does the live process still look like the daemon we recorded? Guards against
 * the OS recycling a dead pid onto an unrelated process — the single most
 * dangerous failure mode of any pid-reaping design.
 *
 * The check binds pid to port in BOTH directions:
 *   - `ws.port` (written by the daemon itself) still names the recorded port;
 *   - the process LISTENING on that port is the pid we recorded.
 *
 * Port-liveness alone is not enough: it proves "a daemon is running", not "the
 * pid in this record is that daemon". A recycled pid that happens to be alive
 * while some unrelated server owns the port would pass a liveness-only test and
 * get SIGTERMed. Anything unverifiable is NOT trusted.
 */
async function stillOurDaemon(entry) {
	if (!pidAlive(entry.pid)) return false;
	if (!Number.isInteger(entry.port)) return false;
	if (probe() !== entry.port) return false;
	if (!(await portOpen(entry.port))) return false;
	const owner = await listenerPid(entry.port);
	return owner === entry.pid;
}

function registryFile(pid) {
	return path.join(REGISTRY_DIR, `${pid}.json`);
}

/** Record a daemon we spawned so a later run can reclaim it if orphaned. */
function registerManagedDaemon(entry) {
	if (!entry || !Number.isInteger(entry.pid)) return;
	try {
		fs.mkdirSync(REGISTRY_DIR, { recursive: true });
		const payload = {
			pid: entry.pid,
			ownerPid: Number.isInteger(entry.ownerPid) ? entry.ownerPid : process.pid,
			port: Number.isInteger(entry.port) ? entry.port : null,
			command: Array.isArray(entry.command) ? entry.command : null,
			startedAt: new Date().toISOString(),
		};
		// Write-then-rename: a crash mid-write must not leave a truncated JSON
		// that later parses as garbage.
		const file = registryFile(entry.pid);
		const tmp = `${file}.tmp-${process.pid}`;
		fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
		fs.renameSync(tmp, file);
	} catch {
		// Best-effort: a failed registry write must never break spawn.
	}
}

/** Drop a daemon from the registry (after we killed it or found it dead). */
function unregisterManagedDaemon(pid) {
	try {
		fs.unlinkSync(registryFile(pid));
	} catch {
		// already gone
	}
}

/** All registry entries; corrupt files are dropped rather than trusted. */
function readManagedDaemons() {
	let names = [];
	try {
		names = fs.readdirSync(REGISTRY_DIR);
	} catch {
		return [];
	}
	const out = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const file = path.join(REGISTRY_DIR, name);
		// A file we cannot attribute to a pid is garbage either way: drop it by
		// path (the name may not be a pid at all, so unregister would miss it).
		const dropFile = () => {
			try {
				fs.unlinkSync(file);
			} catch {
				// best-effort
			}
		};
		try {
			const entry = JSON.parse(fs.readFileSync(file, "utf8"));
			if (entry && Number.isInteger(entry.pid)) out.push(entry);
			else dropFile();
		} catch {
			dropFile();
		}
	}
	return out;
}

/**
 * Kill any genuinely-orphaned daemon WE spawned, and prune the registry.
 *
 * Reaps only when ALL of these hold:
 *   1. the pid is in our registry (we spawned it),
 *   2. the live process still answers on the recorded port (identity),
 *   3. its recorded owner pid is dead.
 * Everything else is left untouched. Returns `{ inspected, reaped }`.
 *
 * Call this at startup BEFORE deciding to spawn, so a crash-orphaned daemon
 * frees its port instead of colliding with the replacement.
 */
async function reapOrphanedDaemons() {
	const entries = readManagedDaemons();
	let reaped = 0;
	for (const entry of entries) {
		let drop = false;
		try {
			if (!pidAlive(entry.pid)) {
				drop = true; // already dead: just prune the record
			} else if (!(await stillOurDaemon(entry))) {
				// The pid was recycled, or the recorded port now belongs to
				// something else. Never kill on unverified identity.
				drop = false;
			} else if (Number.isInteger(entry.ownerPid) && !pidAlive(entry.ownerPid)) {
				console.error(`[daemon] reaping orphaned daemon ${entry.pid} (owner ${entry.ownerPid} gone)`);
				try {
					process.kill(entry.pid, "SIGTERM");
				} catch {
					// already exiting
				}
				reaped += 1;
				drop = true;
			}
		} catch (err) {
			console.error(`[daemon] reap check failed for ${entry.pid}:`, err && err.message ? err.message : err);
		}
		if (drop) unregisterManagedDaemon(entry.pid);
	}
	return { inspected: entries.length, reaped };
}

/**
 * Is the probed daemon an orphan WE spawned — registry-verified, identity
 * intact, recorded owner dead? This is the reap condition of
 * `reapOrphanedDaemons` factored into a query: the boot path needs the same
 * evidence to decide "restart or adopt" WITHOUT killing anything, and the
 * renderer asks via the `daemon-orphaned` IPC after connecting.
 *
 * Returns the matching registry entry, or null. A daemon with no registry
 * record (terminal `musepi serve`, launch-at-login) is foreign by definition
 * and is never reported — exactly the daemons the reaper cannot see.
 */
async function findOrphanedDaemon() {
	const port = probe();
	if (!port) return null;
	for (const entry of readManagedDaemons()) {
		if (entry.port !== port) continue;
		if (Number.isInteger(entry.ownerPid) && pidAlive(entry.ownerPid)) continue;
		if (await stillOurDaemon(entry)) return entry;
	}
	return null;
}

/**
 * Claim an orphaned daemon for THIS GUI process: rewrite the ownership
 * marker and the registry's ownerPid, so a later graceful quit runs
 * `ownsDaemon()` → true and tears the daemon down. Used when the daemon has
 * live working sessions and must not be restarted mid-turn — the turn keeps
 * running, and the daemon stops outliving every GUI that ever connects to
 * it. No-op (false) when the probed daemon is not a registry-verified orphan.
 */
async function adoptDaemon() {
	const entry = await findOrphanedDaemon();
	if (!entry) return false;
	try {
		fs.writeFileSync(CLIENT_PID_FILE, String(process.pid), "utf8");
	} catch {
		return false;
	}
	try {
		const file = registryFile(entry.pid);
		const updated = { ...entry, ownerPid: process.pid };
		const tmp = `${file}.tmp-${process.pid}`;
		fs.writeFileSync(tmp, JSON.stringify(updated), "utf8");
		fs.renameSync(tmp, file);
	} catch {
		// Best-effort: the marker alone already makes ownsDaemon() true.
	}
	return true;
}

/** Clear the ownership marker (after killing the daemon we spawned). */
function clearDaemonOwnership() {
	try {
		fs.unlinkSync(CLIENT_PID_FILE);
	} catch {
		// already gone
	}
}

/**
 * Stop the daemon IF this GUI process owns it. Returns true when the
 * daemon was killed (owner) — quit paths await this before exiting.
 */
async function killOwnedDaemon() {
	const port = probe();
	if (!port) return false;
	if (!ownsDaemon()) return false;
	// Registry entry first, so a crash between the kill and the unlink below
	// leaves a record the next startup's reaper can settle (it will find the
	// pid dead and just prune the file).
	const owned = readManagedDaemons().filter(entry => entry.ownerPid === process.pid);
	clearDaemonOwnership();
	await kill(port);
	for (const entry of owned) unregisterManagedDaemon(entry.pid);
	return true;
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

module.exports = {
	probe,
	probeWeb,
	start,
	restart,
	kill,
	listenerPid,
	killOwnedDaemon,
	ownsDaemon,
	clearDaemonOwnership,
	portOpen,
	daemonCommand,
	// Managed-daemon registry (orphan reaping; see the block above).
	registerManagedDaemon,
	unregisterManagedDaemon,
	readManagedDaemons,
	reapOrphanedDaemons,
	pidAlive,
	findOrphanedDaemon,
	adoptDaemon,
	SOCKET_DIR,
	PORT_FILE,
	WEB_PORT_FILE,
	CLIENT_PID_FILE,
	REGISTRY_DIR,
	resetSocketDirForTests,
};

