import { afterEach, describe, expect, test, vi } from "bun:test";
import { type DaemonConnection, DaemonServer, type DaemonSessionHost } from "../../src/daemon/server";
import * as statsModule from "../../src/session/shell-minimizer-stats";

const conn = { id: "test" } as unknown as DaemonConnection;

afterEach(() => {
	vi.restoreAllMocks();
});

describe("settings.shellMinimizerStats RPC", () => {
	test("returns the aggregate from the stats owner", async () => {
		const stats = {
			totalCommands: 2,
			totalInputBytes: 3000,
			totalOutputBytes: 1250,
			totalSavedBytes: 1750,
			savingsPct: (1750 / 3000) * 100,
			byFilter: [{ filter: "git", commands: 2, inputBytes: 3000, outputBytes: 1250, savedBytes: 1750 }],
		};
		const read = vi.spyOn(statsModule, "readShellMinimizerStats").mockResolvedValue(stats);
		const host = {
			cwd: () => "/tmp",
			setCollabToolProvider: () => {},
			setScheduledTaskProvider: () => {},
			setOnExtensionNotification: () => {},
		} as unknown as DaemonSessionHost;
		const server = new DaemonServer(host);

		expect(await server.handle("settings.shellMinimizerStats", {}, conn)).toEqual(stats);
		expect(read).toHaveBeenCalledTimes(1);
	});
});
