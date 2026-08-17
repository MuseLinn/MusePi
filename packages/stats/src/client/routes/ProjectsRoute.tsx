import { useMemo } from "react";
import { getFolderStats } from "../api";
import { formatCost, formatDurationMs, formatInteger, formatPercent } from "../data/formatters";
import { useResource } from "../data/useResource";
import { buildFolderRows, type FolderRowView } from "../data/view-models";
import { t } from "../i18n";
import { useLocale } from "../i18n/use-locale";
import type { TimeRange } from "../types";
import { AsyncBoundary, DataTable, Panel, StatusPill } from "../ui";

export interface ProjectsRouteProps {
	active: boolean;
	range: TimeRange;
	refreshTrigger: number;
}

export function ProjectsRoute({ active, range, refreshTrigger }: ProjectsRouteProps) {
	// biome-ignore lint/correctness/noUnusedVariables: subscribe to locale so t() labels refresh on language switch
	const locale = useLocale();
	const {
		data: foldersData,
		error,
		loading,
	} = useResource(["projects", range, refreshTrigger], signal => getFolderStats(range, signal), {
		pollMs: 30000,
		enabled: active,
	});

	const folderRows = useMemo(() => {
		if (!foldersData) return [];
		return buildFolderRows(foldersData);
	}, [foldersData]);

	const columns = [
		{
			key: "folder",
			header: t("Project/Folder"),
			render: (item: FolderRowView) => (
				<div
					className="stats-font-medium stats-text-primary truncate max-w-[440px]"
					title={item.folder || t("(root)")}
				>
					{item.folder || t("(root)")}
				</div>
			),
		},
		{
			key: "totalRequests",
			header: t("Requests"),
			numeric: true,
			render: (item: FolderRowView) => (
				<div className="stats-text-right">
					<div className="font-mono">{formatInteger(item.totalRequests)}</div>
					<div className="stats-progress-bar-track mt-1 ml-auto w-24 h-1">
						<div
							className="stats-progress-bar-fill"
							data-variant="link"
							style={{ width: `${item.requestsPercentage}%` }}
						/>
					</div>
				</div>
			),
		},
		{
			key: "totalCost",
			header: t("Cost"),
			numeric: true,
				render: (item: FolderRowView) => (
					<div className="stats-text-right">
						<div className="font-mono">{formatCost(item.totalCost)}</div>
						<div className="stats-progress-bar-track mt-1 ml-auto w-24 h-1">
							<div
								className="stats-progress-bar-fill"
								data-variant="success"
								style={{ width: `${item.costPercentage}%` }}
							/>
						</div>
					</div>
				),
			},
			{
				key: "totalTokens",
				header: "Tokens",
				numeric: true,
				render: (item: FolderRowView) => (
					<div className="font-mono">{formatInteger(item.totalInputTokens + item.totalOutputTokens)}</div>
				),
			},
			{
				key: "cacheRate",
				header: "Cache Rate",
				numeric: true,
				render: (item: FolderRowView) => <span className="font-mono">{formatPercent(item.cacheRate)}</span>,
			},
			{
				key: "cacheSavings",
				header: "Cache Savings",
				numeric: true,
				render: (item: FolderRowView) => (
					<span className={`${item.cacheSavings < 0 ? "stats-text-danger" : "stats-text-success"} font-medium`}>
						{formatPercent(item.cacheSavings)}
					</span>
				),
			},
			{
				key: "errorRate",
				header: "Error Rate",
				numeric: true,
				render: (item: FolderRowView) => (
					<StatusPill variant={item.errorRate > 0.1 ? "danger" : item.errorRate > 0 ? "warning" : "success"}>
						{formatPercent(item.errorRate)}
					</StatusPill>
				),
			},
			{
				key: "avgDuration",
				header: "Avg Duration",
				numeric: true,
				render: (item: FolderRowView) => formatDurationMs(item.avgDuration),
			},
	];
	const renderMobileCard = (item: FolderRowView) => (
		<div className="stats-mobile-card">
			<div className="stats-mobile-card-header mb-2">
				<div className="stats-font-semibold stats-text-primary">{item.folder || t("(root)")}</div>
				<StatusPill variant={item.errorRate > 0.1 ? "danger" : item.errorRate > 0 ? "warning" : "success"}>
					{t("{0} Err", formatPercent(item.errorRate))}
				</StatusPill>
			</div>
			<div className="stats-mobile-card-grid">
				<div>
					<div className="stats-mobile-card-label">{t("Requests")}</div>
					<div className="stats-mobile-card-value font-mono">{formatInteger(item.totalRequests)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">{t("Cost")}</div>
					<div className="stats-mobile-card-value font-mono">{formatCost(item.totalCost)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">Cache Rate</div>					<div className="stats-mobile-card-value">{formatPercent(item.cacheRate)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">Cache Savings</div>
					<div className="stats-mobile-card-value">{formatPercent(item.cacheSavings)}</div>
				</div>
				<div>
					<div className="stats-mobile-card-label">Duration</div>					<div className="stats-mobile-card-value">{formatDurationMs(item.avgDuration)}</div>
				</div>
			</div>
		</div>
	);

	return (
		<div className="stats-route-container">
			<Panel title={t("Projects & Folders")} subtitle={t("Aggregate proxy metrics grouped by folder path")}>
				<AsyncBoundary
					loading={loading}
					error={error}
					data={foldersData}
					emptyText={t("No project folders recorded for this range.")}
				>
					<DataTable
						columns={columns}
						data={folderRows}
						keyExtractor={item => item.folder}
						renderMobileCard={renderMobileCard}
						emptyText={t("No project folders recorded for this range.")}
					/>
				</AsyncBoundary>
			</Panel>
		</div>
	);
}
