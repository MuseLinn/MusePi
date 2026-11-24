import { describe, expect, it } from "bun:test";
import { type McpAuthFlowPort, type McpAuthOutcome, type McpAuthRequest, runMcpAuthorization } from "./mcp-auth-bridge";

function recordingPort(settle: McpAuthFlowPort["settle"]): McpAuthFlowPort & {
	started: string[];
	cancelled: string[];
} {
	const started: string[] = [];
	const cancelled: string[] = [];
	return {
		started,
		cancelled,
		async start(serverName) {
			started.push(serverName);
			return { flowId: "flow-1", authorizationUrl: "https://provider.example/authorize?state=s1" };
		},
		settle,
		cancel(flowId) {
			cancelled.push(flowId);
		},
	};
}

function errorOf(outcome: McpAuthOutcome): string {
	return outcome.status === "success" ? "" : (outcome.error ?? "");
}

describe("runMcpAuthorization", () => {
	it("announces the card, returns success, and clears it once the grant lands", async () => {
		const requests: McpAuthRequest[] = [];
		const ends: { requestId: string; outcome: McpAuthOutcome }[] = [];
		const port = recordingPort(async () => ({ status: "success" }));

		const outcome = await runMcpAuthorization({
			serverName: "github",
			port,
			emitRequest: record => requests.push(record),
			emitEnd: (requestId, settled) => ends.push({ requestId, outcome: settled }),
		});

		expect(outcome).toEqual({ status: "success" });
		expect(port.started).toEqual(["github"]);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.serverName).toBe("github");
		expect(requests[0]?.authorizationUrl).toBe("https://provider.example/authorize?state=s1");
		expect(ends).toHaveLength(1);
		expect(ends[0]?.requestId).toBe(requests[0]?.requestId);
		expect(ends[0]?.outcome).toEqual({ status: "success" });
		expect(port.cancelled).toEqual([]);
	});

	it("cancels the flow and reports the provider's failure to the agent", async () => {
		const ends: McpAuthOutcome[] = [];
		const port = recordingPort(async () => ({ status: "error", error: "token exchange rejected" }));

		const outcome = await runMcpAuthorization({
			serverName: "github",
			port,
			emitRequest: () => {},
			emitEnd: (_requestId, settled) => ends.push(settled),
		});

		expect(outcome).toEqual({ status: "error", error: "token exchange rejected" });
		expect(ends).toEqual([{ status: "error", error: "token exchange rejected" }]);
		expect(port.cancelled).toEqual(["flow-1"]);
	});

	it("treats a user cancel as a cancelled outcome, not a success", async () => {
		const port = recordingPort(async () => ({ status: "cancelled" }));
		const ends: McpAuthOutcome[] = [];

		const outcome = await runMcpAuthorization({
			serverName: "github",
			port,
			emitRequest: () => {},
			emitEnd: (_requestId, settled) => ends.push(settled),
		});

		expect(outcome.status).toBe("cancelled");
		expect(ends[0]?.status).toBe("cancelled");
	});

	it("times out without hanging, then cancels the flow so its listener does not outlive the card", async () => {
		const endStates: McpAuthOutcome[] = [];
		const port = recordingPort(() => new Promise(() => {}));

		const outcome = await runMcpAuthorization({
			serverName: "github",
			port,
			emitRequest: () => {},
			emitEnd: (_requestId, settled) => endStates.push(settled),
			timeoutMs: 5,
		});

		expect(errorOf(outcome)).toContain("not completed");
		expect(endStates).toEqual([outcome]);
		expect(port.cancelled).toEqual(["flow-1"]);
	});

	it("surfaces a settle rejection and still cancels the flow", async () => {
		const port = recordingPort(async () => {
			throw new Error("daemon shutting down");
		});

		const outcome = await runMcpAuthorization({
			serverName: "github",
			port,
			emitRequest: () => {},
			emitEnd: () => {},
		});

		expect(outcome).toEqual({ status: "error", error: "daemon shutting down" });
		expect(port.cancelled).toEqual(["flow-1"]);
	});

	it("clears the card and abandons the flow when the turn is stopped", async () => {
		const ends: McpAuthOutcome[] = [];
		const port = recordingPort(() => new Promise(() => {}));
		const controller = new AbortController();

		const pending = runMcpAuthorization({
			serverName: "github",
			port,
			emitRequest: () => controller.abort(),
			emitEnd: (_requestId, settled) => ends.push(settled),
			signal: controller.signal,
		});
		const outcome = await pending;

		expect(outcome).toEqual({ status: "cancelled" });
		expect(ends).toEqual([{ status: "cancelled" }]);
		expect(port.cancelled).toEqual(["flow-1"]);
	});

	it("announces nothing when no flow can start", async () => {
		let announced = 0;
		const port: McpAuthFlowPort = {
			async start() {
				throw new Error("server has no url");
			},
			settle: async () => ({ status: "success" }),
			cancel: () => {},
		};

		await expect(
			runMcpAuthorization({
				serverName: "broken",
				port,
				emitRequest: () => {
					announced += 1;
				},
				emitEnd: () => {},
			}),
		).rejects.toThrow("server has no url");
		expect(announced).toBe(0);
	});
});
