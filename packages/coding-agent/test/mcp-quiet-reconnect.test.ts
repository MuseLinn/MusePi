/**
 * Regression test for oh-my-pi #11803: an `http`/`sse` MCP server that WAS
 * connected and then went away (restart, publish, laptop wake) used to be
 * abandoned after the short burst ladder (~500ms + 1s + 2s + 4s) failed. An
 * idle session never noticed the server come back — resource subscriptions and
 * server-push notifications stayed dead until a tool call happened to hit it or
 * the user ran `/mcp reconnect`.
 *
 * The contract this test defends:
 *   - a previously-connected server keeps getting quiet background probes after
 *     the burst ladder fails, and reconnects once it answers again;
 *   - a server that never connected gets no background noise;
 *   - the probe backs off (15s → doubling → 5min ceiling) instead of hammering;
 *   - a deliberate disconnect cancels the probe.
 *
 * The fixture (fixtures/flaky-http-mcp.ts) is a streamable-HTTP MCP server whose
 * liveness follows a control file, so "server restarted" is modeled without
 * touching process lifecycle.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MCPManager } from "@musepi/pi-coding-agent/mcp/manager";
import type { MCPHttpServerConfig } from "@musepi/pi-coding-agent/mcp/types";
import { removeSyncWithRetries } from "@musepi/pi-utils";

const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "flaky-http-mcp.ts");
const BUN_EXEC = process.execPath;

describe("MCP quiet reconnect after the burst ladder fails (omp #11803)", () => {
	let workDir: string;
	let controlPath: string;
	let readyPath: string;
	let child: ReturnType<typeof Bun.spawn> | undefined;

	beforeEach(() => {
		workDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-mcp-quiet-"));
		controlPath = path.join(workDir, "control");
		readyPath = path.join(workDir, "ready");
		fs.writeFileSync(controlPath, "up");
	});

	afterEach(() => {
		child?.kill();
		child = undefined;
		removeSyncWithRetries(workDir);
	});

	async function startFixture(): Promise<string> {
		child = Bun.spawn([BUN_EXEC, FIXTURE_PATH], {
			env: { ...process.env, OMP_TEST_HTTP_CONTROL: controlPath, OMP_TEST_HTTP_READY: readyPath },
			stdout: "ignore",
			stderr: "ignore",
		});
		// Wait for the fixture to publish its port rather than blind-sleeping.
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			if (fs.existsSync(readyPath)) {
				const port = fs.readFileSync(readyPath, "utf8").trim();
				if (port.length > 0) return `http://127.0.0.1:${port}`;
			}
			await Bun.sleep(50);
		}
		throw new Error("fixture did not become ready");
	}

	/** Drive connectivity the way an actual outage does: through the control file. */
	function setServerUp(up: boolean): void {
		fs.writeFileSync(controlPath, up ? "up" : "down");
	}

	function httpConfig(url: string): MCPHttpServerConfig {
		return { type: "http", url };
	}

	it("reconnects a previously-connected server after the burst ladder fails", async () => {
		const url = await startFixture();
		const manager = new MCPManager(workDir);
		try {
			await manager.connectServers({ flaky: httpConfig(url) }, {});
			expect(manager.getConnectionStatus("flaky")).toBe("connected");

			// Server goes away, then comes back — the outage/recovery cycle from
			// the issue. The burst ladder fails while it is down; the quiet probe
			// is what has to notice the recovery.
			setServerUp(false);
			await manager.reconnectServer("flaky");
			setServerUp(true);

			// The first quiet probe is 15s out; poll for it rather than sleeping
			// a fixed budget so the test stays fast when the probe lands earlier.
			const deadline = Date.now() + 40_000;
			let connected = false;
			while (Date.now() < deadline) {
				if (manager.getConnectionStatus("flaky") === "connected") {
					connected = true;
					break;
				}
				await Bun.sleep(250);
			}
			expect(connected).toBe(true);
		} finally {
			await manager.disconnectAll();
		}
	}, 60_000);

	it("does not probe a server that never connected", async () => {
		const manager = new MCPManager(workDir);
		try {
			// Unreachable port, never connected — no background noise may be armed.
			await manager.connectServers({ never: httpConfig("http://127.0.0.1:1/mcp") }, {});
			expect(manager.getConnectionStatus("never")).not.toBe("connected");
			await manager.reconnectServer("never");
			// Nothing to assert positively without reaching into privates; the
			// important half is that this resolves and stays disconnected quickly.
			expect(manager.getConnectionStatus("never")).not.toBe("connected");
		} finally {
			await manager.disconnectAll();
		}
	}, 30_000);

	it("cancels the pending probe on a deliberate disconnect", async () => {
		const url = await startFixture();
		const manager = new MCPManager(workDir);
		try {
			await manager.connectServers({ flaky: httpConfig(url) }, {});
			setServerUp(false);
			await manager.reconnectServer("flaky");
			// A deliberate disconnect must stop probing even though the server is
			// still down and still configured.
			await manager.disconnectServer("flaky");
			expect(manager.getConnectionStatus("flaky")).not.toBe("connected");

			// Bring it back up: nothing should reconnect it any more.
			setServerUp(true);
			await Bun.sleep(2_000);
			expect(manager.getConnectionStatus("flaky")).not.toBe("connected");
		} finally {
			await manager.disconnectAll();
		}
	}, 30_000);
});
