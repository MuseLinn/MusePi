import { toNumber } from "@musepi/pi-catalog/utils";
import { extractCursorAccessTokenUserId } from "../registry/oauth/cursor";
import type {
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
	UsageWindow,
} from "../usage";
import { isRecord } from "../utils";
import { parseIsoTimestamp, usageStatus } from "./shared";

function parseTimestamp(value: unknown): number | undefined {
	const numeric = toNumber(value);
	if (numeric !== undefined) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
	return parseIsoTimestamp(value);
}

const DEFAULT_CURSOR_BASE_URL = "https://api2.cursor.sh";

function normalizeCursorBaseUrl(baseUrl?: string): string {
	if (!baseUrl) return DEFAULT_CURSOR_BASE_URL;
	return baseUrl.replace(/\/+$/, "");
}

type CursorUsageSource = "auth-usage" | "usage-summary" | "auth-me";

async function fetchCursorJson(
	ctx: UsageFetchContext,
	url: string,
	init: RequestInit,
	source: CursorUsageSource,
): Promise<unknown | undefined> {
	try {
		const response = await ctx.fetch(url, init);
		if (!response.ok) {
			ctx.logger?.warn("Cursor usage request failed", {
				status: response.status,
				provider: "cursor",
				source,
			});
			return undefined;
		}
		return await response.json();
	} catch (error) {
		ctx.logger?.warn("Cursor usage request error", {
			provider: "cursor",
			source,
			error: String(error),
		});
		return undefined;
	}
}

function deriveResetsAt(payload: Record<string, unknown>): number | undefined {
	const endKeys = ["billingCycleEnd", "endOfMonth", "resetsAt", "nextReset"];
	for (const key of endKeys) {
		const parsed = parseTimestamp(payload[key]);
		if (parsed !== undefined) return parsed;
	}

	const startKeys = ["startOfMonth", "billingCycleStart", "startOfBillingCycle"];
	for (const key of startKeys) {
		const parsed = parseTimestamp(payload[key]);
		if (parsed !== undefined) {
			const date = new Date(parsed);
			date.setUTCMonth(date.getUTCMonth() + 1);
			return date.getTime();
		}
	}
	return undefined;
}

export function parseCursorIndividualUsage(payload: unknown, fetchedAt = Date.now()): UsageReport | null {
	if (!isRecord(payload) || !isRecord(payload.individualUsage) || !isRecord(payload.individualUsage.overall)) {
		return null;
	}
	const individual = payload.individualUsage.overall;
	if (individual.enabled === false) return null;

	const reportedUsed = toNumber(individual.used);
	const reportedRemaining = toNumber(individual.remaining);
	const hasValidUsed = reportedUsed !== undefined && reportedUsed >= 0;
	const hasValidRemaining = reportedRemaining !== undefined && reportedRemaining >= 0;
	const limit = toNumber(individual.limit);

	let amount: UsageAmount;
	if (individual.limit === null || individual.limit === undefined) {
		if (!hasValidUsed) return null;
		amount = { used: reportedUsed / 100, unit: "usd" };
	} else {
		if (limit === undefined || limit <= 0) return null;
		let used: number;
		if (reportedUsed !== undefined && reportedUsed > 0) {
			used = reportedUsed;
		} else if (hasValidRemaining && reportedRemaining < limit) {
			used = Math.max(0, limit - reportedRemaining);
		} else if (hasValidUsed) {
			used = reportedUsed;
		} else {
			return null;
		}
		const remaining = Math.max(0, limit - used);
		amount = {
			used: used / 100,
			limit: limit / 100,
			remaining: remaining / 100,
			usedFraction: used / limit,
			remainingFraction: remaining / limit,
			unit: "usd",
		};
	}

	const resetsAt = deriveResetsAt(payload);
	const window: UsageWindow = {
		id: "monthly",
		label: "Monthly",
		...(resetsAt !== undefined ? { resetsAt } : {}),
	};
	const limitEntry: UsageLimit = {
		id: "cursor:usd:individual-overall",
		label: "Personal Usage",
		scope: {
			provider: "cursor",
			windowId: window.id,
		},
		window,
		amount,
		...(amount.usedFraction !== undefined ? { status: usageStatus(amount.usedFraction) } : {}),
	};
	return {
		provider: "cursor",
		fetchedAt,
		limits: [limitEntry],
		raw: payload,
	};
}

