import {
	formatCompact,
	formatCost,
	formatDurationMs,
	formatInteger,
	formatPercent,
	formatTokensPerSecond,
} from "../data/formatters";
import { sumConversationTokens } from "../data/view-models";
import { t } from "../i18n";
import type { AggregatedStats } from "../types";

export interface MetricClusterProps {
	stats: AggregatedStats;
}

export function MetricCluster({ stats }: MetricClusterProps) {
	const conversationTokens = sumConversationTokens(stats);

	return (
		<div className="stats-metric-cluster">
			<div className="stats-metric-primary-grid">
				<div className="stats-metric-card primary">
					<div className="stats-metric-label">{t("Total Cost")}</div>
					<div className="stats-metric-value">
						{formatCost(stats.totalCost, stats.totalCost > 0 && stats.totalCost < 0.01 ? 4 : 2)}
					</div>
				</div>
				<div className="stats-metric-card primary">
					<div className="stats-metric-label">{t("Requests")}</div>
					<div className="stats-metric-value">{formatInteger(stats.totalRequests)}</div>
				</div>
				<div className="stats-metric-card primary">
					<div className="stats-metric-label">{t("Cache Rate")}</div>
					<div className="stats-metric-value">{formatPercent(stats.cacheRate)}</div>
				</div>
				<div className="stats-metric-card primary">
					<div className="stats-metric-label">{t("Error Rate")}</div>
					<div className="stats-metric-value">{formatPercent(stats.errorRate)}</div>
				</div>
			</div>

			<div className="stats-metric-secondary-grid">
				<div className="stats-metric-card secondary" title={t("Conversation input not served from cache")}>
					<div className="stats-metric-label">{t("Uncached Input")}</div>
					<div className="stats-metric-value">{formatCompact(stats.totalInputTokens)}</div>
				</div>
				<div className="stats-metric-card secondary" title={t("Conversation input read from the prompt cache")}>
					<div className="stats-metric-label">{t("Cache Read")}</div>
					<div className="stats-metric-value">{formatCompact(stats.totalCacheReadTokens)}</div>
				</div>
				<div className="stats-metric-card secondary">
					<div className="stats-metric-label">{t("Output Tokens")}</div>
					<div className="stats-metric-value">{formatCompact(stats.totalOutputTokens)}</div>
				</div>
				<div
					className="stats-metric-card secondary"
					title={t("Uncached input + cache reads + cache writes + output")}
				>
					<div className="stats-metric-label">{t("Conversation Total")}</div>
					<div className="stats-metric-value">{formatCompact(conversationTokens)}</div>
				</div>
				<div className="stats-metric-card secondary">
					<div className="stats-metric-label">{t("Premium Requests")}</div>
					<div className="stats-metric-value">{formatInteger(stats.totalPremiumRequests)}</div>
				</div>
				<div className="stats-metric-card secondary">
					<div className="stats-metric-label">{t("Tokens/s")}</div>
					<div className="stats-metric-value">{formatTokensPerSecond(stats.avgTokensPerSecond)}</div>
				</div>
				<div className="stats-metric-card secondary">
					<div className="stats-metric-label">{t("Avg Latency")}</div>
					<div className="stats-metric-value">{formatDurationMs(stats.avgDuration)}</div>
				</div>
				<div className="stats-metric-card secondary">
					<div className="stats-metric-label">{t("Avg TTFT")}</div>
					<div className="stats-metric-value">{formatDurationMs(stats.avgTtft)}</div>
				</div>
			</div>
		</div>
	);
}
