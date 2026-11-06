import { t } from "@musepi/client-core";
import { formatBytes } from "@musepi/pi-utils/format";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient } from "../../lib/rpc";

interface ShellMinimizerFilterStats {
	filter: string;
	commands: number;
	inputBytes: number;
	outputBytes: number;
	savedBytes: number;
}

interface ShellMinimizerStats {
	totalCommands: number;
	totalInputBytes: number;
	totalOutputBytes: number;
	totalSavedBytes: number;
	savingsPct: number;
	byFilter: ShellMinimizerFilterStats[];
}

export function ShellMinimizerStatsCard({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [stats, setStats] = useState<ShellMinimizerStats | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const generation = useRef(0);

	const load = useCallback(async (): Promise<void> => {
		if (!rpc) return;
		const current = ++generation.current;
		setLoading(true);
		try {
			const next = await rpc.request<ShellMinimizerStats>("settings.shellMinimizerStats");
			if (current !== generation.current) return;
			setStats(next);
			setError(null);
		} catch (err) {
			if (current !== generation.current) return;
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			if (current === generation.current) setLoading(false);
		}
	}, [rpc]);

	useEffect(() => {
		void load();
		return () => {
			generation.current += 1;
		};
	}, [load]);

	return (
		<section className="gui-settings-section">
			<div className="gui-minimizer-stats-head">
				<div>
					<h3 className="gui-settings-section-title">{t("settings.shell.minimizerStats.title")}</h3>
					<p className="gui-settings-section-desc">{t("settings.shell.minimizerStats.desc")}</p>
				</div>
				<button type="button" className="gui-btn" disabled={loading || !rpc} onClick={() => void load()}>
					{t("settings.refresh")}
				</button>
			</div>
			{error && <div className="gui-settings-row-desc text-[var(--color-warning)]">{error}</div>}
			<div className="gui-schema-card gui-minimizer-stats-card">
				{loading && !stats ? (
					<div className="gui-settings-row-desc">{t("settings.loading")}</div>
				) : !stats || stats.totalCommands === 0 ? (
					<div className="gui-settings-row-desc">{t("settings.shell.minimizerStats.empty")}</div>
				) : (
					<>
						<div className="gui-minimizer-stats-summary">
							<strong>
								{t("settings.shell.minimizerStats.summary", {
									count: stats.totalCommands,
									saved: formatBytes(stats.totalSavedBytes),
								})}
							</strong>
							<span>{t("settings.shell.minimizerStats.percentage", { pct: stats.savingsPct.toFixed(1) })}</span>
						</div>
						<progress
							className="gui-minimizer-stats-progress"
							max={100}
							value={stats.savingsPct}
							aria-label={t("settings.shell.minimizerStats.progressLabel")}
						/>
						<div className="gui-minimizer-stats-filters">
							{stats.byFilter.map(row => (
								<div key={row.filter} className="gui-minimizer-stats-filter">
									<span>
										{t("settings.shell.minimizerStats.filterRow", {
											filter: row.filter,
											count: row.commands,
											saved: formatBytes(row.savedBytes),
										})}
									</span>
								</div>
							))}
						</div>
					</>
				)}
			</div>
		</section>
	);
}
