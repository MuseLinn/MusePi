import type { ReactNode } from "react";

/**
 * Parse the ACP-mode `/usage` report text (builtin-session.ts → helpers/
 * usage-report.ts buildUsageReportText — a stable, code-generated shape)
 * into structured data the GUI can render as cards. The format:
 *
 *   ```text
 *   Usage (2m ago)
 *   Opencode Go
 *     Models with usage data
 *       opencode/deepseek-v4-flash
 *       …
 *   - 5 Hour limit
 *     Account 1: 4.00% used (96.0% left)
 *     [ascii bar]
 *     resets in 2h
 *   …
 *   ```
 */
export type ParsedUsage = {
	provider: string;
	fetchedLabel: string;
	models: string[];
	limits: Array<{
		label: string;
		account: string;
		usedPercent: number;
		leftPercent: number;
		resetsIn: string;
	}>;
};

const USAGE_FENCE_RE = /^```(?:text)?\s*\nUsage/;

/** Strip ANSI SGR escapes (the TUI usage panel colors its output; the GUI
 *  receives those codes verbatim — `[39m]` in the raw text is ESC[39m). */
function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

export function isUsageReport(text: string): boolean {
	const clean = stripAnsi(text).trimStart();
	if (USAGE_FENCE_RE.test(clean)) return true;
	// No fence (the report can land as a plain assistant message): the
	// first line is "Usage …" AND at least one "- … limit" row follows —
	// distinctive enough that ordinary prose won't false-positive.
	const lines = clean.split("\n");
	if (!/^Usage(?:\s|$)/.test(lines[0] ?? "")) return false;
	return lines.some(line => /^\s*- .*\blimit\b/i.test(line));
}

export function parseUsageReport(text: string): ParsedUsage | null {
	const clean = stripAnsi(text)
		.trim()
		.replace(/^```(?:text)?\s*\n/, "")
		.replace(/\n```\s*$/, "");
	const lines = clean.split("\n");
	if (lines.length === 0) return null;
	const fetchedLabel = /^Usage(?:\s+\((.*?)\))?/.exec(lines[0]!)?.[1] ?? "";
	// Provider name: the first non-indented line after the "Usage …" header.
	let provider = "";
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]!;
		if (line && !line.startsWith(" ") && !line.startsWith("-") && line !== "```") {
			provider = line.trim();
			break;
		}
	}
	const models: string[] = [];
	const limits: ParsedUsage["limits"] = [];
	let inModels = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (/^\s*Models with usage data/.test(line)) {
			inModels = true;
			continue;
		}
		if (inModels) {
			if (/^\s{4,}(\S+)$/.test(line)) {
				models.push(line.trim());
				continue;
			}
			if (/^\s*- /.test(line)) inModels = false;
			else if (line && !line.startsWith(" ")) inModels = false;
		}
		const label = /^\s*- (.+)$/.exec(line)?.[1];
		if (!label) continue;
		// Following lines: account row + optional "resets in …".
		let account = "account";
		let usedPercent = 0;
		let leftPercent = 0;
		let resetsIn = "";
		for (let j = i + 1; j < lines.length; j++) {
			const next = lines[j]!;
			const accountRow = /^\s+(.+?): ([\d.]+)% used \(([\d.]+)% left\)/.exec(next);
			if (accountRow) {
				account = accountRow[1]!;
				usedPercent = Number.parseFloat(accountRow[2]!);
				leftPercent = Number.parseFloat(accountRow[3]!);
				continue;
			}
			const resetRow = /^\s+resets? in (.+)$/.exec(next);
			if (resetRow) {
				resetsIn = resetRow[1]!;
				continue;
			}
			if (/^\s*- /.test(next) || (next && !next.startsWith(" "))) break;
		}
		limits.push({ label, account, usedPercent, leftPercent, resetsIn });
	}
	if (limits.length === 0 && models.length === 0) return null;
	return { provider, fetchedLabel, models, limits };
}

/** Bar color by consumption — semantic (ok/warn/err) like the TUI's green/
 *  amber/red, but via the GUI tokens. */
export function usageBarClass(usedPercent: number): string {
	if (usedPercent >= 85) return "tr-usage-bar--err";
	if (usedPercent >= 50) return "tr-usage-bar--warn";
	return "tr-usage-bar--ok";
}

export function UsageCard({ usage }: { usage: ParsedUsage }): ReactNode {
	return (
		<div className="tr-usage-card" role="region" aria-label="Usage report">
			<div className="tr-usage-head">
				<span className="tr-usage-provider">{usage.provider || "Usage"}</span>
				{usage.fetchedLabel && <span className="tr-usage-fetched">{usage.fetchedLabel} ago</span>}
			</div>
			{usage.models.length > 0 && (
				<div className="tr-usage-models">
					<div className="tr-usage-models-label">Models with usage data</div>
					<div className="tr-usage-model-chips">
						{usage.models.slice(0, 8).map(m => (
							<span key={m} className="tr-usage-chip">
								{m}
							</span>
						))}
						{usage.models.length > 8 && (
							<span className="tr-usage-chip tr-usage-chip--more">+{usage.models.length - 8}</span>
						)}
					</div>
				</div>
			)}
			{usage.limits.length > 0 && (
				<div className="tr-usage-limits">
					{usage.limits.map((limit, i) => (
						<div key={`${limit.label}-${i}`} className="tr-usage-limit">
							<div className="tr-usage-limit-row">
								<span className="tr-usage-limit-label">{limit.label}</span>
								<span className="tr-usage-limit-pct">
									{limit.usedPercent.toFixed(0)}% used · {limit.leftPercent.toFixed(0)}% left
								</span>
							</div>
							<div className="tr-usage-limit-acct">{limit.account}</div>
							<div className="tr-usage-bar-track">
								<div
									className={`tr-usage-bar ${usageBarClass(limit.usedPercent)}`}
									style={{ width: `${Math.min(100, Math.max(0, limit.usedPercent))}%` }}
								/>
							</div>
							{limit.resetsIn && <div className="tr-usage-reset">resets in {limit.resetsIn}</div>}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
