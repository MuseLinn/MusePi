/**
 * Pull-request visual-state helpers for the right-pane PR center.
 *
 * Pure functions only — the daemon returns gh's raw `statusCheckRollup`
 * (heterogeneous entries: CheckRun vs StatusContext), which these helpers
 * fold into the small set of states the UI renders.
 */

export type ChecksRollupState = "success" | "failure" | "pending" | null;

const FAILURE_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED", "STARTUP_FAILURE"]);
const NEUTRAL_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

/**
 * Fold gh's `statusCheckRollup` into one state: any hard failure wins;
 * otherwise any still-running entry keeps the rollup pending; an all-pass
 * (or all-neutral) rollup is success. null when the PR carries no checks
 * (array missing/empty) — the UI shows "no checks", not a green light.
 */
export function rollupCheckState(rollup: unknown): ChecksRollupState {
	if (!Array.isArray(rollup) || rollup.length === 0) return null;
	let pending = false;
	for (const entry of rollup as Array<Record<string, unknown> | null | undefined>) {
		if (!entry || typeof entry !== "object") {
			pending = true;
			continue;
		}
		// CheckRun carries conclusion+status; StatusContext carries state.
		const raw = typeof entry.conclusion === "string" ? entry.conclusion : (entry.state ?? null);
		if (typeof raw !== "string") {
			pending = true;
			continue;
		}
		if (FAILURE_CONCLUSIONS.has(raw)) return "failure";
		if (NEUTRAL_CONCLUSIONS.has(raw)) continue;
		// IN_PROGRESS, QUEUED, PENDING, EXPECTED, REQUESTED, WAITING, …
		pending = true;
	}
	return pending ? "pending" : "success";
}

export type PrVisualState = "draft" | "open" | "merged" | "closed";

/** Badge class for one PR row. Draft wins over state; merged/closed are
 *  terminal states an open list should still render correctly. */
export function prVisualState(pr: { isDraft?: boolean; state?: string }): PrVisualState {
	if (pr.isDraft === true) return "draft";
	if (pr.state === "MERGED") return "merged";
	if (pr.state === "CLOSED") return "closed";
	return "open";
}

/** "feat/my-cool_branch" → "My Cool Branch" for the create form's default
 *  title. */
export function branchToTitle(branch: string): string {
	return branch
		.replace(/^refs\/heads\//, "")
		.replace(/[-_/]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/\b\w/g, c => c.toUpperCase());
}
