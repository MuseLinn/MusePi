/**
 * Tray menu window entry (tray-menu.html) — the self-drawn frosted tray
 * menu. Windows: the native Electron Menu renders as a classic Win32 menu
 * (no acrylic), so the tray menu is a real BrowserWindow with DWM Acrylic
 * (same recipe as the bubble window) that pops above the tray icon.
 * macOS/Linux keep the native Menu (system vibrancy / theme glass).
 *
 * The main process owns the window + positioning; this renderer only
 * paints. Snapshot state arrives over IPC (same payload the native menu
 * consumed: sessions, approvals, usage+plans); actions round-trip through
 * the same tray onAction switch in main.cjs.
 *
 * The window is FIXED-size (main.cjs TRAY_MENU_HEIGHT): the header and
 * footer stay pinned and the middle (approvals + sessions + usage) scrolls
 * internally when content overflows.
 */

import { type ReactNode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { t } from "./i18n/index.js";

// Theme tokens first — the tray window renders without them today, so every
// var(--color-*) (text, borders, the unified scrollbar thumb) falls back to
// unstyled defaults.
import "@musepi/desktop-web/src/styles/tokens.css";
import "./styles/gui.css";
import "./styles/gui-taskcenter.css";

interface TrayAccount {
	label: string;
	used: number;
	limit?: number;
	fraction: number;
	resetsIn?: number;
}
interface TrayWindow {
	label: string;
	windowLabel?: string;
	accounts: TrayAccount[];
}
interface TrayAccountReport {
	provider: string;
	plan?: string;
	windows: TrayWindow[];
}

interface TraySnapshot {
	sessions?: { id: string; title?: string; timestamp?: string; paused?: boolean }[];
	activeCount?: number;
	approvals?: { id: string; sessionId: string; tool: string; prompt: string }[];
	usage?: {
		totalTokens?: number;
		totalCost?: number;
		topModels?: { name: string; cost: number }[];
		plans?: { provider: string; label: string }[];
		accounts?: TrayAccountReport[];
	};
}

interface TrayMenuBridge {
	onSnapshot(cb: (s: TraySnapshot) => void): () => void;
	action(type: string, params?: Record<string, unknown>): void;
}

// preload exposes the bridge as window.electronAPI.trayMenu (NOT a top-level
// window.trayMenu — contextBridge namespaces everything under electronAPI).
// Cross-realm boundary: narrow with `in`, then cast to the bridge shape.
function resolveTrayApi(): TrayMenuBridge | undefined {
	const api = (window as unknown as Record<string, unknown>).electronAPI;
	if (api && typeof api === "object" && "trayMenu" in api) return api.trayMenu as TrayMenuBridge;
	return undefined;
}
const trayApi = resolveTrayApi();

/** Compact relative time (same style as the native menu). */
function timeLabel(iso?: string): string {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	const diff = Date.now() - d.getTime();
	if (diff < 60_000) return t("just now");
	if (diff < 3_600_000) return t("{count} min ago", { count: String(Math.floor(diff / 60_000)) });
	if (diff < 86_400_000) return t("{count} h ago", { count: String(Math.floor(diff / 3_600_000)) });
	return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatTokens(n?: number): string {
	if (n === undefined || !Number.isFinite(n)) return "0";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
	return String(n);
}

// ── Usage model: provider-grouped, credential-columned ──────────────────
// The daemon emits one report per credential, so a provider with two
// credentials appears twice in `accounts` — keying by provider alone would
// collide. Merge the reports per provider, align their limit-windows, and
// render each credential as a column with the aggregate at the far right
// (the tray analogue of TUI /usage).

/** One limit-window row inside a provider group; `cells` are the
 *  side-by-side credential columns. */
interface UsageWindowRow {
	label: string;
	windowLabel?: string;
	cells: { cred: string; acct: TrayAccount }[];
}
interface UsageProviderRow {
	provider: string;
	plan?: string;
	windows: UsageWindowRow[];
}

/** Sum of all credential fractions — TUI /usage orders providers by this. */
function providerPressure(row: UsageProviderRow): number {
	return row.windows.reduce(
		(sum, w) => sum + w.cells.reduce((s, c) => s + (Number.isFinite(c.acct.fraction) ? c.acct.fraction : 0), 0),
		0,
	);
}

function buildUsageRows(accounts: TrayAccountReport[]): UsageProviderRow[] {
	const byProvider = new Map<string, TrayAccountReport[]>();
	for (const report of accounts) {
		const list = byProvider.get(report.provider) ?? [];
		list.push(report);
		byProvider.set(report.provider, list);
	}
	const rows: UsageProviderRow[] = [];
	for (const [provider, reports] of byProvider) {
		// Merge windows across credentials by (label, windowLabel), keeping
		// first-seen order; each credential contributes one column.
		const windows = new Map<string, UsageWindowRow>();
		for (const report of reports) {
			for (const win of report.windows ?? []) {
				const key = `${win.label}|${win.windowLabel ?? ""}`;
				const row = windows.get(key) ?? { label: win.label, windowLabel: win.windowLabel, cells: [] };
				for (const acct of (win.accounts ?? []).slice(0, 4)) {
					row.cells.push({ cred: acct.label || provider, acct });
				}
				windows.set(key, row);
			}
		}
		const windowRows = [...windows.values()]
			.map(row => ({ ...row, cells: row.cells.slice(0, 4) }))
			.filter(row => row.cells.length > 0);
		if (windowRows.length === 0) continue;
		rows.push({
			provider,
			plan: reports.map(r => r.plan).find(p => typeof p === "string" && p) ?? undefined,
			windows: windowRows,
		});
	}
	// Least-burned first, TUI /usage ordering.
	return rows.sort((a, b) => providerPressure(a) - providerPressure(b) || a.provider.localeCompare(b.provider));
}

function barClass(fraction: number): string {
	if (fraction > 0.9) return "gui-tray-menu__limit-bar gui-tray-menu__limit-bar--hot";
	if (fraction > 0.7) return "gui-tray-menu__limit-bar gui-tray-menu__limit-bar--warn";
	return "gui-tray-menu__limit-bar";
}

function barWidth(fraction: number): string {
	return `${Math.min(100, Math.max(2, fraction * 100))}%`;
}

function Menu({ snap }: { snap: TraySnapshot }): ReactNode {
	const sessions = Array.isArray(snap.sessions) ? snap.sessions : [];
	const approvals = Array.isArray(snap.approvals) ? snap.approvals : [];
	const usage = snap.usage && typeof snap.usage === "object" ? snap.usage : null;
	const active = Number.isFinite(snap.activeCount) ? (snap.activeCount ?? 0) : 0;
	const usageRows = usage?.accounts ? buildUsageRows(usage.accounts) : [];

	return (
		<div className="gui-tray-menu">
			<header className="gui-tray-menu__head">
				<span className="gui-tray-menu__brand">MusePi</span>
				{active > 0 && (
					<span className="gui-tray-menu__live">{t("{count} sessions active", { count: String(active) })}</span>
				)}
			</header>

			<div className="gui-tray-menu__scroll">
				{approvals.length > 0 && (
					<section className="gui-tray-menu__section">
						<div className="gui-tray-menu__sec-title">{t("needs your attention")}</div>
						{approvals.slice(0, 10).map(a => (
							<div key={a.id} className="gui-tray-menu__approval">
								<div className="gui-tray-menu__approval-text">
									<span className="gui-tray-menu__approval-tool">{a.tool}</span>
									<span className="gui-tray-menu__approval-prompt">{a.prompt}</span>
								</div>
								<div className="gui-tray-menu__approval-actions">
									<button
										type="button"
										onClick={() =>
											trayApi?.action("respond-approval", {
												id: a.id,
												sessionId: a.sessionId,
												approved: true,
											})
										}
									>
										{t("allow once")}
									</button>
									<button
										type="button"
										onClick={() =>
											trayApi?.action("respond-approval", {
												id: a.id,
												sessionId: a.sessionId,
												approved: true,
												remember: true,
											})
										}
									>
										{t("always allow")}
									</button>
									<button
										type="button"
										className="gui-tray-menu__deny"
										onClick={() =>
											trayApi?.action("respond-approval", {
												id: a.id,
												sessionId: a.sessionId,
												approved: false,
											})
										}
									>
										{t("deny")}
									</button>
								</div>
							</div>
						))}
					</section>
				)}

				<section className="gui-tray-menu__section">
					<div className="gui-tray-menu__sec-title">{t("recent sessions")}</div>
					{sessions.length === 0 ? (
						<div className="gui-tray-menu__empty">{t("no sessions yet")}</div>
					) : (
						sessions.slice(0, 8).map(s => (
							<button
								type="button"
								key={s.id}
								className="gui-tray-menu__session"
								onClick={() => trayApi?.action("focus-session", { sessionId: s.id })}
							>
								<span className="gui-tray-menu__session-title">{s.title || t("untitled session")}</span>
								<span className="gui-tray-menu__session-meta">
									{s.paused ? `${t("paused")} · ` : ""}
									{timeLabel(s.timestamp)}
								</span>
							</button>
						))
					)}
				</section>

				{usage && (
					<section className="gui-tray-menu__section">
						<div className="gui-tray-menu__sec-title">{t("usage")}</div>
						<div className="gui-tray-menu__totals">
							<span>Token {formatTokens(usage.totalTokens)}</span>
							<span className="gui-tray-menu__totals-sep">·</span>
							<span>${(Number.isFinite(usage.totalCost) ? usage.totalCost! : 0).toFixed(4)}</span>
						</div>
						{usageRows.length === 0 ? (
							<div className="gui-tray-menu__empty">{t("no usage data")}</div>
						) : (
							usageRows.map(row => (
								<div key={row.provider} className="gui-tray-menu__provider">
									<div className="gui-tray-menu__provider-head">
										<span className="gui-tray-menu__provider-name">{row.provider}</span>
										{row.plan && <span className="gui-tray-menu__account-plan">{row.plan}</span>}
									</div>
									{row.windows.map((w, wi) => {
										const avg =
											w.cells.reduce(
												(s, c) => s + (Number.isFinite(c.acct.fraction) ? c.acct.fraction : 0),
												0,
											) / Math.max(1, w.cells.length);
										const windowKey = `${w.label}|${w.windowLabel ?? ""}`;
										const cols = `${w.cells.map(() => "minmax(0, 1fr)").join(" ")} 56px`;
										return (
											<div key={`${windowKey}|${wi}`} className="gui-tray-menu__win">
												<div className="gui-tray-menu__win-label">
													{w.label}
													{w.windowLabel && w.windowLabel !== w.label ? ` (${w.windowLabel})` : ""}
												</div>
												<div className="gui-tray-menu__win-cols" style={{ gridTemplateColumns: cols }}>
													{w.cells.map((c, ci) => (
														<div
															key={`${row.provider}|${wi}|${ci}:${c.cred}`}
															className="gui-tray-menu__cell"
															title={c.cred}
														>
															<div className="gui-tray-menu__cell-label">{c.cred}</div>
															<div className="gui-tray-menu__limit-track">
																<div
																	className={barClass(c.acct.fraction)}
																	style={{ width: barWidth(c.acct.fraction) }}
																/>
															</div>
															<div className="gui-tray-menu__cell-num">
																{formatTokens(c.acct.used)}
																{c.acct.limit !== undefined ? ` / ${formatTokens(c.acct.limit)}` : ""}
																{c.acct.resetsIn !== undefined
																	? ` · ${Math.ceil(c.acct.resetsIn / 3_600_000)}h`
																	: ""}
															</div>
														</div>
													))}
													<div className="gui-tray-menu__cell gui-tray-menu__cell--total">
														<div className="gui-tray-menu__cell-label">{t("total")}</div>
														<div className="gui-tray-menu__limit-track">
															<div className={barClass(avg)} style={{ width: barWidth(avg) }} />
														</div>
														<div className="gui-tray-menu__cell-num">{Math.round(avg * 100)}%</div>
													</div>
												</div>
											</div>
										);
									})}
								</div>
							))
						)}
					</section>
				)}
			</div>

			<footer className="gui-tray-menu__foot">
				<button type="button" onClick={() => trayApi?.action("new-session")}>
					{t("new session")}
				</button>
				<button type="button" onClick={() => trayApi?.action("mini-chat")}>
					{t("mini chat")}
				</button>
				<button type="button" onClick={() => trayApi?.action("show-main-window")}>
					{t("show main window")}
				</button>
				<button type="button" onClick={() => trayApi?.action("quit")}>
					{t("quit")}
				</button>
			</footer>
		</div>
	);
}

function TrayMenuApp(): ReactNode {
	const [snap, setSnap] = useState<TraySnapshot>({});
	useEffect(() => {
		const off = trayApi?.onSnapshot(s => setSnap(s));
		return () => off?.();
	}, []);
	return <Menu snap={snap} />;
}

createRoot(document.getElementById("root")!).render(<TrayMenuApp />);
