/**
 * Publish standalone TUI binaries when a `v*` tag is pushed onto a commit
 * already on main.
 *
 * `scripts/release.ts` pushes the version-bump commit and its tag together.
 * That main push is the release run: `ci.yml` sees the tag on HEAD and
 * `release_github` uploads the binaries. A tag pushed later does not push
 * main again, so that workflow never starts. Dispatching `workflow_dispatch`
 * on the tag makes the same workflow treat the ref as a release and run
 * `release_gate` before uploading.
 *
 * The dispatch is skipped when a CI run for this commit is already the
 * release run, including one that failed its gate or its upload. A second
 * run would build the same binaries and upload them again. Re-run the
 * existing workflow instead.
 */

interface WorkflowJob {
	id: number;
	name: string;
	status: string;
	conclusion: string | null;
}

interface WorkflowRun {
	id: number;
	name: string;
	event: string;
	status: string;
	html_url: string;
	jobs: WorkflowJob[];
}

export interface RecoveryDecision {
	action: "dispatch" | "skip" | "wait";
	reason: string;
}

const PUBLISH_JOB = "Publish GitHub release";
const METADATA_JOB = "Resolve release metadata";
const BINARY_PREFIX = "Release binary:";
/** Logged by `release_metadata` only when this run will publish. */
export const RELEASE_TAG_LOG = "HEAD carries release tag";

type RunClass = "published" | "publishing" | "publish-failed" | "release-attempt" | "not-release" | "unknown";

function binaryJobs(run: WorkflowRun): WorkflowJob[] {
	return run.jobs.filter(job => job.name.startsWith(BINARY_PREFIX));
}

function releaseBuildStarted(run: WorkflowRun): boolean {
	return binaryJobs(run).some(
		job => job.conclusion === "success" || job.conclusion === "failure" || job.conclusion === "cancelled",
	);
}

function classifyRun(run: WorkflowRun, logs: ReadonlyMap<number, string>): RunClass {
	const publish = run.jobs.find(job => job.name === PUBLISH_JOB);
	if (publish?.conclusion === "success") return "published";
	if (publish?.status === "in_progress") return "publishing";
	if (publish?.conclusion === "failure") return "publish-failed";
	if (releaseBuildStarted(run)) return "release-attempt";

	const metadata = run.jobs.find(job => job.name === METADATA_JOB);
	if (metadata?.status !== "completed") {
		return run.status === "completed" ? "not-release" : "unknown";
	}
	const log = logs.get(metadata.id);
	if (log === undefined) return "unknown";
	return log.includes(RELEASE_TAG_LOG) ? "release-attempt" : "not-release";
}

export function decideTuiReleaseRecovery(
	runs: readonly WorkflowRun[],
	logs: ReadonlyMap<number, string>,
): RecoveryDecision {
	const relevant = runs.filter(run => run.name === "CI" && run.event !== "pull_request");
	const classified = relevant.map(run => ({ run, kind: classifyRun(run, logs) }));
	const described = (kind: RunClass) => classified.find(item => item.kind === kind);

	const published = described("published");
	if (published) {
		return {
			action: "skip",
			reason: `CI run ${published.run.id} already published the TUI assets: ${published.run.html_url}`,
		};
	}
	const publishing = described("publishing");
	if (publishing) {
		return {
			action: "skip",
			reason: `CI run ${publishing.run.id} is publishing the TUI assets: ${publishing.run.html_url}`,
		};
	}
	const failed = described("publish-failed");
	if (failed) {
		return {
			action: "skip",
			reason:
				`CI run ${failed.run.id} failed while publishing the TUI assets. ` +
				`Re-run that workflow instead of starting another: ${failed.run.html_url}`,
		};
	}
	const attempt = described("release-attempt");
	if (attempt) {
		return {
			action: "skip",
			reason:
				`CI run ${attempt.run.id} is the release run for this commit and publishes the TUI assets itself: ` +
				attempt.run.html_url,
		};
	}
	const pending = described("unknown");
	if (pending) {
		return {
			action: "wait",
			reason: `Waiting until CI run ${pending.run.id} resolves whether this commit is a release: ${pending.run.html_url}`,
		};
	}
	return {
		action: "dispatch",
		reason: "No CI run for this commit published standalone TUI binaries. Dispatching CI on the tag.",
	};
}

export function isRecoverableReleaseTag(tag: string): boolean {
	return /^v\d/.test(tag);
}

interface RecoverOptions {
	sha: string;
	tag: string;
	repository: string;
	token: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	pollIntervalMs?: number;
	/** How long to wait when the API lists no CI run, so an atomic release push is not dispatched twice. */
	emptyRunGraceMs?: number;
	sleepImpl?: (ms: number) => Promise<void>;
	nowImpl?: () => number;
}

async function readPages<T>(
	fetchImpl: typeof fetch,
	url: string,
	key: string,
	headers: Record<string, string>,
	label: string,
): Promise<T[]> {
	const items: T[] = [];
	for (let page = 1; page <= 5; page++) {
		const joiner = url.includes("?") ? "&" : "?";
		const response = await fetchImpl(`${url}${joiner}page=${page}&per_page=100`, { headers });
		const payload = await readJson<Record<string, T[] | undefined>>(response, label);
		const batch = payload[key] ?? [];
		items.push(...batch);
		if (batch.length < 100) break;
	}
	return items;
}

