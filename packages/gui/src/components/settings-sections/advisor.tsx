import { type TranslationKey, t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { tapFeedback } from "../../lib/haptic";
import type { RpcClient } from "../../lib/rpc";
import { Icon } from "../../vendor/oc-icons";
import { fmtCompact, fmtCost } from "./usage";

/* ============ 智能体: 顾问 ============ */

/** Advisor lifecycle status reported by the daemon (session.advisor). */
type AdvisorStatus = "running" | "paused" | "quota_exhausted" | "error" | "no_model";

interface AdvisorTokenCounts {
	input: number;
	output: number;
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}
interface AdvisorMessages {
	user: number;
	assistant: number;
	total: number;
}
/** One advisor's session-level totals (session.advisor → stats.advisors). */
interface AdvisorRow {
	name: string;
	status: AdvisorStatus;
	model?: string;
	contextWindow?: number;
	contextTokens?: number;
	tokens?: AdvisorTokenCounts;
	cost?: number;
	messages?: AdvisorMessages;
	sessionId?: string;
}
/** Rolled-up counters for the whole advisor roster. */
interface AdvisorStats {
	configured: number;
	active: number;
	model?: string;
	contextWindow?: number;
	contextTokens?: number;
	tokens: AdvisorTokenCounts;
	cost: number;
	messages: AdvisorMessages;
	advisors: AdvisorRow[];
}
/** session.advisor → { enabled, stats, overview } (stats null before any
 *  advisor has run; overview always present). */
interface AdvisorData {
	enabled: boolean;
	stats: AdvisorStats | null;
	overview: {
		configured: boolean;
		advisors: { name: string; status: AdvisorStatus }[];
	};
}

/** i18n key per status enum — chip text follows the locale. */
const STATUS_KEYS: Record<AdvisorStatus, TranslationKey> = {
	running: "running",
	paused: "paused",
	quota_exhausted: "quota exhausted",
	error: "error",
	no_model: "no model assigned",
};

/** Settings → 智能体 → 顾问: WATCHDOG.yml passive-review advisors (TUI
 *  /advisor parity). Toggle + roster with per-advisor totals, polled every
 *  10s while a session is active. */
export function AdvisorSection({ rpc, sessionId }: { rpc: RpcClient | null; sessionId: string | null }): ReactNode {
	const [data, setData] = useState<AdvisorData | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async (): Promise<void> => {
		if (!rpc || !sessionId) return;
		try {
			const d = await rpc.request<AdvisorData>("session.advisor", { sessionId });
			setData(d);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}, [rpc, sessionId]);

	useEffect(() => {
		void load();
		const timer = setInterval(() => {
			void load();
		}, 10_000);
		return () => clearInterval(timer);
	}, [load]);

	const toggle = async (): Promise<void> => {
		if (!rpc || !sessionId || !data) return;
		setBusy(true);
		try {
			const next = !data.enabled;
			const res = await rpc.request<{ enabled: boolean }>("session.setAdvisorEnabled", {
				sessionId,
				enabled: next,
			});
			setData(d => (d ? { ...d, enabled: res?.enabled ?? next } : d));
			// Refresh immediately — the roster may have changed (enable
			// spawns advisors, disable tears them down).
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const stats = data?.stats ?? null;
	const rows: AdvisorRow[] = data?.stats?.advisors
		? data.stats.advisors
		: (data?.overview.advisors.map(a => ({ name: a.name, status: a.status })) ?? []);
	const configured = data?.overview.configured ?? false;

	return (
		<>
			<h2 className="gui-settings-page-title">{t("advisor settings")}</h2>
			<p className="gui-settings-page-desc">{t("advisor settings description")}</p>

			{/* ── Enable / disable ─────────────────────────────────────────── */}
			<div className="gui-settings-row">
				<div>
					<div className="gui-settings-row-label">{t("advisor enabled")}</div>
					<div className="gui-settings-row-desc">{t("advisor enabled desc")}</div>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={data?.enabled ?? false}
					disabled={busy || !rpc || !sessionId || !data}
					className={`gui-toggle${data?.enabled ? " gui-toggle--on" : ""}`}
					onClick={() => {
						tapFeedback();
						void toggle();
					}}
					aria-label={t("advisor enabled")}
				>
					<span className="gui-toggle-knob" />
				</button>
			</div>

			{error ? (
				<div className="gui-settings-row text-[13px] text-[var(--color-error)]">{error}</div>
			) : !sessionId ? (
				<div className="gui-settings-row text-[13px] text-[var(--color-text-faint)]">{t("select a session")}</div>
			) : !data ? (
				<div className="gui-settings-row text-[13px] text-[var(--color-text-faint)]">…</div>
			) : !configured ? (
				<div className="gui-settings-row">
					<div>
						<div className="gui-settings-row-label">{t("advisor watchdog path")}</div>
						<div className="gui-settings-row-desc">{t("advisor configure hint")}</div>
					</div>
				</div>
			) : (
				<>
					{/* ── Rolled-up overview ─────────────────────────────────── */}
					<div className="grid grid-cols-2 gap-2 pt-1 sm:grid-cols-3">
						{[
							{
								icon: "settings-3",
								label: t("advisor configured"),
								value: String(stats?.configured ?? (configured ? rows.length : 0)),
							},
							{
								icon: "pulse",
								label: t("advisor active"),
								value: String(stats?.active ?? rows.filter(r => r.status === "running").length),
							},
							{ icon: "scales-3", label: t("advisor cost"), value: stats ? fmtCost(stats.cost) : "—" },
							{
								icon: "flashlight",
								label: t("advisor tokens"),
								value: stats ? fmtCompact(stats.tokens.total) : "—",
							},
							{
								icon: "chat-3",
								label: t("advisor messages"),
								value: stats ? fmtCompact(stats.messages.total) : "—",
							},
							{ icon: "ai-agent", label: t("model"), value: stats?.model ?? "—" },
						].map(card => (
							<div key={card.label} className="gui-stats-card">
								<div className="truncate font-mono text-[17px] font-semibold leading-none" title={card.value}>
									{card.value}
								</div>
								<div className="flex items-center justify-between gap-1.5 text-[11px] text-[var(--color-text-faint)]">
									<span className="flex min-w-0 items-center gap-1.5">
										<Icon name={card.icon as never} className="h-3 w-3 shrink-0" />
										<span className="truncate">{card.label}</span>
									</span>
								</div>
							</div>
						))}
					</div>

					{/* ── Per-advisor roster ────────────────────────────────── */}
					{rows.length > 0 && (
						<div className="gui-settings-section">
							<div className="gui-settings-section-title">{t("advisor roster")}</div>
							<div className="mt-2 overflow-hidden rounded-xl border border-[var(--border)]">
								<div
									className="grid gap-x-3 border-b border-[var(--border)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-text-faint)]"
									style={{
										gridTemplateColumns:
											"minmax(0,1.6fr) minmax(0,1fr) minmax(0,1.4fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.9fr)",
										background: "color-mix(in oklab, var(--color-surface-raised) 45%, transparent)",
									}}
								>
									<span>{t("name")}</span>
									<span>{t("status")}</span>
									<span>{t("model")}</span>
									<span>{t("advisor cost")}</span>
									<span>{t("advisor tokens")}</span>
									<span>{t("advisor messages")}</span>
								</div>
								{rows.map(row => (
									<div
										key={row.name}
										className="grid items-center gap-x-3 border-b border-[var(--border)] px-3 py-2 text-[12.5px] last:border-b-0"
										style={{
											gridTemplateColumns:
												"minmax(0,1.6fr) minmax(0,1fr) minmax(0,1.4fr) minmax(0,0.9fr) minmax(0,0.9fr) minmax(0,0.9fr)",
										}}
									>
										<span className="truncate font-medium text-[var(--color-text)]" title={row.name}>
											{row.name}
										</span>
										<span className={`gui-advisor-status gui-advisor-status--${row.status}`}>
											{t("advisor status {status}", { status: t(STATUS_KEYS[row.status]) })}
										</span>
										<span
											className="truncate font-mono text-[11.5px] text-[var(--color-text-muted)]"
											title={row.model}
										>
											{row.model ?? "—"}
										</span>
										<span className="truncate font-mono text-[11.5px] text-[var(--color-text-muted)]">
											{row.cost != null ? fmtCost(row.cost) : "—"}
										</span>
										<span className="truncate font-mono text-[11.5px] text-[var(--color-text-muted)]">
											{row.tokens?.total != null ? fmtCompact(row.tokens.total) : "—"}
										</span>
										<span className="truncate font-mono text-[11.5px] text-[var(--color-text-muted)]">
											{row.messages?.total != null ? fmtCompact(row.messages.total) : "—"}
										</span>
									</div>
								))}
							</div>
						</div>
					)}
				</>
			)}
		</>
	);
}
