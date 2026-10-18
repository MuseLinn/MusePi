import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
// daemon.cjs lives outside tsconfig include (electron/) and has no types.
// @ts-expect-error — untyped CJS module (electron/, outside tsconfig include)
import { PORT_FILE, pidAlive, REGISTRY_DIR, readManagedDaemons, reapOrphanedDaemons } from "../electron/daemon.cjs";

/**
 * The reaper's POSITIVE case: an orphaned daemon that IS ours must actually be
 * reclaimed, so a GUI crash does not strand a daemon holding the port forever.
 *
 * Counterpart to `daemon-registry.test.ts` (which proves it never kills the
 * wrong thing). Together they pin both halves of the contract.
 *
 * A REAL child process stands in for the daemon — never `process.pid`: the reap
 * path sends SIGTERM, and a stand-in that shares the test runner's pid would
 * kill the runner. The child holds the port, so the identity check (listener
 * pid === recorded pid, ws.port === recorded port) is satisfied for real.
 */

/**
 * An OS-assigned free port.
 *
 * The full suite runs several `bun test` processes in parallel, each running
 * files concurrently. Fixed or pid-derived ranges collided with another runner
 * (each then measured the other's process). Asking the OS is collision-free.
 */
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
	// A minimal listener whose pid the registry records; identical in the two
	// facts the reaper verifies (owns the port, is the recorded pid).
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
	mkdirSync(REGISTRY_DIR, { recursive: true });
	writeFileSync(path.join(REGISTRY_DIR, `${entry.pid}.json`), JSON.stringify(entry), "utf8");
}

function writeWsPort(port: number): void {
	mkdirSync(path.dirname(PORT_FILE), { recursive: true });
	writeFileSync(PORT_FILE, String(port), "utf8");
}

/** Wait until the port stops answering (the reap is asynchronous). */
function portClosed(port: number, timeoutMs = 5000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	return new Promise(resolve => {
		const tick = (): void => {
			const sock = net.connect({ host: "127.0.0.1", port });
			const done = (open: boolean): void => {
				sock.removeAllListeners();
				sock.destroy();
				if (!open) return resolve(true);
				if (Date.now() >= deadline) return resolve(false);
				setTimeout(tick, 50);
			};
			sock.once("connect", () => done(true));
			sock.once("error", () => done(false));
			sock.setTimeout(300, () => done(false));
		};
		tick();
	});
}

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
	try {
		rmSync(PORT_FILE, { force: true });
	} catch {
		/* ignore */
	}
	rmSync(REGISTRY_DIR, { recursive: true, force: true });
});

/** A pid that is definitely not running: the recorded "owner". */
const DEAD_OWNER = 0x7ffffff0;
/** A pid of a live process that is NOT the daemon (the test runner). */
const LIVE_PID = process.pid;

describe("orphan reaper reclaim", () => {
	it("terminates a daemon we spawned whose owning shell is gone", async () => {
		const port = await freePort();
		const daemon = await startFakeDaemon(port);
		writeWsPort(port);
		seedOrphan({ pid: daemon.pid, ownerPid: DEAD_OWNER, port });

		expect(pidAlive(DEAD_OWNER)).toBe(false);

		const result = await reapOrphanedDaemons();
		expect(result.inspected).toBe(1);
		expect(result.reaped).toBe(1);
		expect(await portClosed(port)).toBe(true);
		// The record is dropped once its daemon has been reclaimed.
		expect(readManagedDaemons()).toHaveLength(0);
		// Real child processes + a process-table read: give it headroom under a
		// fully parallel suite (other test processes compete for the same cores).
	}, 30_000);

	it("leaves a daemon alone while its owning shell is still alive", async () => {
		const port = await freePort();
		const daemon = await startFakeDaemon(port);
		writeWsPort(port);
		// Owner = a live process → not an orphan, must not be touched.
		seedOrphan({ pid: daemon.pid, ownerPid: LIVE_PID, port });

		const result = await reapOrphanedDaemons();
		expect(result.reaped).toBe(0);
		expect(pidAlive(daemon.pid)).toBe(true);
		expect(readManagedDaemons()).toHaveLength(1);
	}, 30_000);

	it("does not trust a record whose recorded port is not the live listener", async () => {
		const port = await freePort();
		await startFakeDaemon(port);
		// ws.port names a DIFFERENT port than the record: identity unprovable.
		writeWsPort(port + 1);
		seedOrphan({ pid: LIVE_PID, ownerPid: DEAD_OWNER, port });

		const result = await reapOrphanedDaemons();
		expect(result.reaped).toBe(0);
		expect(pidAlive(LIVE_PID)).toBe(true);
	}, 30_000);

	it("does not reclaim when the listener is a different pid than the record", async () => {
		const port = await freePort();
		const daemon = await startFakeDaemon(port);
		writeWsPort(port);
		// Same port, but the record names the test runner instead of the real
		// listener → pid recycling. Must not SIGTERM the recorded pid.
		seedOrphan({ pid: LIVE_PID, ownerPid: DEAD_OWNER, port });

		const result = await reapOrphanedDaemons();
		expect(result.reaped).toBe(0);
		expect(pidAlive(LIVE_PID)).toBe(true);
		expect(pidAlive(daemon.pid)).toBe(true);
	}, 30_000);
});

/**
 * Leave no trace: the fake daemon children are reaped above, and the shared
 * singleton marker (`ws.port`) is removed — a leftover would make a real GUI
 * boot target a dead port.
 */
afterAll(() => {
	rmSync(PORT_FILE, { force: true });
	rmSync(REGISTRY_DIR, { recursive: true, force: true });
});
