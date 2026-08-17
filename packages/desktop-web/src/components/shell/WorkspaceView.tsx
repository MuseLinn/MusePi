import { ChevronRight, Loader2, PanelLeft, PanelLeftClose } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { t } from "../../i18n/index.js";
import type { GuestClient } from "../../lib/client";
import { shortenPath } from "../../lib/format";
import type { WorkspaceSessionInfo } from "@musepi/pi-wire";

/**
 * Multi-session workspace: a directory of session cards so remote guests can
 * watch work progress across the whole host, then focus any live session.
 * Deliberately light — no transcripts here, just working/paused state and
 * counts, per the "focus on work progress" design. A collapsible session
 * list sidebar mirrors the desktop shell's left rail for quick scanning.
 */
export function WorkspaceView({
	client,
	sessions,
	onSelect,
}: {
	client: GuestClient;
	sessions: readonly WorkspaceSessionInfo[];
	onSelect(sessionId: string): void;
}): ReactNode {
	const [sidebarOpen, setSidebarOpen] = useState(true);
	// Collapsed project groups (keyed by cwd; "" = no folder).
	const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
	const groups = useMemo(() => groupByProject(sessions), [sessions]);
	return (
		<div className="sh-workspace">
			<aside className={`sh-ws-sidebar${sidebarOpen ? "" : " sh-ws-sidebar--closed"}`}>
				<button
					type="button"
					className="sh-ws-sidebar-toggle"
					onClick={() => setSidebarOpen(v => !v)}
					aria-label={sidebarOpen ? t("collapse session list") : t("expand session list")}
					title={sidebarOpen ? t("collapse session list") : t("expand session list")}
				>
					{sidebarOpen ? <PanelLeftClose size={14} /> : <PanelLeft size={14} />}
				</button>
				{sidebarOpen && (
					<>
						<div className="sh-ws-sidebar-head">{t("projects")}</div>
						<div className="sh-ws-sidebar-list">
							{groups.map(group => {
								const key = group.cwd ?? "";
								const collapsed = collapsedGroups.has(key);
								return (
									<section key={key} className="sh-ws-group">
										<button
											type="button"
											className="sh-ws-group-head"
											onClick={() =>
												setCollapsedGroups(prev => {
													const next = new Set(prev);
													if (collapsed) next.delete(key);
													else next.add(key);
													return next;
												})
											}
											aria-expanded={!collapsed}
										>
											<ChevronRight size={11} className={`tr-chev${collapsed ? "" : " tr-chev--open"}`} />
											<span className="sh-ws-group-name" title={group.cwd ?? undefined}>
												{group.cwd ? projectName(group.cwd) : t("uncategorized")}
											</span>
											<span className="sh-ws-group-count">{group.rows.length}</span>
										</button>
										{!collapsed &&
											group.rows.map(session => (
												<WorkspaceSideItem key={session.id} session={session} onSelect={onSelect} />
											))}
									</section>
								);
							})}
							{sessions.length === 0 && <p className="sh-ws-sidebar-empty">{t("no sessions yet")}</p>}
						</div>
					</>
				)}
			</aside>
			<div className="sh-ws-main">
				<div className="sh-workspace-head">
					<h1 className="sh-workspace-title">{t("workspace")}</h1>
					<p className="sh-workspace-desc">{t("sessions on this machine — tap one to watch it live")}</p>
				</div>
				<div className="sh-workspace-grid">
					{sessions.map(session => (
						<WorkspaceCard key={session.id} session={session} onSelect={onSelect} />
					))}
				</div>
				{sessions.length === 0 && <p className="sh-workspace-empty">{t("no sessions yet")}</p>}
			</div>
		</div>
	);
}

/** Compact one-line row for the collapsible left rail (desktop-shell parity). */
function WorkspaceSideItem({
	session,
	onSelect,
}: {
	session: WorkspaceSessionInfo;
	onSelect(sessionId: string): void;
}): ReactNode {
	const title = session.title ?? t("untitled session");
	return (
		<button
			type="button"
			className={`sh-ws-side-item${session.working ? " sh-ws-side-item--working" : ""}`}
			onClick={() => onSelect(session.id)}
			title={t("open session")}
		>
			{session.working ? (
				<Loader2 size={10} className="sh-ws-spin" />
			) : (
				<span
					className={`sh-ws-side-dot${session.paused ? " sh-ws-side-dot--paused" : ""}`}
					aria-hidden
				/>
			)}
			<span className="sh-ws-side-title" title={title}>
				{title}
			</span>
			<span className="sh-ws-side-time">{formatWhen(session.updatedAt)}</span>
		</button>
	);
}

function WorkspaceCard({
	session,
	onSelect,
}: {
	session: WorkspaceSessionInfo;
	onSelect(sessionId: string): void;
}): ReactNode {
	const title = session.title ?? t("untitled session");
	const when = formatWhen(session.updatedAt);
	return (
		<button
			type="button"
			className={`sh-ws-card${session.working ? " sh-ws-card--working" : ""}`}
			onClick={() => onSelect(session.id)}
			title={t("open session")}
		>
			<div className="sh-ws-card-top">
				<span className="sh-ws-title" title={title}>
					{title}
				</span>
				{session.working ? (
					<span className="sh-ws-status sh-ws-status--working">
						<Loader2 size={11} className="sh-ws-spin" />
						{t("working")}
					</span>
				) : session.paused ? (
					<span className="sh-ws-status sh-ws-status--paused">{t("paused")}</span>
				) : (
					<span className="sh-ws-status">{t("idle")}</span>
				)}
			</div>
			<div className="sh-ws-card-meta">
				<span className="sh-ws-meta">{when}</span>
				<span className="sh-ws-meta">
					{t("{count} messages", { count: String(session.messageCount) })}
				</span>
				{session.cwd && (
					<span className="sh-ws-meta sh-ws-meta-cwd" title={session.cwd}>
						{shortenPath(session.cwd)}
					</span>
				)}
				{!session.live && <span className="sh-chip">{t("history")}</span>}
			</div>
		</button>
	);
}

/** Relative timestamp (locale-aware, no lib). */
function formatWhen(ts: number): string {
	const delta = Date.now() - ts;
	if (delta < 60_000) return t("just now");
	const minutes = Math.floor(delta / 60_000);
	if (minutes < 60) return t("{count} min ago", { count: String(minutes) });
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return t("{count} h ago", { count: String(hours) });
	return t("{count} d ago", { count: String(Math.floor(hours / 24)) });
}

/** Project-block grouping: sessions bucketed by working directory. */
function groupByProject(
	sessions: readonly WorkspaceSessionInfo[],
): { cwd: string | null; rows: WorkspaceSessionInfo[] }[] {
	const map = new Map<string, WorkspaceSessionInfo[]>();
	for (const s of sessions) {
		const key = s.cwd ?? "";
		let rows = map.get(key);
		if (!rows) {
			rows = [];
			map.set(key, rows);
		}
		rows.push(s);
	}
	return [...map.entries()]
		.map(([cwd, rows]) => ({
			cwd: cwd === "" ? null : cwd,
			rows: rows.sort((a, b) => b.updatedAt - a.updatedAt),
		}))
		.sort((a, b) => b.rows[0]!.updatedAt - a.rows[0]!.updatedAt);
}

/** Display name for a project block: last path segment (full path in title). */
function projectName(cwd: string): string {
	const trimmed = cwd.replace(/\/+$/, "");
	const base = trimmed.slice(trimmed.lastIndexOf("/") + 1);
	return base || cwd;
}
