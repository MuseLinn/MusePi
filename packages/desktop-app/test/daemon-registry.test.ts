import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
// daemon.cjs lives outside tsconfig include (electron/) and has no types.
// Namespace import keeps this on ONE line so the directive attaches to the
// offending import (the named form gets wrapped by the formatter and detaches).
// @ts-expect-error — untyped CJS module (electron/, outside tsconfig include)
import * as daemon from "../electron/daemon.cjs";

const {
	pidAlive,
	REGISTRY_DIR,
	readManagedDaemons,
	reapOrphanedDaemons,
	registerManagedDaemon,
	unregisterManagedDaemon,
} = daemon;

/**
 * Managed-daemon registry + orphan reaper (openchamber managed-process-registry
 * parity).
 *
 * Contract under test: the reaper reclaims ONLY daemons this product spawned
 * whose owning shell is provably dead. Every other shape — a daemon still owned
 * by a live shell, a recycled pid, an unverifiable process, a foreign daemon
 * that was never registered — must be left untouched.
 *
 * The dangerous regression this defends: the old `daemon-start` did a bare
 * `kill(port)`, so a dev GUI could SIGTERM a daemon started by the installed
 * app or a terminal `musepi serve` (docs/gui-implementation.md §8 hazards).
 */

/** A pid that is alive for the duration of the test (our own runtime). */
const LIVE_PID = process.pid;
/** A pid that is essentially never in use on Windows/macOS/Linux. */
const DEAD_PID = 0x7ffffff0;

function seed(entry: Record<string, unknown>): void {
	mkdirSync(REGISTRY_DIR, { recursive: true });
	writeFileSync(path.join(REGISTRY_DIR, `${entry.pid}.json`), JSON.stringify(entry), "utf8");
}

function registryFileCount(): number {
	try {
		mkdirSync(REGISTRY_DIR, { recursive: true });
		return (readdirSync(REGISTRY_DIR) as string[]).filter((n: string) => n.endsWith(".json")).length;
	} catch {
		return 0;
	}
}

beforeEach(() => {
	rmSync(REGISTRY_DIR, { recursive: true, force: true });
});

afterEach(() => {
	rmSync(REGISTRY_DIR, { recursive: true, force: true });
});

describe("managed daemon registry", () => {
	it("round-trips an entry and drops it on unregister", () => {
		registerManagedDaemon({ pid: 4242, ownerPid: 99, port: 8300, command: ["musepi", "serve", "--port", "8300"] });
		const entries = readManagedDaemons();
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ pid: 4242, ownerPid: 99, port: 8300 });

		unregisterManagedDaemon(4242);
		expect(readManagedDaemons()).toHaveLength(0);
	});

	it("prunes a corrupt registry file instead of trusting it", () => {
		mkdirSync(REGISTRY_DIR, { recursive: true });
		writeFileSync(path.join(REGISTRY_DIR, "777.json"), "{ not json", "utf8");
		expect(readManagedDaemons()).toHaveLength(0);
		expect(registryFileCount()).toBe(0);
	});

	it("prunes an entry whose file name is not a pid", () => {
		mkdirSync(REGISTRY_DIR, { recursive: true });
		writeFileSync(path.join(REGISTRY_DIR, "garbage.json"), JSON.stringify({ nope: true }), "utf8");
		expect(readManagedDaemons()).toHaveLength(0);
		expect(registryFileCount()).toBe(0);
	});
});

describe("orphan reaper safety", () => {
	it("prunes the record of a daemon that is already dead, without killing anything", async () => {
		seed({ pid: DEAD_PID, ownerPid: LIVE_PID, port: 8300 });
		expect(pidAlive(DEAD_PID)).toBe(false);

		const result = await reapOrphanedDaemons();
		expect(result.reaped).toBe(0);
		// The dead daemon's record is stale bookkeeping → dropped.
		expect(readManagedDaemons()).toHaveLength(0);
	});

	it("never kills a daemon whose owning shell is still alive", async () => {
		// Owner = this test process, which is very much alive. The recorded
		// port is not listening, so identity verification also fails — either
		// way the daemon must survive.
		seed({ pid: LIVE_PID, ownerPid: LIVE_PID, port: 8399 });

		const result = await reapOrphanedDaemons();
		expect(result.reaped).toBe(0);
		expect(pidAlive(LIVE_PID)).toBe(true);
		expect(readManagedDaemons()).toHaveLength(1);
	});

	it("never kills an unregistered listener (foreign daemon)", async () => {
		// Nothing seeded: the reaper has no evidence, so it must not act. This
		// is the case that used to be a blind `kill(port)`.
		const result = await reapOrphanedDaemons();
		expect(result).toEqual({ inspected: 0, reaped: 0 });
		expect(pidAlive(LIVE_PID)).toBe(true);
	});

	it("never kills when the owner is gone but the process identity no longer matches", async () => {
		// Simulates pid recycling: the recorded owner is dead and the recorded
		// port does not answer for this pid. A reaper that trusted the registry
		// alone would SIGTERM an unrelated process here.
		seed({ pid: LIVE_PID, ownerPid: DEAD_PID, port: 8399 });

		const result = await reapOrphanedDaemons();
		expect(result.reaped).toBe(0);
		expect(pidAlive(LIVE_PID)).toBe(true);
	});
});

describe("registry hygiene", () => {
	it("ignores a registry directory that does not exist", async () => {
		rmSync(REGISTRY_DIR, { recursive: true, force: true });
		expect(readManagedDaemons()).toEqual([]);
		expect(await reapOrphanedDaemons()).toEqual({ inspected: 0, reaped: 0 });
	});

	it("keeps two daemons' records independent (one file per pid)", () => {
		registerManagedDaemon({ pid: 1111, ownerPid: 3, port: 8300 });
		registerManagedDaemon({ pid: 2222, ownerPid: 4, port: 8301 });
		expect(readManagedDaemons()).toHaveLength(2);
		unregisterManagedDaemon(1111);
		const rest = readManagedDaemons();
		expect(rest).toHaveLength(1);
		expect(rest[0]!.pid).toBe(2222);
	});
});