export function parseCursorUsage(payload: unknown, fetchedAt = Date.now()): UsageReport | null {
	if (!isRecord(payload)) return null;
	const limits: UsageLimit[] = [];
	const resetsAt = deriveResetsAt(payload);

	const window: UsageWindow = {
		id: "monthly",
		label: "Monthly",
		...(resetsAt !== undefined ? { resetsAt } : {}),
	};

	for (const [key, value] of Object.entries(payload)) {
		if (!isRecord(value)) continue;

		// used can be: numRequests, used, amountUsed, usdUsed
		const usedVal =
			toNumber(value.numRequests) ?? toNumber(value.used) ?? toNumber(value.amountUsed) ?? toNumber(value.usdUsed);

		// limit can be: maxRequestUsage, limit, amountLimit, usdLimit
		const limitVal =
			toNumber(value.maxRequestUsage) ??
			toNumber(value.limit) ??
			toNumber(value.amountLimit) ??
			toNumber(value.usdLimit);

		if (usedVal !== undefined && limitVal !== undefined) {
			const isUsd =
				key === "planUsage" ||
				key.toLowerCase().includes("usd") ||
				key.toLowerCase().includes("billing") ||
				key.toLowerCase().includes("stripe");

			const unit = isUsd ? "usd" : "requests";
			const cleanBucket = key.toLowerCase().trim();
			const limitId = isUsd ? `cursor:usd:${cleanBucket}` : `cursor:requests:${cleanBucket}`;

			const label = isUsd ? `${key} spend` : `${key} requests`;

			const amount: UsageAmount = {
				used: usedVal,
				limit: limitVal,
				remaining: Math.max(0, limitVal - usedVal),
				usedFraction: limitVal > 0 ? usedVal / limitVal : 0,
				remainingFraction: limitVal > 0 ? Math.max(0, limitVal - usedVal) / limitVal : 0,
				unit,
			};

			const status = usageStatus(amount.usedFraction);

			limits.push({
				id: limitId,
				label,
				scope: {
					provider: "cursor",
					...(window ? { windowId: window.id } : {}),
				},
				...(window ? { window } : {}),
				amount,
				status,
			});
		}
	}

	if (limits.length === 0) {
		return null;
	}

	return {
		provider: "cursor",
		fetchedAt,
		limits,
		raw: payload,
	};
}

export const cursorUsageProvider: UsageProvider = {
	id: "cursor",
	supports(params: UsageFetchParams): boolean {
		if (params.provider !== "cursor") return false;
		const { credential } = params;
		if (credential.type === "oauth") {
			return Boolean(credential.accessToken);
		}
		if (credential.type === "api_key") {
			return Boolean(credential.apiKey);
		}
		return false;
	},
	async fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
		if (params.provider !== "cursor") return null;
		const { credential } = params;
		const token = credential.type === "oauth" ? credential.accessToken : credential.apiKey;
		if (!token) return null;

		const baseUrl = normalizeCursorBaseUrl(params.baseUrl ?? credential.apiEndpoint);
		const url = `${baseUrl}/auth/usage`;
		const headers: Record<string, string> = {
			Accept: "application/json",
			Authorization: `Bearer ${token}`,
		};
		const fetchedAt = Date.now();

		const legacyReportPromise = fetchCursorJson(
			ctx,
			url,
			{
				headers,
				signal: params.signal,
			},
			"auth-usage",
		).then(payload => parseCursorUsage(payload, fetchedAt));

		let summaryReportPromise = Promise.resolve<UsageReport | null>(null);
		let profileEmailPromise = Promise.resolve<string | undefined>(undefined);
		if (credential.type === "oauth" && baseUrl === DEFAULT_CURSOR_BASE_URL) {
			const userId = extractCursorAccessTokenUserId(token);
			if (userId) {
				const sessionHeaders: Record<string, string> = {
					Accept: "application/json",
					Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${token}`)}`,
				};
				summaryReportPromise = fetchCursorJson(
					ctx,
					"https://cursor.com/api/usage-summary",
					{
						headers: sessionHeaders,
						signal: params.signal,
					},
					"usage-summary",
				).then(payload => parseCursorIndividualUsage(payload, fetchedAt));
				profileEmailPromise = fetchCursorJson(
					ctx,
					"https://cursor.com/api/auth/me",
					{
						headers: sessionHeaders,
						signal: params.signal,
					},
					"auth-me",
				).then(payload => {
					if (
						!isRecord(payload) ||
						payload.sub !== userId ||
						typeof payload.email !== "string" ||
						!payload.email.trim()
					) {
						return undefined;
					}
					return payload.email.trim();
				});
			}
		}

		const [legacyReport, summaryReport, profileEmail] = await Promise.all([
			legacyReportPromise,
			summaryReportPromise,
			profileEmailPromise,
		]);
		let report: UsageReport | null;
		if (legacyReport && summaryReport) {
			report = {
				provider: "cursor",
				fetchedAt,
				limits: [...legacyReport.limits, ...summaryReport.limits],
				raw: {
					authUsage: legacyReport.raw,
					usageSummary: summaryReport.raw,
				},
			};
		} else {
			report = legacyReport ?? summaryReport;
		}
		if (!report) return null;

		const email = profileEmail ?? credential.email?.trim();
		const metadata = {
			...(email ? { email } : {}),
			...(credential.accountId ? { accountId: credential.accountId } : {}),
			...(credential.projectId ? { projectId: credential.projectId } : {}),
		};
		if (Object.keys(metadata).length > 0) report.metadata = metadata;
		return report;
	},
};
