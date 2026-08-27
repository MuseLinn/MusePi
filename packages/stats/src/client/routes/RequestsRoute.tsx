import { getRecentRequests } from "../api";
import { formatCost, formatDurationMs, formatInteger, formatRelativeTime } from "../data/formatters";
import { useResource } from "../data/useResource";
import { t } from "../i18n";
import { useLocale } from "../i18n/use-locale";
import type { MessageStats, TimeRange } from "../types";
import { AsyncBoundary, DataTable, Panel, StatusPill } from "../ui";

export interface RequestsRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
	onRequestClick: (id: number) => void;
}

export function RequestsRoute({ active, refreshTrigger, onRequestClick }: RequestsRouteProps) {
	const locale = useLocale();
	const {
		data: recentRequests,
		error,
		loading,
	} = useResource(["recent-requests-dense", refreshTrigger], signal => getRecentRequests(50, signal), {
		pollMs: 30000,
		enabled: active,
	});

	const columns = [
		{
			key: "model",
			header: t("Model"),
			render: (item: MessageStats) => (
				<div>
					<div className="stats-font-medium stats-text-primary">{item.model}</div>
					<div className="stats-text-xs stats-text-muted">{item.provider}</div>
				</div>
			),
		},
		{
			key: "timestamp",
			header: t("Time"),
			render: (item: MessageStats) => formatRelativeTime(item.timestamp),
		},
		{
			key: "tokens",
			header: t("Tokens"),
			numeric: true,
			render: (item: MessageStats) => formatInteger(item.usage.totalTokens),
		},
		{
			key: "cost",
			header: t("Cost"),
			numeric: true,
			render: (item: MessageStats) => formatCost(item.usage.cost.total, 4),
		},
		{
			key: "duration",
			header: t("Duration"),
			numeric: true,
			render: (item: MessageStats) => formatDurationMs(item.duration),
		},
		{
			key: "status",
			header: t("Status"),
			className: "stats-text-center",
			render: (item: MessageStats) => (
				<StatusPill variant={item.errorMessage ? "danger" : "success"}>
					{item.errorMessage ? t("Failed") : t("Success")}
				</StatusPill>
			),
		},
	];

	const renderMobileCard = (item: MessageStats, onClick?: () => void) => (
		<div className="stats-mobile-card" onClick={onClick}>
			<div className="stats-mobile-card-header">
				<div>
					<div className="stats-font-semibold stats-text-primary">{item.model}</div>
					<div className="stats-text-xs stats-text-muted">{item.provider}</div>
				</div>
				<StatusPill variant={item.errorMessage ? "danger" : "success"}>
					{item.errorMessage ? "Failed" : "Success"}
				</StatusPill>
			</div>
			<div className="stats-mobile-card-grid">
				<div>
					<div className="stats-mobile-card-label">{t("Time")}</div>
					<div className="stats-mobile-card-value">{formatRelativeTime(item.timestamp)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">{t("Cost")}</div>
					<div className="stats-mobile-card-value">{formatCost(item.usage.cost.total, 4)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">{t("Tokens")}</div>
					<div className="stats-mobile-card-value">{formatInteger(item.usage.totalTokens)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">{t("Duration")}</div>
					<div className="stats-mobile-card-value">{formatDurationMs(item.duration)}</div>
				</div>
			</div>
			{item.errorMessage && <div className="stats-mobile-card-error truncate mt-2">{item.errorMessage}</div>}
		</div>
	);

	return (
		<div className="stats-route-container">
			<Panel title={t("All Recent Requests")} subtitle={t("Up to 50 most recent requests processed by OMP")}>
				<AsyncBoundary loading={loading} error={error} data={recentRequests}>
					<DataTable
						columns={columns}
						data={recentRequests || []}
						keyExtractor={item => item.id || `${item.sessionFile}-${item.entryId}`}
						onRowClick={item => item.id && onRequestClick(item.id)}
						renderMobileCard={renderMobileCard}
						emptyText={t("No recent requests found")}
					/>
				</AsyncBoundary>
			</Panel>
		</div>
	);
}
