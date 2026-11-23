import { describe, expect, it } from "bun:test";
import {
	RELEASE_TAG_LOG,
	decideTuiReleaseRecovery,
	isRecoverableReleaseTag,
	recoverTuiRelease,
} from "./ci-tui-release-recover";

function job(name: string, status: string, conclusion: string | null, id = 1) {
	return { id, name, status, conclusion };
}

function run(overrides: {
	id?: number;
	event?: string;
	status?: string;
	jobs: ReturnType<typeof job>[];
	name?: string;
}) {
	return {
		id: overrides.id ?? 10,
		name: overrides.name ?? "CI",
		event: overrides.event ?? "push",
		status: overrides.status ?? "completed",
		html_url: `https://example.test/run/${overrides.id ?? 10}`,
		jobs: overrides.jobs,
	};
}

const metadata = (id: number, status = "completed", conclusion: string | null = "success") =>
	job("Resolve release metadata", status, conclusion, id);
const publish = (status: string, conclusion: string | null) => job("Publish GitHub release", status, conclusion, 90);
const binary = (conclusion: string | null, status = "completed") =>
	job(
		conclusion === "skipped" ? "Release binary: ${{ matrix.target_id }}" : "Release binary: linux-x64",
		status,
		conclusion,
		80,
	);

describe("decideTuiReleaseRecovery", () => {
	it("dispatches when the main push finished without publishing TUI assets", () => {
		const decision = decideTuiReleaseRecovery(
			[
				run({
					jobs: [metadata(1), binary("skipped"), publish("completed", "skipped")],
				}),
			],
			new Map([[1, "HEAD is not a release\n"]]),
		);
		expect(decision.action).toBe("dispatch");
	});

	it("dispatches when this commit has no CI run", () => {
		expect(decideTuiReleaseRecovery([], new Map()).action).toBe("dispatch");
	});

	it("ignores a pull request run for the same commit", () => {
		const decision = decideTuiReleaseRecovery(
			[
				run({
					event: "pull_request",
					status: "in_progress",
					jobs: [metadata(1, "queued", null)],
				}),
			],
			new Map(),
		);
		expect(decision.action).toBe("dispatch");
	});

	it("skips when the release run already published", () => {
		const decision = decideTuiReleaseRecovery(
			[run({ jobs: [metadata(1), binary("success"), publish("completed", "success")] })],
			new Map(),
		);
		expect(decision.action).toBe("skip");
		expect(decision.reason).toContain("already published");
	});

	it("skips when a release upload is in progress", () => {
		const decision = decideTuiReleaseRecovery(
			[run({ status: "in_progress", jobs: [metadata(1), binary("success"), publish("in_progress", null)] })],
			new Map(),
		);
		expect(decision.action).toBe("skip");
		expect(decision.reason).toContain("is publishing");
	});

	it("skips a failed upload instead of starting a second publish", () => {
		const decision = decideTuiReleaseRecovery(
			[run({ jobs: [metadata(1), binary("success"), publish("completed", "failure")] })],
			new Map(),
		);
		expect(decision.action).toBe("skip");
		expect(decision.reason).toContain("failed while publishing");
	});

	it("skips when the metadata log says this in-progress run is the release", () => {
		const decision = decideTuiReleaseRecovery(
			[
				run({
					status: "in_progress",
					jobs: [metadata(7), binary("skipped", "queued"), publish("queued", null)],
				}),
			],
			new Map([[7, `HEAD carries release tag v0.7.8; this run builds and publishes the release.\n`]]),
		);
		expect(decision.action).toBe("skip");
		expect(decision.reason).toContain("release run");
	});

	it("skips a finished release run whose binaries never started", () => {
		const decision = decideTuiReleaseRecovery(
			[run({ jobs: [metadata(4), binary("skipped"), publish("completed", "skipped")] })],
			new Map([[4, `${RELEASE_TAG_LOG} v0.7.8\n`]]),
		);
		expect(decision.action).toBe("skip");
	});

	it("waits while release metadata has not finished", () => {
		const decision = decideTuiReleaseRecovery(
			[run({ status: "in_progress", jobs: [metadata(3, "in_progress", null)] })],
			new Map(),
		);
		expect(decision.action).toBe("wait");
	});

	it("dispatches a late tag while an unrelated main run is still testing", () => {
		const decision = decideTuiReleaseRecovery(
			[
				run({
					status: "in_progress",
					jobs: [metadata(5), binary("skipped", "queued"), publish("queued", null)],
				}),
			],
			new Map([[5, "ordinary main push\n"]]),
		);
		expect(decision.action).toBe("dispatch");
	});

	it("prefers a known release run over another run that is still resolving", () => {
		const decision = decideTuiReleaseRecovery(
			[
				run({
					id: 1,
					status: "in_progress",
					jobs: [metadata(11), publish("completed", "skipped")],
				}),
				run({
					id: 2,
					status: "in_progress",
					jobs: [metadata(12, "in_progress", null)],
				}),
			],
			new Map([[11, `${RELEASE_TAG_LOG} v0.7.8\n`]]),
		);
		expect(decision.action).toBe("skip");
		expect(decision.reason).toContain("run/1");
	});
});

