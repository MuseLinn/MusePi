import { Archive, ChevronRight, Loader2, PanelLeft, PanelLeftClose, Pencil, Plus, Square, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { t } from "../../i18n/index.js";
import type { GuestClient } from "../../lib/client";
import { shortenPath, formatWhen } from "../../lib/format";
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
	onCreateSession,
	onDeleteSession,
	onRenameSession,
	onStopSession,
}: {
	client: GuestClient;
	sessions: readonly WorkspaceSessionInfo[];
	onSelect(sessionId: string): void;
	/** Create a fresh session (guest session.create RPC, write token gated). */
	onCreateSession?(): Promise<unknown>;
	/** Delete a session by id (guest session.delete RPC). */
	onDeleteSession?(sessionId: string): Promise<unknown>;
	/** Rename a session (guest session.rename RPC). */
	onRenameSession?(sessionId: string, title: string): Promise<unknown>;
	/** Stop a working session's running turn (guest session.abort RPC). */
	onStopSession?(sessionId: string): Promise<unknown>;
}): ReactNode {
	const [sidebarOpen, setSidebarOpen] = useState(true);
	// Collapsed project groups (keyed by cwd; "" = no folder).
	const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
	// Archive (localStorage, same concept as the desktop GUI SessionSidebar).
	const ARCHIVE_KEY = "musepi-collab-archived";
	const [archived, setArchived] = useState<Set<string>>(() => {
		try { return new Set(JSON.parse(localStorage.getItem(ARCHIVE_KEY) ?? "[]")); } catch { return new Set(); }
	});
	const [archivedView, setArchivedView] = useState(false);
	const toggleArchive = (id: string): void => {
		const next = new Set(archived);
		if (next.has(id)) next.delete(id); else next.add(id);
		setArchived(next);
		localStorage.setItem(ARCHIVE_KEY, JSON.stringify([...next]));
	};
	const visibleSessions = useMemo(
		() => (archivedView ? sessions : sessions.filter(s => !archived.has(s.id))),
		[sessions, archived, archivedView],
	);
	const groups = useMemo(() => groupByProject(visibleSessions), [visibleSessions]);
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
					<div className="sh-workspace-actions">
					{archived.size > 0 && (
						<button
							type="button"
							className="sh-ws-create"
							onClick={() => setArchivedView(v => !v)}
							title={archivedView ? t("show active sessions") : t("show archived")}
						>
							<Archive size={14} />
							<span>{archivedView ? t("active") : t("archived")} ({archived.size})</span>
						</button>
					)}
					{onCreateSession && (
						<button
							type="button"
							className="sh-ws-create"
							onClick={() => void onCreateSession()}
							title={t("new session")}
						>
							<Plus size={14} />
							<span>{t("new session")}</span>
						</button>
					)}
				</div>
				</div>
				<div className="sh-workspace-grid">
					{visibleSessions.map(session => (
						<WorkspaceCard key={session.id} session={session} onSelect={onSelect} onDeleteSession={onDeleteSession} onRenameSession={onRenameSession} onArchive={toggleArchive} onStopSession={onStopSession} />
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
	onDeleteSession,
	onRenameSession,
	onArchive,
	onStopSession,
}: {
	session: WorkspaceSessionInfo;
	onSelect(sessionId: string): void;
	onDeleteSession?(sessionId: string): Promise<unknown>;
	onRenameSession?(sessionId: string, title: string): Promise<unknown>;
	/** Toggle archived (localStorage, desktop-GUI parity). */
	onArchive?(sessionId: string): void;
	onStopSession?(sessionId: string): Promise<unknown>;
}): ReactNode {
	const [renaming, setRenaming] = useState(false);
	const [draft, setDraft] = useState(session.title ?? "");
	const title = session.title ?? t("untitled session");
	const when = formatWhen(session.updatedAt);
	const commitRename = (): void => {
		if (!renaming) return;
		setRenaming(false);
		const next = draft.trim();
		if (next && next !== title && onRenameSession) void onRenameSession(session.id, next);
	};
	return (
		<div className={`sh-ws-card${session.working ? " sh-ws-card--working" : ""}`}>
			<button
				type="button"
				className="sh-ws-card-main"
				onClick={() => onSelect(session.id)}
				title={t("open session")}
			>
				<div className="sh-ws-card-top">
					{renaming ? (
						<input
							className="sh-ws-rename-input"
							value={draft}
							onChange={e => setDraft(e.target.value)}
							onBlur={commitRename}
							onKeyDown={e => {
								if (e.key === "Enter") commitRename();
								if (e.key === "Escape") setRenaming(false);
							}}
							autoFocus
						/>
					) : (
						<span className="sh-ws-title" title={title}>
							{title}
						</span>
					)}
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
			<div className="sh-ws-card-actions">
				{session.working && onStopSession && (
					<button
						type="button"
						className="sh-ws-action-btn"
						title={t("stop the current turn")}
						onClick={e => {
							e.stopPropagation();
							void onStopSession(session.id);
						}}
					>
						<Square size={12} />
					</button>
				)}
				<button
					type="button"
					className="sh-ws-action-btn"
					title={t("archive")}
					onClick={e => {
						e.stopPropagation();
						onArchive?.(session.id);
					}}
				>
					<Archive size={12} />
				</button>
				{onRenameSession && (
						<button
							type="button"
							className="sh-ws-action-btn"
							title={t("rename")}
							onClick={e => {
								e.stopPropagation();
								setDraft(title);
								setRenaming(v => !v);
							}}
						>
							<Pencil size={12} />
						</button>
					)}
					{onDeleteSession && (
						<button
							type="button"
							className="sh-ws-action-btn"
							title={t("delete")}
							onClick={e => {
								e.stopPropagation();
								if (window.confirm(t("confirm delete session"))) void onDeleteSession(session.id);
							}}
						>
							<Trash2 size={12} />
						</button>
					)}
				</div>
		</div>
	);
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
