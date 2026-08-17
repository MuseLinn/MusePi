/**
 * Shared pure usage aggregation for the TUI `/usage` command and the
 * daemon `usage.reports` RPC.
 *
 * Everything here is display-free (no chalk, no process I/O): the TUI
 * renders these shapes through formatUsageBreakdown, the daemon passes
 * them straight through to the GUI, which renders its own view. Keeping
 * one copy of the attribution/selection logic guarantees the TUI panel,
 * the daemon RPC and the GUI panel disagree only in presentation.
 */

import {
	ANTHROPIC_OAUTH_GRANT_TTL_MS,
	type AuthStorage,
	type DisabledCredentialSummary,
	type UsageReport,
} from "@musepi/pi-ai";

/** Identity slice of a stored credential, for "every account" coverage. */
export interface UsageAccountIdentity {
	provider: string;
	type: "api_key" | "oauth";
	email?: string;
	accountId?: string;
	projectId?: string;
	enterpriseUrl?: string;
	/** Organization/workspace the credential is scoped to (Anthropic multi-subscription). */
	orgId?: string;
	orgName?: string;
	/** Epoch ms of the interactive login that minted the OAuth grant (see `OAuthCredentials.authorizedAt`). */
	authorizedAt?: number;
}

/** Re-login nudge surfaced by {@link computeReloginDeadlines}. */
export interface ReloginDeadline {
	provider: string;
	email?: string;
	accountId?: string;
	orgId?: string;
	orgName?: string;
	/** Epoch ms of grant expiry minus now — negative once the grant is past its lifetime. */
	remainingMs: number;
}

/** Re-login warnings render once remaining grant life drops below this. */
const RELOGIN_WARN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function collectStoredAccounts(authStorage: AuthStorage): UsageAccountIdentity[] {
	const accounts: UsageAccountIdentity[] = [];
	const all = authStorage.getAll();
	for (const provider in all) {
		const entry = all[provider];
		const credentials = Array.isArray(entry) ? entry : [entry];
		for (const credential of credentials) {
			if (credential.type === "oauth") {
				accounts.push({
					provider,
					type: "oauth",
					email: credential.email,
					accountId: credential.accountId,
					projectId: credential.projectId,
					enterpriseUrl: credential.enterpriseUrl,
					orgId: credential.orgId,
					orgName: credential.orgName,
					authorizedAt: credential.authorizedAt,
				});
			} else {
				accounts.push({ provider, type: "api_key" });
			}
		}
	}
	return accounts;
}

/**
 * Keep only accounts worth a usage row: those whose provider has a usage
 * provider, so a missing report is a real gap rather than the absence of any
 * usage concept. Providers with no usage endpoint (web-search keys, local /
 * keyless servers, inference providers without a usage API) would only ever
 * render as noise, so they are dropped.
 *
 * `hasUsageProvider` is injected (in practice {@link AuthStorage.usageProviderFor})
 * so custom/broker resolvers stay authoritative — no provider list is duplicated
 * here. An explicit `--provider` request bypasses the cull, so
 * `omp usage --provider xai` can still confirm the stored credential has no
 * usage endpoint.
 */
export function selectReportableAccounts(
	accounts: UsageAccountIdentity[],
	hasUsageProvider: (provider: string) => boolean,
	explicitProvider?: string,
): UsageAccountIdentity[] {
	if (explicitProvider) return accounts;
	return accounts.filter(account => hasUsageProvider(account.provider));
}

/** Lowercased identity strings a report can be attributed to. */
function reportIdentifiers(report: UsageReport): Set<string> {
	const ids = new Set<string>();
	const add = (value: unknown): void => {
		if (typeof value === "string" && value) ids.add(value.toLowerCase());
	};
	const meta = report.metadata ?? {};
	add(meta.email);
	add(meta.accountId);
	add(meta.projectId);
	add(meta.orgId);
	for (const limit of report.limits) {
		add(limit.scope.accountId);
		add(limit.scope.projectId);
		add(limit.scope.orgId);
	}
	return ids;
}

/**
 * Stored credentials that no usage report could be attributed to.
 *
 * Conservative on purpose: when a provider's reports carry no identity at
 * all (or the credential is an API key alongside existing reports), we
 * can't attribute, so we don't claim the account is missing.
 */
