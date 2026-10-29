import { describe, expect, it } from "bun:test";
import { requireSuccessfulWorkflow } from "./ci-require-workflow-success";

function response(runs: unknown[]): Response {
	return Response.json({ workflow_runs: runs });
}

const base = {
	workflow: "CI",
	sha: "deadbeef",
	repository: "MuseLinn/MusePi",
	token: "test-token",
};

describe("requireSuccessfulWorkflow", () => {
	it("accepts a completed successful CI run for the exact commit", async () => {
		const url = await requireSuccessfulWorkflow({
			...base,
			fetchImpl: async () =>
				response([
					{
						id: 42,
						name: "CI",
						status: "completed",
						conclusion: "success",
						html_url: "https://example.test/run/42",
					},
				]),
		});
		expect(url).toBe("https://example.test/run/42");
	});

	it("waits for a pending CI run and publishes only after it succeeds", async () => {
		let calls = 0;
		let sleeps = 0;
		const url = await requireSuccessfulWorkflow({
			...base,
			pollIntervalMs: 1,
			sleepImpl: async () => {
				sleeps++;
			},
			fetchImpl: async () => {
				calls++;
				const completed = calls > 1;
				return response([
					{
						id: 42,
						name: "CI",
						status: completed ? "completed" : "in_progress",
						conclusion: completed ? "success" : null,
						html_url: "https://example.test/run/42",
					},
				]);
			},
		});

		expect(url).toBe("https://example.test/run/42");
		expect(calls).toBe(2);
		expect(sleeps).toBe(1);
	});

	it("times out instead of waiting forever for a pending CI run", async () => {
		await expect(
			requireSuccessfulWorkflow({
				...base,
				timeoutMs: 0,
				fetchImpl: async () =>
					response([
						{
							id: 42,
							name: "CI",
							status: "in_progress",
							conclusion: null,
							html_url: "https://example.test/run/42",
						},
					]),
			}),
		).rejects.toThrow("Timed out");
	});

	it("rejects a completed failed CI run", async () => {
		await expect(
			requireSuccessfulWorkflow({
				...base,
				fetchImpl: async () =>
					response([
						{
							id: 42,
							name: "CI",
							status: "completed",
							conclusion: "failure",
							html_url: "https://example.test/run/42",
						},
					]),
			}),
		).rejects.toThrow("failure");
	});

	it("rejects a commit with no matching CI run", async () => {
		await expect(requireSuccessfulWorkflow({ ...base, fetchImpl: async () => response([]) })).rejects.toThrow(
			"No CI run",
		);
	});
});
