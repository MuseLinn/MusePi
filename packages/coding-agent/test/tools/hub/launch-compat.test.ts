import { afterEach, describe, expect, it, vi } from "bun:test";
import type { DaemonBrokerClient } from "../../../src/launch/client";
import * as daemonClient from "../../../src/launch/client";
import type { DaemonRpcResult } from "../../../src/launch/protocol";
import type { ToolSession } from "../../../src/tools";
import { executeLaunch } from "../../../src/tools/hub/launch";

afterEach(() => {
	vi.restoreAllMocks();
});

class CleanExitWorker extends EventTarget {
	postMessage(): void {
		this.dispatchEvent(new Event("close"));
	}

	terminate(): void {}
}

describe("launch broker protocol compatibility", () => {
	it("replays raw terminal text returned by an already-running legacy broker", async () => {
		const projectDir = process.cwd();
		const legacyResult = {
			op: "logs",
			name: "web",
			text: "ready",
			terminalText: "old\r\x1b[2K\x1b[1;32mready\x1b[0m",
			cursor: 42,
			timedOut: false,
			state: "running",
		} as unknown as DaemonRpcResult;
		const client = {
			projectDir,
			request: async () => legacyResult,
			close() {},
		} satisfies DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);

		const result = await executeLaunch({ cwd: projectDir } as ToolSession, {
			op: "logs",
			name: "web",
			lines: 10,
			head: false,
		});

		expect(result.details?.terminalRows).toEqual(["\x1b[0m\x1b[1;38;5;2mready"]);
	});

	it("keeps sanitized legacy logs when optional terminal replay fails", async () => {
		const projectDir = process.cwd();
		const legacyResult = {
			op: "logs",
			name: "web",
			text: "ready",
			terminalText: "raw",
			cursor: 42,
			timedOut: false,
			state: "running",
		} as unknown as DaemonRpcResult;
		const client = {
			projectDir,
			request: async () => legacyResult,
			close() {},
		} satisfies DaemonBrokerClient;
		vi.spyOn(daemonClient, "daemonClientForProject").mockResolvedValue(client);

		const originalWorkerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
		expect(originalWorkerDescriptor).toBeDefined();
		Object.defineProperty(globalThis, "Worker", { configurable: true, value: CleanExitWorker });
		try {
			const result = await executeLaunch({ cwd: projectDir } as ToolSession, {
				op: "logs",
				name: "web",
				lines: 10,
				head: false,
			});
			expect(result.content).toEqual([{ type: "text", text: "ready\n[web: running; cursor=42]" }]);
			expect(result.details?.terminalRows).toBeUndefined();
		} finally {
			if (originalWorkerDescriptor) {
				Object.defineProperty(globalThis, "Worker", originalWorkerDescriptor);
			} else {
				Reflect.deleteProperty(globalThis, "Worker");
			}
		}
		expect(Object.getOwnPropertyDescriptor(globalThis, "Worker")).toEqual(originalWorkerDescriptor);
	});
});
