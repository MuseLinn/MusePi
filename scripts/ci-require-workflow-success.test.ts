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

	it("rejects a CI run that is still pending instead of publishing early", async () => {
		await expect(
			requireSuccessfulWorkflow({
				...base,
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
		).rejects.toThrow("in_progress");
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