export function collectUnreportedAccounts(
	reports: UsageReport[],
	accounts: UsageAccountIdentity[],
): UsageAccountIdentity[] {
	const byProvider = new Map<string, UsageReport[]>();
	for (const report of reports) {
		const list = byProvider.get(report.provider) ?? [];
		list.push(report);
		byProvider.set(report.provider, list);
	}
	return accounts.filter(account => {
		const providerReports = byProvider.get(account.provider) ?? [];
		if (providerReports.length === 0) return true;
		if (account.type === "api_key") return false;
		// Org-decisive attribution when EITHER side carries an org (Anthropic
		// multi-subscription): two orgs share every other identifier, so an
		// org-scoped account is covered only by its own org's report, and an
		// org-less legacy account is never covered by an org-attributed sibling
		// report — its own fetch failing must surface as "no usage data". Its
		// own ORG-LESS report still covers it, though: a mixed pool (fresh
		// org-scoped logins beside pre-org-capture rows) must not duplicate
		// every legacy account. The shared org is a GATE, not a match: two Team
		// members share the org id while drawing on per-user pools, so coverage
		// also requires the account's own base identity inside the same-org
		// subset (an org-only account, with no base identifiers, is covered by
		// any same-org report). The email/account fallback below applies only
		// when both sides are org-less.
		const accountOrg = account.orgId?.toLowerCase();
		const ids = [account.email, account.accountId, account.projectId]
			.filter((value): value is string => typeof value === "string" && value.length > 0)
			.map(value => value.toLowerCase());
		const sameOrgReports: UsageReport[] = [];
		let sawReportOrg = false;
		for (const report of providerReports) {
			const metaOrg = report.metadata?.orgId;
			if (typeof metaOrg === "string" && metaOrg) {
				sawReportOrg = true;
				if (accountOrg !== undefined && metaOrg.toLowerCase() === accountOrg) sameOrgReports.push(report);
			}
		}
		if (accountOrg || sawReportOrg) {
			const candidates = accountOrg
				? sameOrgReports
				: providerReports.filter(report => {
						const metaOrg = report.metadata?.orgId;
						return !(typeof metaOrg === "string" && metaOrg);
					});
			if (candidates.length === 0) return true;
			if (ids.length === 0) return false;
			return !candidates.some(report => {
				const identifiers = reportIdentifiers(report);
				return ids.some(id => identifiers.has(id));
			});
		}
		if (ids.length === 0) return false;
		const reported = new Set<string>();
		let anyIdentified = false;
		for (const report of providerReports) {
			const identifiers = reportIdentifiers(report);
			if (identifiers.size > 0) anyIdentified = true;
			for (const id of identifiers) reported.add(id);
		}
		if (!anyIdentified) return false;
		return !ids.some(id => reported.has(id));
	});
}

/**
 * Tombstones worth a row in `omp usage`: OAuth credentials torn down
 * automatically (refresh failure, upstream invalidation). Rows the user
 * replaced or deleted deliberately are lifecycle noise, not lost capacity.
 */
export function isActionableDisable(
	summary: DisabledCredentialSummary,
	activeAccounts: UsageAccountIdentity[] = [],
): boolean {
	if (summary.type !== "oauth") return false;
	if (/^(replaced by|deleted by user)/i.test(summary.cause)) return false;

	// Do not display tombstone if there is an active account for the same provider
	// matching the same identity (email, accountId, or org).
	const summaryEmail = summary.email?.toLowerCase();
	const summaryAccountId = summary.accountId?.toLowerCase();
	const summaryOrgId = summary.orgId?.toLowerCase();

	const matchesActive = activeAccounts.some(account => {
		if (account.provider !== summary.provider) return false;

		const accountEmail = account.email?.toLowerCase();
		const accountAccountId = account.accountId?.toLowerCase();
		const accountOrgId = account.orgId?.toLowerCase();

		// If email or accountId match, it's the same identity
		if (summaryEmail && accountEmail && summaryEmail === accountEmail) return true;
		if (summaryAccountId && accountAccountId && summaryAccountId === accountAccountId) return true;

		// Fallback: if orgId matches and neither email nor accountId contradicts
		if (summaryOrgId && accountOrgId && summaryOrgId === accountOrgId) return true;

		return false;
	});

	return !matchesActive;
}

/**
 * Re-login deadlines for providers whose OAuth grants expire a fixed
 * period after the interactive login (today: Anthropic, ~30 days regardless
 * of refresh rotation). Silent until the deadline is under a week out — a
 * nudge before the broker auto-disables the row, not a permanent countdown.
 * Returns only deadlines inside the warning window; a negative `remainingMs`
 * means the grant is already past its lifetime.
 */
export function computeReloginDeadlines(accounts: UsageAccountIdentity[], nowMs: number): ReloginDeadline[] {
	const deadlines: ReloginDeadline[] = [];
	for (const account of accounts) {
		if (account.provider !== "anthropic" || account.type !== "oauth" || !account.authorizedAt) continue;
		const remainingMs = account.authorizedAt + ANTHROPIC_OAUTH_GRANT_TTL_MS - nowMs;
		if (remainingMs > RELOGIN_WARN_WINDOW_MS) continue;
		deadlines.push({
			provider: account.provider,
			...(account.email ? { email: account.email } : {}),
			...(account.accountId ? { accountId: account.accountId } : {}),
			...(account.orgId ? { orgId: account.orgId } : {}),
			...(account.orgName ? { orgName: account.orgName } : {}),
			remainingMs,
		});
	}
	return deadlines;
}
