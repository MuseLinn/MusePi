export interface GhResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

export type GhRunner = (cwd: string, args: string[], timeoutMs?: number) => Promise<GhResult>;

export async function commentOnGithub(
	cwd: string,
	kind: "issue" | "pr",
	number: number,
	body: string,
	run: GhRunner,
): Promise<{ ok?: boolean; error?: string }> {
	if (!Number.isInteger(number) || number <= 0) return { error: "number required" };
	const comment = body.trim();
	if (!comment) return { error: "comment required" };
	const res = await run(cwd, [kind, "comment", String(number), "--body", comment]);
	if (res.exitCode === null) return { error: "gh CLI not installed" };
	if (res.exitCode !== 0) return { error: res.stderr.trim() || `gh ${kind} comment failed` };
	return { ok: true };
}

export function normalizeGithubReviewers(
	requests: { login?: string; slug?: string; name?: string }[] | undefined,
): { login: string }[] {
	return (requests ?? [])
		.map(request => ({ login: request.login ?? request.slug ?? request.name ?? "" }))
		.filter(request => request.login !== "");
}
