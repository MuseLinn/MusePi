import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { DaemonServer, type DaemonSessionHost } from "../src/daemon/server";
import { isolateConfigRootForTest, restoreConfigRootForTest } from "./helpers/isolate-agent-dir";

/**
 * Regression for issue #30, part 1+2: `schedule_task` defaulted its `cwd` to
 * the DAEMON's `process.cwd()`.
 *
 * A long-lived desktop daemon is launched from the install directory, so
 * every task created with a blank `cwd` (which the tool schema and the task
 * center's placeholder both document as "the current session's workspace")
 * silently landed in the install path / home directory instead of the
 * project the user was working in. Paths also went in unnormalised, so a
 * task stored as `D:/x` never grouped under the GUI's `D:\x`.
 *
 * `scheduledTaskHandle(sessionCwd)` is a pure function of the requesting
 * session's workspace, so it is driven directly here — no session boot.
 *
 * The cron store follows the shared dirs resolver, so this suite isolates
 * the CONFIG ROOT (`isolateConfigRootForTest`) — the `upsert` calls below
 * persist through `saveCronTasks`, and an unisolated run seeds throwaway
 * tasks ("a"/"b") into the developer's real `~/.musepi/crons.json`.
 */

function makeServer(): DaemonServer {
	const host = {
		cwd: () => process.cwd(),
		get: () => undefined,
		snapshot: async () => ({ entries: [], state: {} }),
		setCollabToolProvider: () => {},
		setScheduledTaskProvider: () => {},
		setOnExtensionNotification: () => {},
	} as unknown as DaemonSessionHost;
	return new DaemonServer(host);
}

const SESSION_CWD = path.join(os.tmpdir(), "musepi-issue30-workspace");

describe("issue #30 — schedule_task cwd defaults to the session workspace", () => {
	let configRoot = "";

	beforeAll(async () => {
		configRoot = await isolateConfigRootForTest("issue30-config-");
	});

	afterAll(async () => {
		await restoreConfigRootForTest(configRoot);
	});

	test("blank cwd resolves to the session workspace, not process.cwd()", async () => {
		const handle = makeServer().scheduledTaskHandle(SESSION_CWD);
		const task = await handle.upsert({
			name: "nightly",
			prompt: "run the suite",
			schedule: { kind: "daily", time: "03:00" },
		});
		expect(task.cwd).toBe(path.resolve(SESSION_CWD));
		expect(task.cwd).not.toBe(process.cwd());
	});

	test("whitespace-only cwd is treated as blank", async () => {
		const handle = makeServer().scheduledTaskHandle(SESSION_CWD);
		const task = await handle.upsert({
			name: "nightly",
			prompt: "run the suite",
			schedule: { kind: "daily", time: "03:00" },
			cwd: "   ",
		});
		expect(task.cwd).toBe(path.resolve(SESSION_CWD));
	});

	test("an explicit cwd is honoured and normalised", async () => {
		const handle = makeServer().scheduledTaskHandle(SESSION_CWD);
		const explicit = path.join(os.tmpdir(), "other", "..", "other-project");
		const task = await handle.upsert({
			name: "nightly",
			prompt: "run the suite",
			schedule: { kind: "cron", cron: "0 * * * *" },
			cwd: explicit,
		});
		expect(task.cwd).toBe(path.resolve(explicit));
	});

	test("defaultCwd() reports the session workspace", () => {
		const handle = makeServer().scheduledTaskHandle(SESSION_CWD);
		expect(handle.defaultCwd()).toBe(path.resolve(SESSION_CWD));
	});

	test("forward slashes normalise to native separators so GUI grouping matches", async () => {
		const handle = makeServer().scheduledTaskHandle(SESSION_CWD);
		// The GUI records projects with native separators; a forward-slash
		// task must fold onto the same key or the task center splits one
		// project into two groups.
		const forward = SESSION_CWD.split(path.sep).join("/");
		const task = await handle.upsert({
			name: "nightly",
			prompt: "run the suite",
			schedule: { kind: "daily", time: "03:00" },
			cwd: forward,
		});
		expect(task.cwd).toBe(path.resolve(SESSION_CWD));
	});

	test("two sessions in different workspaces get their own defaults", async () => {
		const server = makeServer();
		const a = await server.scheduledTaskHandle(path.join(os.tmpdir(), "ws-a")).upsert({
			name: "a",
			prompt: "p",
			schedule: { kind: "daily", time: "01:00" },
		});
		const b = await server.scheduledTaskHandle(path.join(os.tmpdir(), "ws-b")).upsert({
			name: "b",
			prompt: "p",
			schedule: { kind: "daily", time: "02:00" },
		});
		expect(a.cwd).toBe(path.resolve(os.tmpdir(), "ws-a"));
		expect(b.cwd).toBe(path.resolve(os.tmpdir(), "ws-b"));
	});
});
