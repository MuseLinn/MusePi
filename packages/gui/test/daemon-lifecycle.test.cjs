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

function isProcessDead(pid) {
	try {
		process.kill(pid, 0);
		return false;
	} catch {
		return true;
	}
}

function spawnPortListener(portFile) {
	const child = spawn(process.execPath, [
		"-e",
		`const net=require('net');const fs=require('fs');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{fs.writeFileSync(${JSON.stringify(portFile)},String(s.address().port))});setInterval(()=>{},1<<30);`,
	], { detached: false, stdio: "ignore" });
	return child;
}

// ── tests ────────────────────────────────────────────────────────────────

function testClearDaemonOwnership() {
	const mod = loadDaemonModule();
	const target = mod.CLIENT_PID_FILE;
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, "12345", "utf8");
	assert(fs.existsSync(target), "module pid file exists before clear");

	mod.clearDaemonOwnership();

	assert(!fs.existsSync(target), "module pid file gone after clearDaemonOwnership");
}

async function testKillOwnedDaemonKillsOnlyOwned() {
	const mod = loadDaemonModule();

	// Spawn a child that binds a real port and writes it to a file.
	const portFile = path.join(TMP, "child.port");
	const child = spawnPortListener(portFile);

	// Wait for the port file to appear (child bound successfully).
	const port = await new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = () => {
			try {
				const p = fs.readFileSync(portFile, "utf8").trim();
				if (p && Number.isInteger(Number(p))) return resolve(Number(p));
			} catch {}
			if (Date.now() - start > 3000) return reject(new Error("child did not bind in time"));
			setTimeout(tick, 50);
		};
		tick();
	});

	assert(child.pid > 0, "dummy port listener spawned");
	console.log(`  child pid=${child.pid} port=${port}`);

	// Point the module at our temp dir by writing its expected port file.
	fs.mkdirSync(path.dirname(mod.PORT_FILE), { recursive: true });
	fs.writeFileSync(mod.PORT_FILE, String(port), "utf8");

	const target = mod.CLIENT_PID_FILE;
	fs.mkdirSync(path.dirname(target), { recursive: true });

	// Non-owner: pid mismatch -> no kill, pid file stays.
	fs.writeFileSync(target, "999999", "utf8");
	assert(mod.ownsDaemon() === false, "ownsDaemon false when pid mismatches");
	assert(await mod.killOwnedDaemon() === false, "killOwnedDaemon returns false for non-owner");
	assert(!isProcessDead(child.pid), "dummy still alive after non-owner killOwnedDaemon");
	assert(fs.existsSync(target), "pid file preserved after non-owner killOwnedDaemon");

	// Owner: pid matches runner -> kill child via port lookup, pid file cleared.
	fs.writeFileSync(target, String(process.pid), "utf8");
	assert(mod.ownsDaemon() === true, "ownsDaemon true when pid matches runner");
	const killed = await mod.killOwnedDaemon();
	assert(killed === true, "killOwnedDaemon returns true for owner");

	await new Promise(r => setTimeout(r, 500));
	assert(isProcessDead(child.pid), "dummy process dead after owned killOwnedDaemon");
	assert(!fs.existsSync(target), "pid file cleared after owned killOwnedDaemon");
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
