/**
 * Shared composition for usage limits and the reports that carry them.
 *
 * The tier rule and the account label were each written more than once — the
 * command-line report, the ACP report text and the terminal panel — so any
 * change to them had to be made several times or the surfaces disagreed. The
 * window suffix stays with each renderer: they differ in where it belongs and
 * whether the label already carries it.
 */
import type { UsageReport } from "@musepi/pi-ai";

/** Include the usage tier in a limit title unless its label already names it. */
export function formatLimitTitle(limit: UsageReport["limits"][number]): string {
	const tier = limit.scope.tier;
	if (tier && !limit.label.toLowerCase().includes(tier.toLowerCase())) {
		return `${limit.label} (${tier})`;
	}
	return limit.label;
}

/**
 * The label that identifies one account inside a provider's usage block.
 *
 * Two subscriptions (orgs) can share one email, so an org-qualified email wins
 * over a bare one. `??` is deliberately avoided for the metadata fields: an
 * empty string is not nullish, and `metadata.accountId = ""` would otherwise
 * suppress the limit's own scope fallback.
 */
export function usageAccountLabel(
	report: UsageReport,
	limit: UsageReport["limits"][number] | undefined,
	index: number,
): string {
	const meta = report.metadata ?? {};
	const org =
		(typeof meta.orgName === "string" && meta.orgName) || (typeof meta.orgId === "string" && meta.orgId) || undefined;
	const email = meta.email;
	if (typeof email === "string" && email) return org ? `${email} (${org})` : email;

	const metaAccountId = meta.accountId;
	const accountId = typeof metaAccountId === "string" && metaAccountId ? metaAccountId : limit?.scope.accountId;
	if (typeof accountId === "string" && accountId) {
		return org && org !== accountId ? `${accountId} (${org})` : accountId;
	}

	const metaProjectId = meta.projectId;
	const projectId = typeof metaProjectId === "string" && metaProjectId ? metaProjectId : limit?.scope.projectId;
	if (typeof projectId === "string" && projectId) return projectId;
	return `account ${index + 1}`;
}
