import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import * as net from "node:net";
// daemon.cjs lives outside tsconfig include (electron/) and has no types.
// @ts-expect-error — untyped CJS module (electron/, outside tsconfig include)
import { kill, portOpen } from "../electron/daemon.cjs";

function bindChild(port: number): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${port}, "127.0.0.1")`], {
		stdio: "ignore",
	});
	child.on("error", reject);
	child.on("exit", () => reject(new Error("child exited before bind")));
	const deadline = Date.now() + 4000;
	const poll = async () => {
		if (await portOpen(port)) {
			child.removeAllListeners("exit");
			resolve();
			return;
		}
		if (Date.now() > deadline) {
			child.kill();
			reject(new Error("child never bound port"));
			return;
		}
		setTimeout(poll, 100);
	};
	void poll();
	return promise;
}

/**
 * kill() contract: it must resolve the LISTENING pid (Windows: netstat -ano;
 * macOS/Linux: lsof) and stop the process so the port frees. Regression for
 * the Windows bug where listenerPid always resolved null (lsof missing) →
 * kill() silently no-op'd → daemon-restart/daemon-start spawned against a
 * live port → EADDRINUSE startup crash.
 */
describe("daemon.cjs kill (listener pid resolution)", () => {
	it("frees a port held by another process", async () => {
		const port = 18999;
		await bindChild(port);
		try {
			expect(await portOpen(port)).toBe(true);
			await kill(port);
			expect(await portOpen(port)).toBe(false);
		} finally {
			await kill(port).catch(() => {});
		}
	});

	it("resolves immediately when nothing listens on the port", async () => {
		// Pick an ephemeral port that is free right now.
		const port = await new Promise<number>(resolve => {
			const srv = net.createServer();
			srv.listen(0, "127.0.0.1", () => {
				const p = (srv.address() as net.AddressInfo).port;
				srv.close(() => resolve(p));
			});
		});
		await expect(kill(port)).resolves.toBeUndefined();
	});
});
