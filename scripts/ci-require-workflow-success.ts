interface WorkflowRun {
	id: number;
	name: string;
	status: string;
	conclusion: string | null;
	html_url: string;
}

interface RequireSuccessfulWorkflowOptions {
	workflow: string;
	sha: string;
	repository: string;
	token: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	pollIntervalMs?: number;
	sleepImpl?: (ms: number) => Promise<void>;
}

export async function requireSuccessfulWorkflow({
	workflow,
	sha,
	repository,
	token,
	fetchImpl = fetch,
	timeoutMs = 90 * 60_000,
	pollIntervalMs = 30_000,
	sleepImpl = Bun.sleep,
}: RequireSuccessfulWorkflowOptions): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const response = await fetchImpl(
			`https://api.github.com/repos/${repository}/actions/runs?head_sha=${encodeURIComponent(sha)}&event=push&per_page=100`,
			{
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${token}`,
					"X-GitHub-Api-Version": "2022-11-28",
				},
			},
		);
		if (!response.ok) throw new Error(`GitHub Actions lookup failed with HTTP ${response.status}`);
		const payload = (await response.json()) as { workflow_runs: WorkflowRun[] };
		const run = payload.workflow_runs.find(candidate => candidate.name === workflow);
		if (!run) throw new Error(`No ${workflow} run found for ${repository}@${sha}`);
		if (run.status === "completed") {
			if (run.conclusion !== "success") {
				throw new Error(`${workflow} run for ${sha} concluded ${run.conclusion ?? "unknown"}: ${run.html_url}`);
			}
			return run.html_url;
		}
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for ${workflow} run for ${sha}: ${run.html_url}`);
		}
		console.log(`Waiting for ${workflow} run to complete: ${run.html_url}`);
		await sleepImpl(pollIntervalMs);
	}
}

if (import.meta.main) {
	const workflow = process.argv[2] ?? "CI";
	const sha = process.argv[3] ?? Bun.env.GITHUB_SHA;
	const repository = Bun.env.GITHUB_REPOSITORY;
	const token = Bun.env.GH_TOKEN ?? Bun.env.GITHUB_TOKEN;
	if (!sha || !repository || !token) {
		throw new Error(
			"Usage: GH_TOKEN=<token> GITHUB_REPOSITORY=<owner/repo> bun scripts/ci-require-workflow-success.ts [CI] <sha>",
		);
	}
	const url = await requireSuccessfulWorkflow({ workflow, sha, repository, token });
	console.log(`${workflow} passed for ${sha}: ${url}`);
}