describe("recoverTuiRelease", () => {
	const base = {
		sha: "abc123",
		repository: "MuseLinn/MusePi",
		token: "test-token",
		timeoutMs: 0,
		pollIntervalMs: 1,
		sleepImpl: async () => {},
	};

	function route(handlers: {
		runs: unknown;
		jobs?: unknown;
		log?: string;
		onDispatch?: (body: string) => void;
	}): typeof fetch {
		return (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("/dispatches")) {
				handlers.onDispatch?.(String(init?.body ?? ""));
				return new Response(null, { status: 204 });
			}
			if (url.includes("/jobs/") && url.endsWith("/logs")) {
				return new Response(handlers.log ?? "ordinary main push\n", { status: 200 });
			}
			if (url.includes("/jobs?")) {
				return Response.json(handlers.jobs ?? { jobs: [] });
			}
			if (url.includes("/actions/runs?")) {
				return Response.json(handlers.runs);
			}
			return new Response(`unexpected ${url}`, { status: 500 });
		}) as typeof fetch;
	}

	it("dispatches ci.yml on a version tag when the main push did not publish", async () => {
		let body = "";
		const decision = await recoverTuiRelease({
			...base,
			tag: "v0.7.8",
			fetchImpl: route({
				runs: {
					workflow_runs: [
						{
							id: 10,
							name: "CI",
							event: "push",
							status: "completed",
							html_url: "https://example.test/run/10",
						},
					],
				},
				jobs: {
					jobs: [
						job("Resolve release metadata", "completed", "success", 1),
						job("Release binary: ${{ matrix.target_id }}", "completed", "skipped", 2),
						job("Publish GitHub release", "completed", "skipped", 3),
					],
				},
				log: "not a release\n",
				onDispatch: value => {
					body = value;
				},
			}),
		});
		expect(decision.action).toBe("dispatch");
		expect(JSON.parse(body)).toEqual({ ref: "v0.7.8" });
	});

	it("does not dispatch the official release's tag push", async () => {
		let dispatched = false;
		const decision = await recoverTuiRelease({
			...base,
			tag: "v0.7.8",
			fetchImpl: route({
				runs: {
					workflow_runs: [
						{
							id: 11,
							name: "CI",
							event: "push",
							status: "in_progress",
							html_url: "https://example.test/run/11",
						},
					],
				},
				jobs: {
					jobs: [job("Resolve release metadata", "completed", "success", 4)],
				},
				log: "HEAD carries release tag v0.7.8; this run builds and publishes the release.\n",
				onDispatch: () => {
					dispatched = true;
				},
			}),
		});
		expect(decision.action).toBe("skip");
		expect(dispatched).toBe(false);
	});

	it("stops waiting without dispatching when metadata never resolves", async () => {
		let dispatched = false;
		const decision = await recoverTuiRelease({
			...base,
			tag: "v0.7.8",
			fetchImpl: route({
				runs: {
					workflow_runs: [
						{
							id: 12,
							name: "CI",
							event: "push",
							status: "in_progress",
							html_url: "https://example.test/run/12",
						},
					],
				},
				jobs: {
					jobs: [job("Resolve release metadata", "in_progress", null, 6)],
				},
				onDispatch: () => {
					dispatched = true;
				},
			}),
		});
		expect(decision.action).toBe("skip");
		expect(dispatched).toBe(false);
	});

	it("does not dispatch while the atomic release run is not listed yet", async () => {
		let dispatched = false;
		const decision = await recoverTuiRelease({
			...base,
			tag: "v0.7.8",
			emptyRunGraceMs: 60_000,
			fetchImpl: route({
				runs: { workflow_runs: [] },
				onDispatch: () => {
					dispatched = true;
				},
			}),
		});
		expect(decision.action).toBe("skip");
		expect(dispatched).toBe(false);
	});

	it("dispatches after the grace period when the commit never had a CI run", async () => {
		let now = 0;
		let dispatched = false;
		const decision = await recoverTuiRelease({
			...base,
			tag: "v0.7.8",
			timeoutMs: 120_000,
			emptyRunGraceMs: 1_000,
			nowImpl: () => now,
			sleepImpl: async () => {
				now = 1_000;
			},
			fetchImpl: route({
				runs: { workflow_runs: [] },
				onDispatch: () => {
					dispatched = true;
				},
			}),
		});
		expect(decision.action).toBe("dispatch");
		expect(dispatched).toBe(true);
	});

	it("rejects a tag CI would not treat as a release", async () => {
		const decision = await recoverTuiRelease({
			...base,
			tag: "nightly",
			fetchImpl: (() => {
				throw new Error("no API call");
			}) as typeof fetch,
		});
		expect(decision.action).toBe("skip");
		expect(isRecoverableReleaseTag("v0.7.8-beta.1")).toBe(true);
		expect(isRecoverableReleaseTag("v")).toBe(false);
	});
});
