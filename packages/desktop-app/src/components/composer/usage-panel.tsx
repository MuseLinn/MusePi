import type { ReactNode } from "react";
import { Fragment, useState } from "react";
import { t } from "../../i18n/index.js";
import { Icon } from "../../vendor/oc-icons";
import { Reveal } from "../Reveal";

/** Compact "resets in …" label from a duration in ms (TUI formatDuration
 *  parity): 2h, 3d5h, 12m — coarse but stable for popover width. */
export function fmtQuotaDuration(ms: number): string {
	const mins = Math.max(0, Math.round(ms / 60000));
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h${mins % 60 ? `${mins % 60}m` : ""}`;
	const days = Math.floor(hours / 24);
	return `${days}d${hours % 24 ? `${hours % 24}h` : ""}`;
}

/** /usage wire shape — mirror of @musepi/pi-ai UsageReport served by the
 *  daemon's usage.reports RPC (TUI /usage parity). Shared with the
 *  empty-state composer, which fetches the same global view session-less. */
export interface UsageAmountView {
	used?: number;
	limit?: number;
	unit?: string;
	usedFraction?: number;
	remainingFraction?: number;
}
export interface UsageLimitView {
	id: string;
	label: string;
	scope?: { accountId?: string; projectId?: string; tier?: string; windowId?: string };
	window?: { id?: string; label?: string; resetsAt?: number; resetLabel?: string };
	amount: UsageAmountView;
	status?: string;
	notes?: string[];
}
export interface UsageReportView {
	provider: string;
	fetchedAt?: number;
	limits: UsageLimitView[];
	resetCredits?: { availableCount: number; credits?: Array<{ expiresAt?: string; status?: string }> };
	notes?: string[];
	metadata?: Record<string, unknown>;
}
/** The credential the live session is actually using (daemon resolves it). */
export interface UsageActiveAccountView {
	provider: string;
	accountId?: string;
	email?: string;
}

/** A stored credential with no usage report attributed to it (TUI ○ row). */
export interface UsageUnreportedAccountView {
	provider: string;
	email?: string;
	accountId?: string;
	projectId?: string;
	enterpriseUrl?: string;
	orgId?: string;
	orgName?: string;
}

/** An auto-disabled OAuth credential tombstone (TUI ✗ row). */
export interface UsageDisabledCredentialView {
	provider: string;
	email?: string;
	accountId?: string;
	orgId?: string;
	orgName?: string;
	cause: string;
	disabledAtMs?: number;
}

/** An OAuth grant inside its re-login warning window (TUI ⚠ row). */
export interface UsageReloginDeadlineView {
	provider: string;
	email?: string;
	accountId?: string;
	orgId?: string;
	orgName?: string;
	/** Epoch ms of grant expiry minus now — negative once past its lifetime. */
	remainingMs: number;
}

/** Full `/usage` panel payload from the daemon `usage.reports` RPC. */
export interface UsageReportsData {
	reports: UsageReportView[];
	activeAccount: UsageActiveAccountView | null;
	unreportedAccounts: UsageUnreportedAccountView[];
	disabledCredentials: UsageDisabledCredentialView[];
	reloginDeadlines: UsageReloginDeadlineView[];
	fetchedAt: number;
}

/** Title-case a provider id ("openai-codex" → "Openai Codex", TUI parity). */
function usageProviderTitle(provider: string): string {
	return provider
		.split(/[-_]/g)
		.map(part => (part ? part[0]!.toUpperCase() + part.slice(1) : ""))
		.join(" ");
}

/** Account label for one limit row: email → accountId → projectId → "account N". */
function usageAccountLabel(limit: UsageLimitView, report: UsageReportView, index: number): string {
	const meta = report.metadata ?? {};
	const email = typeof meta.email === "string" && meta.email ? meta.email : undefined;
	if (email) return email;
	const accountId =
		(typeof meta.accountId === "string" && meta.accountId ? meta.accountId : limit.scope?.accountId) ?? undefined;
	if (accountId) return accountId;
	const projectId =
		(typeof meta.projectId === "string" && meta.projectId ? meta.projectId : limit.scope?.projectId) ?? undefined;
	if (projectId) return projectId;
	return t("account {count}", { count: String(index + 1) });
}

/** Used fraction 0..1 — mirrors @musepi/pi-ai resolveUsedFraction. */
function usageResolveUsedFraction(limit: UsageLimitView): number | undefined {
	const amount = limit.amount;
	if (amount.usedFraction !== undefined) return amount.usedFraction;
	if (amount.used !== undefined && amount.limit !== undefined && amount.limit > 0) {
		return amount.used / amount.limit;
	}
	if (amount.unit === "percent" && amount.used !== undefined) return amount.used / 100;
	if (amount.remainingFraction !== undefined) return Math.max(0, 1 - amount.remainingFraction);
	return undefined;
}

/** Whether a limit row belongs to the session's active credential (TUI ●). */
function usageLimitIsActive(
	limit: UsageLimitView,
	report: UsageReportView,
	activeAccount: UsageActiveAccountView | null,
): boolean {
	if (!activeAccount || activeAccount.provider !== report.provider) return false;
	const meta = report.metadata ?? {};
	return (
		(activeAccount.accountId !== undefined &&
			(meta.accountId === activeAccount.accountId || limit.scope?.accountId === activeAccount.accountId)) ||
		(activeAccount.email !== undefined && meta.email === activeAccount.email)
	);
}

/** "resets in 2h" / "resets in 2h–3h" for a limit group (TUI parity). */
function usageResetRange(limits: UsageLimitView[], nowMs: number): string | null {
	const windows = limits
		.map(limit => limit.window)
		.filter(
			(window): window is NonNullable<UsageLimitView["window"]> =>
				window?.resetsAt !== undefined && window.resetsAt > nowMs,
		);
	if (windows.length === 0) return null;
	const offsets = windows.map(window => window.resetsAt!).sort((a, b) => a - b);
	const minReset = offsets[0]!;
	const maxReset = offsets[offsets.length - 1]!;
	if (maxReset - minReset > 60_000) {
		return t("resets in {min}–{max}", {
			min: fmtQuotaDuration(minReset - nowMs),
			max: fmtQuotaDuration(maxReset - nowMs),
		});
	}
	return t("resets in {time}", { time: fmtQuotaDuration(minReset - nowMs) });
}

/** Status tone for a limit's bar + dot ("ok" | "warn" | "err").
 *  TUI resolveStatus parity: when `status` is absent/unknown, derive from
 *  the used fraction (≥1 exhausted, ≥0.8 warning) instead of defaulting
 *  to ok — a 95%-used meter must not read green just because the provider
 *  omitted the status. */
function usageTone(status: string | undefined, fraction?: number): "ok" | "warn" | "err" {
	if (status === "exhausted") return "err";
	if (status === "warning") return "warn";
	if (status === "ok") return "ok";
	if (fraction !== undefined) {
		if (fraction >= 1) return "err";
		if (fraction >= 0.8) return "warn";
	}
	return "ok";
}

/** Status tone class for a limit's bar (exhausted/warning → ok). */
function usageStatusTone(status: string | undefined, fraction?: number): string {
	return `gui-usage-bar--${usageTone(status, fraction)}`;
}

/** Saved rate-limit resets for one credential report (TUI /usage parity). */
function UsageResetsBlock({
	report,
	activeAccount,
	nowMs,
}: {
	report: UsageReportView;
	activeAccount: UsageActiveAccountView | null;
	nowMs: number;
}): ReactNode {
	const resets = report.resetCredits;
	if (!resets) return null;
	const meta = report.metadata ?? {};
	const label =
		(typeof meta.email === "string" && meta.email ? meta.email : undefined) ??
		(typeof meta.accountId === "string" && meta.accountId ? meta.accountId : undefined) ??
		t("account {count}", { count: "1" });
	const isActive =
		activeAccount?.provider === report.provider &&
		((activeAccount.email !== undefined && meta.email === activeAccount.email) ||
			(activeAccount.accountId !== undefined && meta.accountId === activeAccount.accountId));
	const rows: ReactNode[] = [
		<span key="row">
			• {label}: {resets.availableCount} {resets.availableCount === 1 ? t("saved reset") : t("saved resets")}
			{isActive ? ` (${t("active")})` : ""}
		</span>,
	];
	for (const credit of resets.credits ?? []) {
		if (!credit.expiresAt) continue;
		const expiryMs = Date.parse(credit.expiresAt);
		if (Number.isNaN(expiryMs)) continue;
		const remaining = expiryMs - nowMs;
		const date = credit.expiresAt.slice(0, 10);
		rows.push(
			<span key={`${credit.expiresAt}-${date}`}>
				{remaining > 0
					? t("expires in {time}", { time: fmtQuotaDuration(remaining) })
					: t("expired ({date})", { date })}
			</span>,
		);
	}
	return (
		<div className="gui-usage-resets">
			<span className="gui-usage-resets-title">{t("saved rate-limit resets")}</span>
			{rows}
		</div>
	);
}

/** One provider section of the /usage card (TUI /usage panel parity).
 *  ALL credential reports of the provider merge into a single collapsible
 *  section: per limit-window the credentials render side by side as
 *  columns (progress bar + numbers each) with the aggregate pinned at the
 *  far right — the same treatment as the tray menu. Several credentials
 *  of one provider (e.g. two opencode-go accounts) no longer produce
 *  stacked duplicate sections. */
export function UsageProviderSection({
	reports,
	activeAccount,
}: {
	reports: UsageReportView[];
	activeAccount: UsageActiveAccountView | null;
}): ReactNode {
	const [expanded, setExpanded] = useState(false);
	const nowMs = Date.now();
	const provider = reports[0]?.provider ?? "";
	const allLimits = reports.flatMap(report => report.limits ?? []);
	// Group limits by window (label + window id, TUI parity) ACROSS every
	// credential of the provider so 5h/7d/… render as one section each.
	const groups = new Map<
		string,
		{ label: string; windowLabel: string; cells: { report: UsageReportView; limit: UsageLimitView; index: number }[] }
	>();
	for (const report of reports) {
		for (const limit of report.limits ?? []) {
			const tier = limit.scope?.tier;
			const label =
				tier && !limit.label.toLowerCase().includes(tier.toLowerCase()) ? `${limit.label} (${tier})` : limit.label;
			const windowId = limit.window?.id ?? limit.scope?.windowId ?? "default";
			const windowLabel = limit.window?.label ?? windowId;
			const key = `${label}|${windowId}`;
			const group = groups.get(key) ?? { label, windowLabel, cells: [] };
			group.cells.push({ report, limit, index: group.cells.length });
			groups.set(key, group);
		}
	}
	const groupList = [...groups.values()].filter(group => group.cells.length > 0);
	// Provider-wide credential order: every window row renders its columns
	// in this ONE order (mean used-fraction, most-used first; ties by
	// label). Per-window worst-first sorting made columns swap between
	// rows — 账户 1 in the left column of one window, right of the next —
	// which reads as the credentials being "mixed up".
	const accountOrder = new Map<string, number>();
	{
		const totals = new Map<string, { sum: number; count: number }>();
		for (const group of groupList) {
			for (const cell of group.cells) {
				const label = usageAccountLabel(cell.limit, cell.report, cell.index);
				const entry = totals.get(label) ?? { sum: 0, count: 0 };
				const fraction = usageResolveUsedFraction(cell.limit);
				if (fraction !== undefined) {
					entry.sum += fraction;
					entry.count += 1;
				}
				totals.set(label, entry);
			}
		}
		[...totals.entries()]
			.sort(
				(a, b) =>
					b[1].sum / Math.max(1, b[1].count) - a[1].sum / Math.max(1, a[1].count) || a[0].localeCompare(b[0]),
			)
			.forEach(([label], index) => {
				accountOrder.set(label, index);
			});
	}
	const unlimitedReports = reports.filter(report => (report.limits ?? []).length === 0);
	const resetsReports = reports.filter(report => (report.resetCredits?.availableCount ?? 0) > 0);
	const activeHere =
		activeAccount?.provider === provider ? (activeAccount.email ?? activeAccount.accountId ?? undefined) : undefined;
	const notes = [...new Set(reports.flatMap(report => report.notes ?? []))];
	// Aggregate tone across all of the provider's limits → the header dot.
	const allStatuses = allLimits.map(limit => limit.status).filter(Boolean);
	const allFractions = allLimits
		.map(limit => usageResolveUsedFraction(limit))
		.filter((value): value is number => value !== undefined);
	const aggregateTone = usageTone(
		allStatuses.includes("exhausted") ? "exhausted" : allStatuses.includes("warning") ? "warning" : "ok",
		allFractions.length > 0 ? Math.max(...allFractions) : undefined,
	);

	return (
		<div className="gui-usage-section" key={provider}>
			<button
				type="button"
				className="gui-usage-provider-head"
				onClick={() => setExpanded(v => !v)}
				aria-expanded={expanded}
			>
				<span className={`gui-usage-dot gui-usage-dot--${aggregateTone}`} />
				<span className="gui-usage-provider">{usageProviderTitle(provider)}</span>
				{groupList.length > 0 && (
					<span className="gui-usage-provider-summary">
						{t("{count} windows", { count: String(groupList.length) })}
					</span>
				)}
				<Icon name="arrow-down" className={`gui-usage-chevron${expanded ? " gui-usage-chevron--open" : ""}`} />
			</button>
			<Reveal open={expanded}>
				<div className="gui-usage-provider-body">
					{activeHere && (
						<div className="gui-usage-note">
							{t("in use by this session: {account}", { account: activeHere })}
						</div>
					)}
					{notes.length > 0 && <div className="gui-usage-note">{notes.join(" • ")}</div>}
					{resetsReports.map(report => (
						<UsageResetsBlock
							key={`resets-${provider}-${usageAccountLabel({ id: "", label: "", amount: {} }, report, 0)}`}
							report={report}
							activeAccount={activeAccount}
							nowMs={nowMs}
						/>
					))}
					{groupList.map(group => {
						const groupLimits = group.cells.map(cell => cell.limit);
						const statuses = groupLimits.map(limit => limit.status).filter(Boolean);
						const aggregate = statuses.includes("exhausted")
							? "exhausted"
							: statuses.includes("warning")
								? "warning"
								: "ok";
						const resetRange = usageResetRange(groupLimits, nowMs);
						const windowSuffix =
							group.windowLabel.toLowerCase() === "quota window" ||
							group.label.toLowerCase().includes(group.windowLabel.toLowerCase())
								? ""
								: group.windowLabel;
						// Credential columns in the provider-wide order
						// (accountOrder above) so one credential keeps the
						// same column position in every window row.
						const cells = [...group.cells]
							.sort(
								(a, b) =>
									(accountOrder.get(usageAccountLabel(a.limit, a.report, a.index)) ??
										Number.MAX_SAFE_INTEGER) -
									(accountOrder.get(usageAccountLabel(b.limit, b.report, b.index)) ?? Number.MAX_SAFE_INTEGER),
							)
							.slice(0, 4);
						const groupFractions = cells
							.map(cell => usageResolveUsedFraction(cell.limit))
							.filter((value): value is number => value !== undefined);
						const avg =
							groupFractions.reduce((sum, value) => sum + value, 0) / Math.max(1, groupFractions.length);
						const cols = `${cells.map(() => "minmax(0, 1fr)").join(" ")} 52px`;
						return (
							<div className="gui-usage-group" key={group.label + group.windowLabel}>
								<div className="gui-usage-group-head">
									<span
										className={`gui-usage-dot gui-usage-dot--${usageTone(aggregate, groupFractions.length > 0 ? Math.max(...groupFractions) : undefined)}`}
									/>
									<span className="gui-usage-group-name">{group.label}</span>
									{windowSuffix && <span className="gui-usage-group-window">({windowSuffix})</span>}
								</div>
								<div className="gui-usage-cols" style={{ gridTemplateColumns: cols }}>
									{cells.map((cell, ci) => {
										const fraction = usageResolveUsedFraction(cell.limit);
										const percent = fraction !== undefined ? Math.min(100, Math.max(0, fraction * 100)) : 0;
										const active = usageLimitIsActive(cell.limit, cell.report, activeAccount);
										const resetShort =
											cell.limit.window?.resetsAt !== undefined && cell.limit.window.resetsAt > nowMs
												? t("resets in {time}", {
														time: fmtQuotaDuration(cell.limit.window.resetsAt - nowMs),
													})
												: undefined;
										return (
											<div className="gui-usage-cell" key={`${ci}-${cell.limit.id || cell.limit.label}`}>
												<div className="gui-usage-cell-label">
													<span
														className={`gui-usage-acct-name${active ? " gui-usage-acct-name--active" : ""}`}
													>
														{active ? "● " : ""}
														{usageAccountLabel(cell.limit, cell.report, cell.index)}
													</span>
													{resetShort && <span className="gui-usage-acct-reset">({resetShort})</span>}
												</div>
												<div className="gui-quota-bar">
													<div className="gui-usage-bar-track">
														<div
															className={`gui-usage-bar ${usageStatusTone(cell.limit.status, fraction)}`}
															style={{ width: `${percent}%` }}
														/>
													</div>
													<span className="gui-quota-pct">
														{fraction !== undefined
															? t("{percent}% used", { percent: String(Math.round(fraction * 100)) })
															: "—"}
													</span>
												</div>
											</div>
										);
									})}
									<div className="gui-usage-cell gui-usage-cell--total">
										<div className="gui-usage-cell-label">
											<span className="gui-usage-acct-name">{t("total")}</span>
										</div>
										<div className="gui-quota-bar">
											<div className="gui-usage-bar-track">
												<div
													className={`gui-usage-bar ${usageStatusTone(undefined, avg)}`}
													style={{ width: `${Math.min(100, Math.max(0, avg * 100))}%` }}
												/>
											</div>
											<span className="gui-quota-pct">{Math.round(avg * 100)}%</span>
										</div>
									</div>
								</div>
								{resetRange && <div className="gui-usage-resetline">{resetRange}</div>}
								{(() => {
									const groupNotes = [...new Set(groupLimits.flatMap(limit => limit.notes ?? []))];
									return groupNotes.length > 0 ? (
										<div className="gui-usage-note">{groupNotes.join(" • ")}</div>
									) : null;
								})()}
							</div>
						);
					})}
					{unlimitedReports.map(report => (
						<div
							className="gui-usage-unlimited"
							key={`${provider}-unlimited-${usageAccountLabel({ id: "", label: "", amount: {} }, report, 0)}`}
						>
							• {usageAccountLabel({ id: "", label: "", amount: {} }, report, 0)}
							{typeof report.metadata?.planType === "string" && report.metadata.planType
								? ` (${report.metadata.planType})`
								: ""}{" "}
							<span className="gui-usage-note">— {t("no limits")}</span>
						</div>
					))}
				</div>
			</Reveal>
		</div>
	);
}

/** Identity label for a gap row (email → accountId → projectId → org). */
function usageGapLabel(account: {
	email?: string;
	accountId?: string;
	projectId?: string;
	orgName?: string;
	orgId?: string;
}): string {
	const base = account.email ?? account.accountId ?? account.projectId ?? "OAuth account";
	const org = account.orgName ?? account.orgId;
	if (!org || org === base) return base;
	return `${base} · ${org}`;
}

/** First clause of a disable cause, human-sized (TUI shortDisableCause parity). */
function usageShortCause(cause: string): string {
	const stripped = cause.replace(/^oauth refresh failed:\s*/i, "");
	const clause = stripped.split(/[;\n]/, 1)[0] ?? stripped;
	return clause.length > 80 ? `${clause.slice(0, 77)}…` : clause;
}

/** Provider-scoped gap rows under the report sections: ○ no usage data,
 *  ✗ disabled credential, ⚠ re-login deadline (TUI /usage parity). */
export function UsageGapLines({ provider, data }: { provider: string; data: UsageReportsData }): ReactNode {
	const unreported = data.unreportedAccounts.filter(account => account.provider === provider);
	const disabled = data.disabledCredentials.filter(credential => credential.provider === provider);
	const relogin = data.reloginDeadlines.filter(deadline => deadline.provider === provider);
	if (unreported.length === 0 && disabled.length === 0 && relogin.length === 0) return null;
	return (
		<div className="gui-usage-gaps">
			{unreported.map(account => (
				<div className="gui-usage-gap" key={`${account.provider}-${usageGapLabel(account)}`}>
					<span className="gui-usage-gap-glyph">○</span> {usageGapLabel(account)} — {t("no usage data")}
				</div>
			))}
			{disabled.map(credential => (
				<div
					className="gui-usage-gap gui-usage-gap--disabled"
					key={`${credential.provider}-${usageGapLabel(credential)}`}
				>
					<span className="gui-usage-gap-glyph">✗</span> {usageGapLabel(credential)} — {t("disabled")}:{" "}
					{usageShortCause(credential.cause)} <span className="gui-usage-note">({t("re-login to restore")})</span>
				</div>
			))}
			{relogin.map(deadline => (
				<div
					className="gui-usage-gap gui-usage-gap--relogin"
					key={`${deadline.provider}-${usageGapLabel(deadline)}`}
				>
					<span className="gui-usage-gap-glyph">⚠</span> {usageGapLabel(deadline)} —{" "}
					{deadline.remainingMs > 0
						? t("re-login within {time}", { time: fmtQuotaDuration(deadline.remainingMs) })
						: t("grant expired; re-login now")}
				</div>
			))}
		</div>
	);
}

/** Floating /usage card body (TUI /usage panel parity): rendered inside
 *  the composer's portaled quota menu. */
export function UsagePanelCard({
	data,
	loading,
	onClose,
}: {
	data: UsageReportsData | null;
	loading: boolean;
	onClose(): void;
}): ReactNode {
	return (
		<div className="gui-quota-panel" role="dialog" aria-label={t("subscription usage")}>
			<button type="button" className="gui-quota-close" onClick={onClose} aria-label={t("close")}>
				<Icon name="close" className="h-3.5 w-3.5" />
			</button>
			<div className="gui-quota-title">
				{t("subscription usage")}
				{data?.fetchedAt
					? ` · ${t("usage {time} ago", { time: fmtQuotaDuration(Date.now() - data.fetchedAt) })}`
					: null}
			</div>
			{loading ? (
				<div className="gui-quota-note">…</div>
			) : data &&
				(data.reports.length > 0 ||
					data.unreportedAccounts.length > 0 ||
					data.disabledCredentials.length > 0 ||
					data.reloginDeadlines.length > 0) ? (
				<div className="gui-usage-reports">
					{(() => {
						// Union of every provider with reports or gap rows so
						// the ○/✗/⚠ lines land under their own provider (TUI
						// /usage groups them per provider section). When every
						// fetch failed, reports is empty and all accounts land
						// in unreportedAccounts — the group still renders.
						const reportsByProvider = new Map<string, UsageReportView[]>();
						for (const report of data!.reports) {
							const list = reportsByProvider.get(report.provider) ?? [];
							list.push(report);
							reportsByProvider.set(report.provider, list);
						}
						const providers = [
							...new Set([
								...data!.reports.map(report => report.provider),
								...data!.unreportedAccounts.map(account => account.provider),
								...data!.disabledCredentials.map(credential => credential.provider),
								...data!.reloginDeadlines.map(deadline => deadline.provider),
							]),
						];
						return providers.map(provider => {
							const reports = reportsByProvider.get(provider);
							return (
								<Fragment key={provider}>
									{reports && reports.length > 0 && (
										<UsageProviderSection reports={reports} activeAccount={data!.activeAccount} />
									)}
									<UsageGapLines provider={provider} data={data!} />
								</Fragment>
							);
						});
					})()}
				</div>
			) : (
				<div className="gui-quota-note">{t("no subscription usage reported")}</div>
			)}
		</div>
	);
}
