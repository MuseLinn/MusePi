import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import * as path from "node:path";

/**
 * Boot takeover gate (daemon.cjs `findOrphanedDaemon` / `adoptDaemon`).
 *
 * The probe→connect boot path never runs the reaper, so a daemon whose
 * owning GUI died used to be connected to forever — and every later quit
 * found client.pid naming a dead process, leaving the daemon running
 * indefinitely. The gate queries the same evidence as the reaper WITHOUT
 * killing: restart when idle, adopt (transfer ownership) when mid-turn.
 *
 * Runs against a PRIVATE MUSEPI_DAEMON_DIR (set before the module is
 * imported — daemon.cjs resolves its paths at require time), unlike the
 * sibling reaper/registry suites: adoption writes the ownership marker and
 * a real GUI's registry must never be touched by a test.
 *
 * A REAL child process stands in for the daemon — never `process.pid`: the
 * identity check binds pid↔port in both directions and needs a genuine
 * listener.
 */

interface DaemonModule {
	findOrphanedDaemon(): Promise<unknown>;
	adoptDaemon(): Promise<boolean>;
	ownsDaemon(): boolean;
	pidAlive(pid: number): boolean;
	readManagedDaemons(): Array<{ pid: number; ownerPid: number; port: number }>;
	resetSocketDirForTests(dir: string | null): void;
}

let daemon: DaemonModule;
let socketDir: string;

// Path layout contract of daemon.cjs, mirrored locally: exported path
// constants are bound at import time (a sibling test file may have imported
// the module first), so a reset suite addresses the private dir directly.
function registryDir(): string {
	return path.join(socketDir, "managed");
}
function portFile(): string {
	return path.join(socketDir, "ws.port");
}
function clientPidFile(): string {
	return path.join(socketDir, "client.pid");
}

/** A pid that is definitely not running: the recorded "owner". */
const DEAD_OWNER = 0x7ffffff0;
/** A pid of a live process that is NOT the daemon (the test runner). */
const LIVE_PID = process.pid;

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr !== null ? addr.port : 0;
			srv.close(() => (port > 0 ? resolve(port) : reject(new Error("no port"))));
		});
	});
}

const children: ChildProcess[] = [];

function startFakeDaemon(port: number): Promise<ChildProcess> {
	const script = `const net=require("node:net");const s=net.createServer(x=>x.end());s.listen(${port},"127.0.0.1",()=>process.stdout.write("ready\\n"));`;
	const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
	children.push(child);
	return new Promise<ChildProcess>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("fake daemon did not listen")), 8000);
		child.stdout?.once("data", () => {
			clearTimeout(timer);
			resolve(child);
		});
		child.once("error", reject);
	});
}

function seedOrphan(entry: Record<string, unknown>): void {
	mkdirSync(registryDir(), { recursive: true });
	writeFileSync(path.join(registryDir(), `${entry.pid}.json`), JSON.stringify(entry), "utf8");
}

function writeWsPort(port: number): void {
	mkdirSync(path.dirname(portFile()), { recursive: true });
	writeFileSync(portFile(), String(port), "utf8");
}

beforeAll(async () => {
	socketDir = mkdtempSync(path.join(tmpdir(), "musepi-daemon-adopt-test-"));
	// @ts-expect-error — untyped CJS module (electron/, outside tsconfig include)
	daemon = (await import("../electron/daemon.cjs")) as unknown as DaemonModule;
	// A sibling file may already have imported the module in this shared test
	// process, so "set the env before import" cannot isolate it — use the
	// explicit test seam and restore the default afterwards.
	daemon.resetSocketDirForTests(socketDir);
});

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) {
			try {
				child.kill("SIGKILL");
			} catch {
				/* gone */
			}
		}
	}
	daemon.resetSocketDirForTests(socketDir);
	rmSync(socketDir, { recursive: true, force: true });
	mkdirSync(socketDir, { recursive: true });
});

afterAll(() => {
	daemon.resetSocketDirForTests(null);
	rmSync(socketDir, { recursive: true, force: true });
});

describe("findOrphanedDaemon", () => {
	it("reports a registry-recorded daemon whose owning GUI is gone", async () => {
		const port = await freePort();
		const child = await startFakeDaemon(port);
		writeWsPort(port);
		seedOrphan({ pid: child.pid, ownerPid: DEAD_OWNER, port });

		const entry = await daemon.findOrphanedDaemon();
		expect(entry).not.toBeNull();
		// A query, not a kill: the daemon keeps serving while the renderer
		// decides between restart (idle) and adopt (mid-turn).
		expect(daemon.pidAlive(child.pid ?? 0)).toBe(true);
	}, 30_000);

	it("returns null while the recorded owner is alive", async () => {
		const port = await freePort();
		const child = await startFakeDaemon(port);
		writeWsPort(port);
		seedOrphan({ pid: child.pid, ownerPid: LIVE_PID, port });

		expect(await daemon.findOrphanedDaemon()).toBeNull();
	}, 30_000);

	it("never reports a foreign listener with no registry record", async () => {
		const port = await freePort();
		await startFakeDaemon(port);
		writeWsPort(port);

		expect(await daemon.findOrphanedDaemon()).toBeNull();
	}, 30_000);

	it("returns null when no ws.port is written", async () => {
		expect(await daemon.findOrphanedDaemon()).toBeNull();
	}, 30_000);
});

describe("adoptDaemon", () => {
	it("transfers ownership of an orphan to this process without killing it", async () => {
		const port = await freePort();
		const child = await startFakeDaemon(port);
		writeWsPort(port);
		seedOrphan({ pid: child.pid, ownerPid: DEAD_OWNER, port });

		expect(await daemon.adoptDaemon()).toBe(true);
		// The ownership marker now names this process: a graceful quit will
		// run killOwnedDaemon against this daemon.
		expect(readFileSync(clientPidFile(), "utf8").trim()).toBe(String(process.pid));
		expect(daemon.ownsDaemon()).toBe(true);
		// The registry record follows, so the reaper also sees this owner.
		const entries = daemon.readManagedDaemons();
		expect(entries).toHaveLength(1);
		expect(entries[0].ownerPid).toBe(process.pid);
		// Adoption must not interrupt the daemon itself.
		expect(daemon.pidAlive(child.pid ?? 0)).toBe(true);
	}, 30_000);

	it("is a no-op when the daemon is not a registry-verified orphan", async () => {
		const port = await freePort();
		const child = await startFakeDaemon(port);
		writeWsPort(port);
		seedOrphan({ pid: child.pid, ownerPid: LIVE_PID, port });

		expect(await daemon.adoptDaemon()).toBe(false);
		// Ownership marker untouched.
		expect(daemon.ownsDaemon()).toBe(false);
		let markerWritten = true;
		try {
			readFileSync(clientPidFile(), "utf8");
		} catch {
			markerWritten = false;
		}
		expect(markerWritten).toBe(false);
	}, 30_000);
});