async function readJson<T>(response: Response, label: string): Promise<T> {
	if (!response.ok) {
		const body = await response.text();
		throw new Error(`${label} failed with HTTP ${response.status}: ${body.slice(0, 300)}`);
	}
	return (await response.json()) as T;
}

export async function recoverTuiRelease({
	sha,
	tag,
	repository,
	token,
	fetchImpl = fetch,
	timeoutMs = 20 * 60_000,
	pollIntervalMs = 15_000,
	emptyRunGraceMs = 2 * 60_000,
	sleepImpl = Bun.sleep,
	nowImpl = Date.now,
}: RecoverOptions): Promise<RecoveryDecision> {
	if (!isRecoverableReleaseTag(tag)) {
		const decision: RecoveryDecision = {
			action: "skip",
			reason: `Tag ${tag} is not a v<version> release tag, so CI would not publish TUI assets from it.`,
		};
		console.log(decision.reason);
		return decision;
	}

	const headers = {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${token}`,
		"X-GitHub-Api-Version": "2022-11-28",
	};
	const started = nowImpl();
	const deadline = started + timeoutMs;

	for (;;) {
		const listed = await readPages<Omit<WorkflowRun, "jobs">>(
			fetchImpl,
			`https://api.github.com/repos/${repository}/actions/runs?head_sha=${encodeURIComponent(sha)}`,
			"workflow_runs",
			headers,
			"GitHub Actions lookup",
		);
		const runs: WorkflowRun[] = [];
		for (const run of listed) {
			if (run.name !== "CI" || run.event === "pull_request") continue;
			const jobs = await readPages<WorkflowJob>(
				fetchImpl,
				`https://api.github.com/repos/${repository}/actions/runs/${run.id}/jobs`,
				"jobs",
				headers,
				`Job lookup for CI run ${run.id}`,
			);
			runs.push({ ...run, jobs });
		}

		const logs = new Map<number, string>();
		for (const run of runs) {
			const metadata = run.jobs.find(job => job.name === METADATA_JOB);
			if (metadata?.status !== "completed") continue;
			const publish = run.jobs.find(job => job.name === PUBLISH_JOB);
			if (
				publish?.conclusion === "success" ||
				publish?.conclusion === "failure" ||
				publish?.status === "in_progress"
			) {
				continue;
			}
			if (releaseBuildStarted(run)) continue;
			const logResponse = await fetchImpl(
				`https://api.github.com/repos/${repository}/actions/jobs/${metadata.id}/logs`,
				{ headers },
			);
			if (!logResponse.ok) {
				const body = await logResponse.text();
				throw new Error(
					`Release-metadata log for job ${metadata.id} failed with HTTP ${logResponse.status}: ` +
						body.slice(0, 300),
				);
			}
			logs.set(metadata.id, await logResponse.text());
		}

		const decision = decideTuiReleaseRecovery(runs, logs);
		console.log(decision.reason);
		if (decision.action === "dispatch" && runs.length === 0 && nowImpl() < started + emptyRunGraceMs) {
			if (nowImpl() >= deadline) {
				console.log("No CI run is listed yet. Not dispatching, so an atomic release push is not published twice.");
				return { action: "skip", reason: decision.reason };
			}
			console.log(
				"No CI run is listed yet. Waiting before dispatching so an atomic release push is not published twice.",
			);
			await sleepImpl(pollIntervalMs);
			continue;
		}
		if (decision.action === "dispatch") {
			const response = await fetchImpl(
				`https://api.github.com/repos/${repository}/actions/workflows/ci.yml/dispatches`,
				{
					method: "POST",
					headers: { ...headers, "Content-Type": "application/json" },
					body: JSON.stringify({ ref: tag }),
				},
			);
			if (response.status !== 204) {
				const body = await response.text();
				throw new Error(`Dispatching CI on ${tag} failed with HTTP ${response.status}: ${body.slice(0, 300)}`);
			}
			return decision;
		}
		if (decision.action === "skip" || nowImpl() >= deadline) {
			if (decision.action === "wait") {
				console.log("Stopped waiting without dispatching CI, so an in-flight release run is not published twice.");
			}
			return decision.action === "wait" ? { action: "skip", reason: decision.reason } : decision;
		}
		await sleepImpl(pollIntervalMs);
	}
}

if (import.meta.main) {
	const sha = process.argv[2] ?? Bun.env.GITHUB_SHA;
	const tag = process.argv[3] ?? Bun.env.GITHUB_REF_NAME;
	const repository = Bun.env.GITHUB_REPOSITORY;
	const token = Bun.env.GH_TOKEN ?? Bun.env.GITHUB_TOKEN;
	if (!sha || !tag || !repository || !token) {
		throw new Error(
			"Usage: GH_TOKEN=<token> GITHUB_REPOSITORY=<owner/repo> bun scripts/ci-tui-release-recover.ts <sha> <tag>",
		);
	}
	await recoverTuiRelease({ sha, tag, repository, token });
}
