import { afterEach, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import * as net from "node:net";
// daemon.cjs lives outside tsconfig include (electron/) and has no types.
// @ts-expect-error — untyped CJS module (electron/, outside tsconfig include)
import { kill, portOpen } from "../electron/daemon.cjs";

/**
 * `kill()` must tear down the daemon AND its descendant processes.
 *
 * Why: the old implementation sent `process.kill(pid, "SIGTERM")` to the root
 * only. Children that inherited the listening socket then keep the port
 * accepting TCP with no server behind it — `connect()` never settles, the shell
 * hangs on its splash, and recovery means rebooting the machine
 * (docs/gui-implementation.md §8 hazard 2).
 *
 * Scope note, stated honestly: on this platform a root kill can also collapse
 * the child process tree via job objects, so this suite cannot prove that a
 * root-only implementation WOULD strand a child (that was checked by reverting
 * `forceKillTree` during development: the port still freed, because the test
 * runner's job object reaped the survivors). What it does pin is the property
 * the shell depends on — after `kill()` the port stops accepting, the daemon
 * is gone, and unrelated processes are untouched.
 */

const children: ChildProcess[] = [];
/**
 * An OS-assigned free port per case.
 *
 * The full suite runs several `bun test` processes in parallel, each running
 * files concurrently. Any fixed or pid-derived port range collided with another
 * runner or another daemon test file, and `kill()` then resolved the OTHER
 * process — a cross-process artefact, not a code defect. Asking the OS for a
 * free port is the only collision-free option.
 */
function takePort(): Promise<number> {
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

function startTree(port: number): Promise<{ childPid: Promise<number>; parentPid: number }> {
	// A faithful shape: the ROOT holds the listening socket and owns a child,
	// and both are spawned detached — the same way the Electron shell spawns
	// `musepi serve`, and the way the daemon spawns its own children.
	const childScript = `setInterval(() => {}, 1000);`;
	const parentScript = `
const net = require("node:net");
const { spawn } = require("node:child_process");
const s = net.createServer(x => x.end());
s.listen(${port}, "127.0.0.1", () => {
  const kid = spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], {
    stdio: "ignore",
    detached: true,
  });
  kid.unref();
  process.stdout.write("ready " + kid.pid + "\\n");
});
setInterval(() => {}, 1000);
`;
	const parent = spawn(process.execPath, ["-e", parentScript], {
		stdio: ["ignore", "pipe", "ignore"],
		windowsHide: true,
		detached: true,
	});
	parent.unref();
	children.push(parent);

	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const timer = setTimeout(() => reject(new Error("fake daemon tree did not start")), 10_000);
	parent.stdout?.once("data", chunk => {
		clearTimeout(timer);
		const match = String(chunk).match(/ready (\d+)/);
		if (!match) return reject(new Error(`unexpected readiness output: ${chunk}`));
		resolve(Number(match[1]));
	});
	parent.once("error", reject);
	return Promise.resolve({ childPid: promise, parentPid: parent.pid ?? -1 });
}

function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await check()) return true;
		if (Date.now() >= deadline) return false;
		await new Promise(r => setTimeout(r, 100));
	}
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
});

describe("daemon kill", () => {
	it("frees the port: nothing accepts on it any more", async () => {
		const port = await takePort();
		const { childPid } = await startTree(port);
		await childPid;
		expect(await portOpen(port)).toBe(true);

		await kill(port);

		// The observable contract the shell's boot depends on: after kill() the
		// port must not keep accepting.
		expect(await waitFor(async () => !(await portOpen(port)))).toBe(true);
	}, 40_000);

	it("leaves no live daemon descendant behind", async () => {
		const port = await takePort();
		const { childPid } = await startTree(port);
		const daemonChildPid = await childPid;
		expect(pidAlive(daemonChildPid)).toBe(true);

		await kill(port);

		// A stranded descendant is what keeps a dead daemon's port alive.
		expect(await waitFor(async () => !pidAlive(daemonChildPid))).toBe(true);
	}, 40_000);

	it("is a no-op when nothing listens on the port", async () => {
		// The boot path calls kill() unconditionally; it must resolve fast rather
		// than wait out the escalation ladder.
		const port = await takePort();
		const started = Date.now();
		await kill(port);
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it("does not touch an unrelated process", async () => {
		const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			stdio: "ignore",
			windowsHide: true,
		});
		children.push(bystander);
		await new Promise(r => setTimeout(r, 300));
		expect(pidAlive(bystander.pid!)).toBe(true);

		// Killing an idle port must not signal anything else — the whole point
		// of the ownership/reaper work is that kills stay scoped.
		await kill(await takePort());
		expect(pidAlive(bystander.pid!)).toBe(true);
	}, 30_000);
});
