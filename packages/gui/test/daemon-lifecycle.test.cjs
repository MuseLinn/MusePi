/**
 * Lightweight Node.js smoke test for the daemon lifecycle helpers in
 * `packages/gui/electron/daemon.cjs`. No Electron import, no GUI.
 *
 * Covers:
 *   - clearDaemonOwnership() removes the pid file
 *   - killOwnedDaemon() kills only when pid matches, clears pid file
 *   - non-owner daemon is NOT killed by killOwnedDaemon
 */

"use strict";

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "musepi-daemon-test-"));
const SOCKET_DIR = path.join(os.tmpdir(), "musepi-daemon");
const WS_PORT_FILE = path.join(SOCKET_DIR, "ws.port");
const CLIENT_PID_FILE = path.join(SOCKET_DIR, "client.pid");

let passed = 0;
let failed = 0;

function assert(cond, msg) {
	if (cond) {
		passed++;
		console.log(`  ✓ ${msg}`);
	} else {
		failed++;
		console.error(`  ✗ ${msg}`);
	}
}

// ── helpers ──────────────────────────────────────────────────────────────

function loadDaemonModule() {
	delete require.cache[require.resolve("../../gui/electron/daemon.cjs")];
	return require("../../gui/electron/daemon.cjs");
}

function snapshotSocketFiles() {
	return {
		wsPort: fs.existsSync(WS_PORT_FILE) ? fs.readFileSync(WS_PORT_FILE, "utf8").trim() : null,
		clientPid: fs.existsSync(CLIENT_PID_FILE) ? fs.readFileSync(CLIENT_PID_FILE, "utf8").trim() : null,
	};
}

function restoreSocketFiles(snap) {
	if (snap.wsPort !== null) {
		fs.writeFileSync(WS_PORT_FILE, snap.wsPort, "utf8");
	} else if (fs.existsSync(WS_PORT_FILE)) {
		fs.unlinkSync(WS_PORT_FILE);
	}
	if (snap.clientPid !== null) {
		fs.writeFileSync(CLIENT_PID_FILE, snap.clientPid, "utf8");
	} else if (fs.existsSync(CLIENT_PID_FILE)) {
		fs.unlinkSync(CLIENT_PID_FILE);
	}
}

function spawnPortListener(port) {
	const child = spawn(process.execPath, [
		"-e",
		`const net=require('net');const s=net.createServer();s.listen(${port},'127.0.0.1',()=>{});setInterval(()=>{},1<<30);`,
	], { detached: false, stdio: "ignore" });
	return child;
}

function isProcessDead(pid) {
	try {
		process.kill(pid, 0);
		return false;
	} catch {
		return true;
	}
}

// ── tests ────────────────────────────────────────────────────────────────

function testClearDaemonOwnership() {
	const mod = loadDaemonModule();
	const snap = snapshotSocketFiles();
	try {
		fs.mkdirSync(path.dirname(CLIENT_PID_FILE), { recursive: true });
		fs.writeFileSync(CLIENT_PID_FILE, "12345", "utf8");
		assert(fs.existsSync(CLIENT_PID_FILE), "module pid file exists before clear");

		mod.clearDaemonOwnership();

		assert(!fs.existsSync(CLIENT_PID_FILE), "module pid file gone after clearDaemonOwnership");
	} finally {
		restoreSocketFiles(snap);
	}
}

async function testKillOwnedDaemonKillsOnlyOwned() {
	const mod = loadDaemonModule();
	const snap = snapshotSocketFiles();
	try {
		// 1) Pick a random free port and spawn a child that listens on it.
		const probeSrv = require("node:net").createServer();
		await new Promise(r => probeSrv.listen(0, "127.0.0.1", r));
		const port = probeSrv.address().port;
		probeSrv.close();

		const child = spawnPortListener(port);
		assert(child.pid > 0, "dummy port listener spawned");

		// Wait for child to bind.
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline) {
			if (await mod.portOpen(port)) break;
			await new Promise(r => setTimeout(r, 50));
		}

		// 2) Write ws.port and client.pid = test runner pid (ownsDaemon compares to process.pid).
		fs.mkdirSync(path.dirname(WS_PORT_FILE), { recursive: true });
		fs.writeFileSync(WS_PORT_FILE, String(port), "utf8");
		fs.writeFileSync(CLIENT_PID_FILE, String(process.pid), "utf8");

		// 3) Non-owner path: change client.pid to a different pid.
		fs.writeFileSync(CLIENT_PID_FILE, "999999", "utf8");
		assert(mod.ownsDaemon() === false, "ownsDaemon false when pid mismatches");
		assert(await mod.killOwnedDaemon() === false, "killOwnedDaemon returns false for non-owner");
		assert(!isProcessDead(child.pid), "dummy still alive after non-owner killOwnedDaemon");
		assert(fs.existsSync(CLIENT_PID_FILE), "pid file preserved after non-owner killOwnedDaemon");

		// Owner path: restore client.pid = runner pid.
		fs.writeFileSync(CLIENT_PID_FILE, String(process.pid), "utf8");
		assert(mod.ownsDaemon() === true, "ownsDaemon true when pid matches runner");
		const killed = await mod.killOwnedDaemon();
		assert(killed === true, "killOwnedDaemon returns true for owner");

		// The child may take a moment to release the port after SIGTERM;
		// poll briefly instead of assuming 500ms is enough.
		const closeDeadline = Date.now() + 2000;
		while (Date.now() < closeDeadline) {
			if (!(await mod.portOpen(port))) break;
			await new Promise(r => setTimeout(r, 100));
		}
		assert(!(await mod.portOpen(port)), "port closed after owned killOwnedDaemon");
		assert(!fs.existsSync(CLIENT_PID_FILE), "pid file cleared after owned killOwnedDaemon");
		assert(!fs.existsSync(CLIENT_PID_FILE), "pid file cleared after owned killOwnedDaemon");
	} finally {
		restoreSocketFiles(snap);
	}
}

// ── run ──────────────────────────────────────────────────────────────────

async function main() {
	console.log("\ndaemon lifecycle smoke test\n");

	testClearDaemonOwnership();
	await testKillOwnedDaemonKillsOnlyOwned();

	console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
	if (failed > 0) process.exitCode = 1;

	try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
