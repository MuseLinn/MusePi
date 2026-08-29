import { BarChart, LineChart, t } from "@musepi/desktop-web";
import { LoaderCircle as LoaderCircleIconData, RefreshCw as RefreshCwIconData } from "lucide";
import { MorphIcon } from "morphicons/react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { tapFeedback } from "../../lib/haptic";
import type { RpcClient } from "../../lib/rpc";
import { Icon } from "../../vendor/oc-icons";

/* ============ 数据与统计: 使用统计 / 索引库 / 钩子 ============ */

/** Compact number formatting (K/M/B — always en-US per user preference). */
export function fmtCompact(n: number): string {
	if (!Number.isFinite(n)) return "—";
	const abs = Math.abs(n);
	if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
	if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
	if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
	return String(Math.round(n));
}

export function fmtCost(n: number): string {
	if (n < 0.01) return `$${n.toFixed(4)}`;
	if (n < 1) return `$${n.toFixed(3)}`;
	return `$${n.toFixed(2)}`;
}

export function fmtMs(n: number | null): string {
	return n == null ? "—" : `${Math.round(n)}ms`;
}

/** Stats wire shapes (subset of @musepi/musepi-stats shared-types). */
interface UsageAggregated {
	totalRequests: number;
	successfulRequests: number;
	failedRequests: number;
	errorRate: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	totalCost: number;
	avgDuration: number | null;
	avgTtft: number | null;
	avgTokensPerSecond: number | null;
	firstTimestamp: number;
	lastTimestamp: number;
}
interface UsageModel extends UsageAggregated {
	model: string;
	provider: string;
}
interface UsageFolder extends UsageAggregated {
	folder: string;
}
interface UsageAgentType {
	/** "main" | "subagent" | "advisor" */
	agentType: string;
	totalRequests: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	totalCost: number;
}
interface UsagePoint {
	timestamp: number;
	requests: number;
	errors: number;
	tokens: number;
	cost: number;
}
interface ModelUsagePoint {
	timestamp: number;
	model: string;
	provider: string;
	requests: number;
	tokens: number;
}
interface UsageDashboard {
	overall: UsageAggregated;
	byModel: UsageModel[];
	byFolder: UsageFolder[];
	byAgentType: UsageAgentType[];
	timeSeries: UsagePoint[];
	modelSeries: ModelUsagePoint[];
	sessionCount: number;
}

/** localStorage key for the persisted usage dashboard snapshot. */
const DASHBOARD_CACHE_KEY = "musepi-gui-usage-stats";

type DashboardCache = Partial<Record<"7d" | "30d", { main: UsageDashboard; yearly: UsageDashboard }>>;

/** Restore the last dashboard from localStorage so a full GUI restart still
 * renders instantly instead of blanking while stats.sync + the RPC run. */
function loadPersistedDashboard(): DashboardCache {
	try {
		const raw = localStorage.getItem(DASHBOARD_CACHE_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as DashboardCache;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

/** Persist the cache for the next launch. Failure is silent — the cache only
 * accelerates paint; correctness comes from the live dashboard fetch. */
function persistDashboard(cache: DashboardCache): void {
	try {
		localStorage.setItem(DASHBOARD_CACHE_KEY, JSON.stringify(cache));
	} catch {
		// localStorage unavailable (private mode / quota) — keep the in-memory
		// cache working for this session and drop cross-launch persistence.
	}
}

/** Module-level cache (backed by localStorage): survives tab unmount AND a
 * full GUI restart. The settings tab renders the last snapshot immediately on
 * re-entry, then background-refreshes in place. */
const dashboardCache: DashboardCache = loadPersistedDashboard();

/** Settings → 数据与统计 → 使用统计: daemon stats.dashboard (packages/stats
 * aggregation over every session file) + stats.sync (incremental rescan).
 * The CLI `omp stats` dashboard is the parity reference; here the same
 * numbers render natively in the settings surface. */
export function UsageSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [stats, setStats] = useState<UsageDashboard | null>(null);
	const [heatSeries, setHeatSeries] = useState<UsageDashboard["timeSeries"]>([]);
	const [range, setRange] = useState<"7d" | "30d">("7d");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const load = useCallback(
		async (doSync: boolean, rng: "7d" | "30d", manual = false): Promise<void> => {
			if (!rpc) return;
			const cached = dashboardCache[rng];
			// Serve the cached dashboard immediately (no blank "…" on tab
			// re-entry), then refresh in place.
			if (cached) {
				setStats(cached.main);
				setHeatSeries(cached.yearly.timeSeries ?? []);
				setError(null);
			}
			// A manual refresh always shows the spinner (explicit user action
			// expects feedback); the auto re-entry path only spins when there
			// is no cache to show (first-ever visit).
			if (manual || !cached) setBusy(true);
			try {
				if (doSync) await rpc.request("stats.sync");
				const [main, yearly] = await Promise.all([
					rpc.request<UsageDashboard>("stats.dashboard", { range: rng }),
					// Yearly view for the contribution-graph heatmap — the range
					// toggle only refocuses which days are highlighted.
					rpc.request<UsageDashboard>("stats.dashboard", { range: "1y" }),
				]);
				setStats(main);
				setHeatSeries(yearly.timeSeries ?? []);
				dashboardCache[rng] = { main, yearly };
				persistDashboard(dashboardCache);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				if (!cached) setStats(null);
			} finally {
				setBusy(false);
			}
		},
		[rpc],
	);
	useEffect(() => {
		void load(true, range);
	}, [load, range]);
	const overall = stats?.overall;
	const series = stats?.timeSeries ?? [];
	const modelSeries = stats?.modelSeries ?? [];
	// ── ZCode-parity summary cards (user-facing metrics) ──────────────────
	const tokensTotal = overall
		? overall.totalInputTokens +
			overall.totalOutputTokens +
			overall.totalCacheReadTokens +
			overall.totalCacheWriteTokens
		: 0;
	const msgTotal = series.reduce((a, p) => a + p.requests, 0);
	const activeDays = series.filter(p => p.requests > 0).length;
	let streak = 0;
	for (let i = series.length - 1; i >= 0; i--) {
		if (series[i].requests > 0) streak++;
		else break;
	}
	const byRequests = [...(stats?.byModel ?? [])].sort((a, b) => b.totalRequests - a.totalRequests);
	const topModel = byRequests[0];
	const topShare =
		topModel && overall?.totalRequests ? Math.round((topModel.totalRequests / overall.totalRequests) * 100) : 0;
	const successRatePct =
		overall && overall.totalRequests > 0
			? Math.round((overall.successfulRequests / overall.totalRequests) * 1000) / 10
			: null;
	const cacheTokensTotal = overall ? overall.totalCacheReadTokens + overall.totalCacheWriteTokens : 0;
	// ── By-agent token share (main / subagent / advisor) ─────────────────
	// Fixed display order; agents absent from the range still show as 0%.
	const AGENT_META: Record<string, { label: string; color: string }> = {
		main: { label: t("main agent"), color: "#ed4abf" },
		subagent: { label: t("subagent"), color: "#9b4dff" },
		advisor: { label: t("advisor"), color: "#5ad8e6" },
	};
	const agentTokens = (stats?.byAgentType ?? []).map(a => {
		const tok = a.totalInputTokens + a.totalOutputTokens + a.totalCacheReadTokens + a.totalCacheWriteTokens;
		return { key: a.agentType, tokens: tok };
	});
	const agentTotalTokens = agentTokens.reduce((s, a) => s + a.tokens, 0);
	// ── Shared calendar window ──────────────────────────────────────────
	// Fixed 7/30 calendar days (zero-value days kept) so the heatmap grid
	// and trend bars follow real dates. `series`/`modelSeries` are day
	// buckets that only contain days with activity; they are mapped onto
	// the calendar window rather than compressed.
	const DAY_MS = 86400000;
	const rangeDays = range === "30d" ? 30 : 7;
	const keyOf = (ts: number): string => new Date(ts).toDateString();
	const dayIndex = new Map<string, (typeof series)[number]>();
	for (const p of series) {
		const k = keyOf(p.timestamp);
		if (!dayIndex.has(k)) dayIndex.set(k, p);
	}
	const todayStart = (() => {
		const d = new Date();
		d.setHours(0, 0, 0, 0);
		return d.getTime();
	})();
	const windowStart = todayStart - (rangeDays - 1) * DAY_MS;
	const windowDays: number[] = Array.from({ length: rangeDays }, (_, i) => windowStart + i * DAY_MS);
	const inWindow = (ts: number): boolean => ts >= windowStart && ts <= todayStart;
	// ── Heatmap: full-year contribution graph (GitHub parity) ───────────
	// One cell per calendar day over the last 365 days; columns are
	// calendar weeks (Mon..Sun, Monday top), today bottom-right. The
	// 7d/30d range toggle does NOT resize the graph — it refocuses which
	// days are highlighted (full color) versus dimmed history, so the
	// switch reads as a color morph over a stable grid.
	const heatMax = Math.max(1, ...heatSeries.map(p => p.tokens));
	const heatIndex = new Map<string, (typeof heatSeries)[number]>();
	for (const p of heatSeries) {
		const k = keyOf(p.timestamp);
		if (!heatIndex.has(k)) heatIndex.set(k, p);
	}
	const yearStart = todayStart - 364 * DAY_MS;
	const gridStart = yearStart - ((new Date(yearStart).getDay() + 6) % 7) * DAY_MS; // Monday of the year's first week
	const totalSlots = Math.floor((todayStart - gridStart) / DAY_MS) + 1; // ≤ 371 → ≤ 53 columns
	const heatCols = Math.ceil(totalSlots / 7);
	const heatGrid: ((typeof heatSeries)[number] | null | undefined)[][] = Array.from({ length: heatCols }, () =>
		Array(7).fill(undefined),
	);
	for (let i = 0; i < totalSlots; i++) {
		const ts = gridStart + i * DAY_MS;
		heatGrid[Math.floor(i / 7)][i % 7] = heatIndex.get(keyOf(ts)) ?? null;
	}
	const heatRowLabels = ["一", "三", "五"];
	const fmtDay = (ts: number): string =>
		new Date(ts).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
	// ── Per-model daily token trend (stacked bars) ───────────────────────
	const trendModels: string[] = [];
	for (const p of modelSeries) if (!trendModels.includes(p.model)) trendModels.push(p.model);
	const MODEL_COLORS = ["#4c8dff", "#34b97c", "#9b7bff", "#f5a742", "#e0688a", "#3ec6c8", "#8a9db5"];
	const byDay = new Map<string, Map<string, number>>();
	for (const p of modelSeries) {
		const k = keyOf(p.timestamp);
		let day = byDay.get(k);
		if (!day) {
			day = new Map();
			byDay.set(k, day);
		}
		day.set(p.model, (day.get(p.model) ?? 0) + p.tokens);
	}
	const days = windowDays;
	// One stacked serie per model, value per day (0 when the model is absent).
	const trendSeries = trendModels.map((m, i) => ({
		name: m,
		color: MODEL_COLORS[i % MODEL_COLORS.length],
		data: days.map(d => byDay.get(keyOf(d))?.get(m) ?? 0),
	}));
	const trendLabels = days.map(d => fmtDay(d));
	return (
		<>
			<h2 className="gui-settings-page-title">{t("usage statistics")}</h2>
			<p className="gui-settings-page-desc">{t("usage statistics description")}</p>
			<div className="flex items-center justify-between">
				<div className="flex gap-1 rounded-lg border border-[var(--border)] p-0.5">
					{(["7d", "30d"] as const).map(r => (
						<button
							key={r}
							type="button"
							className={`rounded-md px-3 py-1 text-[12.5px] transition-colors duration-150${
								range === r ? " bg-[var(--color-accent)] shadow-sm" : " hover:bg-[var(--color-surface-raised)]"
							}`}
							style={
								range === r
									? { color: "var(--color-accent-fg)", fontWeight: 600 }
									: { color: "var(--color-text-muted)" }
							}
							onClick={() => {
								tapFeedback();
								setRange(r);
							}}
						>
							{t(r === "7d" ? "last 7 days" : "last 30 days")}
						</button>
					))}
				</div>
				<button
					type="button"
					className="gui-btn min-w-[92px] justify-center"
					disabled={busy || !rpc}
					onClick={() => {
						tapFeedback();
						void load(true, range, true);
					}}
				>
					{/* MorphIcon springs refresh-cw ↔ loader-circle on state change;
					 * busy spins the loader. Label stays constant so the button
					 * never changes size. */}
					<MorphIcon
						icon={busy ? LoaderCircleIconData : RefreshCwIconData}
						size={14}
						spring="snappy"
						className={busy ? "gui-spin" : undefined}
					/>
					<span>{t("refresh")}</span>
				</button>
			</div>
			{error ? (
				<div className="gui-settings-row text-[13px] text-[var(--color-error)]">{error}</div>
			) : !stats || !overall ? (
				<div className="gui-settings-row text-[13px] text-[var(--color-text-faint)]">…</div>
			) : (
				<>
					<div className="grid grid-cols-2 gap-2 pt-1 sm:grid-cols-3">
						{[
							{ icon: "flashlight", label: t("token usage"), value: fmtCompact(tokensTotal), sub: null },
							{ icon: "chat-3", label: t("session count"), value: String(stats.sessionCount ?? 0), sub: null },
							{ icon: "chat-4", label: t("message count"), value: fmtCompact(msgTotal), sub: null },
							{ icon: "calendar-schedule", label: t("active days"), value: String(activeDays), sub: null },
							{ icon: "bar-chart-box", label: t("current streak"), value: String(streak), sub: null },
							{
								icon: "equalizer-2",
								label: t("most used model"),
								value: topModel ? topModel.model : "—",
								sub: topModel ? `${t("usage share")} ${topShare}%` : null,
							},
							{
								icon: "shield-check",
								label: t("success rate"),
								value: successRatePct == null ? "—" : `${successRatePct}%`,
								sub: overall ? `${fmtCompact(overall.failedRequests)} ${t("failed requests")}` : null,
							},
							{
								icon: "timer",
								label: t("avg ttft"),
								value: fmtMs(overall?.avgTtft ?? null),
								sub: null,
							},
							{
								icon: "pulse",
								label: t("tokens per second"),
								value:
									overall?.avgTokensPerSecond == null
										? "—"
										: `${fmtCompact(overall.avgTokensPerSecond)} tok/s`,
								sub: null,
							},
							{
								icon: "database-2",
								label: t("cache tokens"),
								value: fmtCompact(cacheTokensTotal),
								sub: null,
							},
						].map(card => (
							<div key={card.label} className="gui-stats-card">
								<div
									className="truncate font-mono text-[17px] font-semibold leading-none"
									title={typeof card.value === "string" && card.value.length > 18 ? card.value : undefined}
								>
									{card.value}
								</div>
								<div className="flex items-center justify-between gap-1.5 text-[11px] text-[var(--color-text-faint)]">
									<span className="flex min-w-0 items-center gap-1.5">
										<Icon name={card.icon as never} className="h-3 w-3 shrink-0" />
										<span className="truncate">{card.label}</span>
									</span>
									{card.sub && <span className="shrink-0 text-[var(--color-text-muted)]">{card.sub}</span>}
								</div>
							</div>
						))}
					</div>
					{/* Active heatmap (ZCode parity): one cell per day, depth = tokens */}
					<div className="gui-settings-section">
						<div className="flex items-center justify-between">
							<div className="gui-settings-section-title">{t("active heatmap")}</div>
							<div className="flex items-center gap-1 text-[10.5px] text-[var(--color-text-muted)]">
								<span>{t("less activity")}</span>
								<span className="flex gap-0.5">
									{[0.08, 0.2, 0.4, 0.65, 1].map(a => (
										<span
											key={a}
											className="h-2.5 w-2.5 rounded-[3px]"
											style={{
												background: `color-mix(in oklab, var(--color-accent) ${a * 100}%, transparent)`,
											}}
										/>
									))}
								</span>
								<span>{t("more activity")}</span>
							</div>
						</div>
						<div className="mt-2">
							{/* Month labels: shown when a column's data first rolls into a
							 * new month (GitHub contribution-graph style). */}
							<div className="flex gap-[2px] pl-[13px]">
								{heatGrid.map((_col, ci) => {
									// GitHub rule: the column containing the 1st of a month
									// shows that month — independent of data, so all 12
									// months label the year view.
									const firstOfMonth = Array.from(
										{ length: 7 },
										(_, r) => gridStart + (ci * 7 + r) * DAY_MS,
									).find(ts => new Date(ts).getDate() === 1);
									const label = firstOfMonth ? `${new Date(firstOfMonth).getMonth() + 1}月` : "";
									return (
										<div
											key={ci}
											className="w-[11px] whitespace-nowrap text-center text-[8.5px] leading-[11px] text-[var(--color-text-faint)]"
										>
											{label}
										</div>
									);
								})}
							</div>
							<div className="mt-[2px] flex gap-[2px]">
								{/* Weekday row labels: Mon / Wed / Fri (GitHub parity). */}
								<div
									className="grid pr-[4px] text-[8.5px] leading-none text-[var(--color-text-faint)]"
									style={{ gridTemplateRows: "repeat(7, 11px)", gap: "2px" }}
								>
									<span className="flex items-center">{heatRowLabels[0]}</span>
									<span />
									<span className="flex items-center">{heatRowLabels[1]}</span>
									<span />
									<span className="flex items-center">{heatRowLabels[2]}</span>
								</div>
								{heatGrid.map((col, ci) => (
									<div key={ci} className="flex flex-col gap-[2px]">
										{col.map((d, ri) =>
											d === undefined ? (
												// Future day (beyond today) — no cell at all.
												<div key={ri} className="h-[11px] w-[11px]" />
											) : (
												<div
													key={ri}
													title={
														d
															? `${fmtDay(d.timestamp)}: ${fmtCompact(d.tokens)} Tokens · ${d.requests} 轮`
															: undefined
													}
													className="h-[11px] w-[11px] rounded-[2px] hover:scale-110"
													style={{
														background: d
															? d.requests > 0
																? `color-mix(in oklab, var(--color-accent) ${Math.max(12, (d.tokens / heatMax) * 100)}%, transparent)`
																: "color-mix(in oklab, var(--color-text) 6%, transparent)"
															: "color-mix(in oklab, var(--color-text) 3%, transparent)",
														// Selected range (last 7/30 days) stays full color; older
														// history dims — the 7d↔30d switch morphs which days are lit.
														opacity: d && !inWindow(d.timestamp) ? 0.35 : 1,
														transition: "background 200ms ease, opacity 200ms ease, transform 100ms ease",
													}}
												/>
											),
										)}
									</div>
								))}
							</div>
						</div>
					</div>
					{/* Token usage by agent (main / subagent / advisor) — CLI parity */}
					{agentTotalTokens > 0 && (
						<div className="gui-settings-section">
							<div className="gui-settings-section-title">{t("by agent")}</div>
							<div
								className="mt-2 flex h-3 w-full overflow-hidden rounded-full"
								style={{ background: "var(--border)" }}
							>
								{Object.keys(AGENT_META).map(k => {
									const seg = agentTokens.find(a => a.key === k);
									const share = seg ? seg.tokens / agentTotalTokens : 0;
									if (share <= 0) return null;
									return (
										<div
											key={k}
											className="h-full"
											style={{ width: `${share * 100}%`, background: AGENT_META[k].color }}
											title={`${AGENT_META[k].label}: ${Math.round(share * 100)}%`}
										/>
									);
								})}
							</div>
							<div className="mt-2 space-y-1.5">
								{Object.keys(AGENT_META).map(k => {
									const seg = agentTokens.find(a => a.key === k);
									const tokens = seg?.tokens ?? 0;
									const share = agentTotalTokens > 0 ? tokens / agentTotalTokens : 0;
									return (
										<div key={k} className="flex items-center justify-between gap-3 text-[12px]">
											<div className="flex min-w-0 items-center gap-2">
												<span
													className="h-2.5 w-2.5 shrink-0 rounded-full"
													style={{ background: AGENT_META[k].color }}
												/>
												<span className="truncate text-[var(--color-text-primary)]">
													{AGENT_META[k].label}
												</span>
											</div>
											<div className="flex items-center gap-3 whitespace-nowrap">
												<span className="text-[var(--color-text-muted)]">{fmtCompact(tokens)} tok</span>
												<span className="font-mono font-semibold tabular-nums text-[var(--color-text-primary)]">
													{Math.round(share * 100)}%
												</span>
											</div>
										</div>
									);
								})}
							</div>
						</div>
					)}
					{/* Requests & errors over time — now rendered by the shared
					 * zero-dependency <LineChart> (responsive pixel-coordinate
					 * SVG, no preserveAspectRatio stretch, CSS-var theme). */}
					{series.length > 0 && (
						<div className="gui-settings-section">
							<div className="gui-settings-section-title">{t("requests & errors")}</div>
							<LineChart
								className="mt-2"
								height={120}
								yMax={Math.max(1, ...series.map(p => Math.max(p.requests, p.errors)))}
								series={[
									{ name: t("requests"), color: "#5ad8e6", data: series.map(p => p.requests) },
									{ name: t("errors"), color: "#ff6b7d", data: series.map(p => p.errors) },
								]}
								labels={series.map(p => fmtDay(p.timestamp))}
								formatY={n => fmtCompact(n)}
							/>
							<div className="mt-1.5 flex items-center gap-4 text-[10.5px] text-[var(--color-text-muted)]">
								<span className="flex items-center gap-1.5">
									<span className="h-2 w-2 rounded-full" style={{ background: "#5ad8e6" }} />
									{t("requests")}
								</span>
								<span className="flex items-center gap-1.5">
									<span className="h-2 w-2 rounded-full" style={{ background: "#ff6b7d" }} />
									{t("errors")}
								</span>
							</div>
						</div>
					)}
					{/* Daily token trend, stacked per model — shared <BarChart>.
					 * No more hand-rolled flex bars + FLIP morph: the component
					 * measures its container and renders stacked SVG rects. */}
					{days.length > 0 && (
						<div className="gui-settings-section">
							<div className="gui-settings-section-title">{t("daily token trend")}</div>
							<BarChart
								className="mt-2"
								height={140}
								series={trendSeries}
								labels={trendLabels}
								formatY={n => fmtCompact(n)}
							/>
							{trendModels.length > 1 && (
								<div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
									{trendModels.map((m, i) => (
										<span
											key={m}
											className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]"
										>
											<span
												className="h-2 w-2 rounded-full"
												style={{ background: MODEL_COLORS[i % MODEL_COLORS.length] }}
											/>
											<span className="max-w-[140px] truncate">{m}</span>
										</span>
									))}
								</div>
							)}
						</div>
					)}
					{(stats.byModel?.length ?? 0) > 0 && (
						<div className="gui-settings-section">
							<div className="gui-settings-section-title">{t("by model")}</div>
							{stats.byModel.map(m => (
								<div key={`${m.provider}:${m.model}`} className="gui-agent-card">
									<div className="min-w-0 flex-1">
										<div className="truncate text-[13px] font-medium">{m.model}</div>
										<div className="truncate text-[12px] text-[var(--color-text-muted)]">
											{m.provider} · {fmtCompact(m.totalRequests)} {t("requests")} ·{" "}
											{fmtCompact(m.totalInputTokens + m.totalOutputTokens)} tok · {fmtCost(m.totalCost)}
										</div>
									</div>
									<div className="text-right font-mono text-[12px] text-[var(--color-text-muted)]">
										{fmtMs(m.avgDuration)}
									</div>
								</div>
							))}
						</div>
					)}
					{(stats.byFolder?.length ?? 0) > 0 && (
						<div className="gui-settings-section">
							<div className="gui-settings-section-title">{t("by folder")}</div>
							{stats.byFolder.map(f => (
								<div key={f.folder} className="gui-agent-card">
									<div className="min-w-0 flex-1">
										<div className="truncate text-[13px] font-medium">{f.folder}</div>
										<div className="truncate text-[12px] text-[var(--color-text-muted)]">
											{fmtCompact(f.totalRequests)} {t("requests")} ·{" "}
											{fmtCompact(f.totalInputTokens + f.totalOutputTokens)} tok · {fmtCost(f.totalCost)}
										</div>
									</div>
								</div>
							))}
						</div>
					)}
				</>
			)}
		</>
	);
}
