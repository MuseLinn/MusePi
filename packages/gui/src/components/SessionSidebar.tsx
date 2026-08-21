import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfirm, usePrompt } from "../lib/prompt-dialog";
import { shortcutLabel } from "../lib/shortcuts";
import { useScrollShadow } from "../lib/use-scroll-shadow";
import { Icon } from "../vendor/oc-icons";
import { ContextMenu } from "./ContextMenu";
import { CustomGroups } from "./CustomGroups";
import { GroupedSessionList } from "./GroupedSessionList";
import { Pop } from "./Pop";
import { Reveal } from "./Reveal";
import { SessionList, type SessionListNode, type SessionStatus } from "./SessionList";

/**
 * Left pane — ZCode-style: menu (new/search/scheduled/skills), a group/
 * project tab row, then the session list, and a user footer with daemon
 * status + theme toggles. Rounded containers, background-delta hierarchy,
 * no hairline borders.
 */
/** Accent colors for custom groups (right-click → 更改颜色). */
const GROUP_COLORS = ["accent", "green", "orange", "blue", "purple", "pink"];

/** Folder basename for project blocks (sessions carry full cwd paths). */
function baseName(p: string): string {
	const parts = p.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] || p;
}

/**
 * Collapsible body of a project block (shared Reveal standard — height via
 * useCollapse px, see components/Reveal.tsx).
 */
function ProjectCollapse({ collapsed, children }: { collapsed: boolean; children: ReactNode }): ReactNode {
	return <Reveal open={!collapsed}>{children}</Reveal>;
}

export function SessionSidebar({
	nodes,
	sessionMeta,
	selectedId,
	onSelect,
	onNewSession,
	status,
	onDisconnect,
	onOpenConnect,
	onOpenBoard,
	boardActive,
	onOpenScheduled,
	scheduledActive,
	cronGlow,
	onOpenAgents,
	agentsActive,
	onOpenSettings,
	onPickFolder,
	onCreateProject,
	onOpenCollab,
	onRenameSession,
	onOpenSearch,
	onOpenSkills,
	collapsed,
	width,
	onDeleteArchived,
	unread,
	onToggleUnread,
	onImportSessions,
}: {
	nodes: SessionListNode[];
	/** session.list metadata (cwd/model/status) keyed by id — archive folder
	 *  column + sidebar pause chip + working/unread derivation + status color. */
	sessionMeta: Map<
		string,
		{
			cwd?: string;
			model?: string;
			paused?: boolean;
			working?: boolean;
			status?: "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";
		}
	>;
	selectedId: string | null;
	onSelect(id: string): void;
	onNewSession(): void;
	status: "open" | "closed";
	onDisconnect(): void;
	onOpenConnect(): void;
	onOpenBoard?(): void;
	onOpenScheduled?(): void;
	scheduledActive?: boolean;
	/** A scheduled task finished recently — the 定时任务 button glows. */
	cronGlow?: boolean;
	/** Board view is the active scene — its nav item renders selected. */
	boardActive?: boolean;
	/** Agents center view is the active scene — its nav item renders selected. */
	onOpenAgents?(): void;
	agentsActive?: boolean;
	onOpenSettings(): void;
	/** ZCode 打开文件夹 — native directory picker (Electron dialog). */
	onPickFolder?(): void;
	/** kimiwork parity: create a blank project — a dialog asks for a name
	 *  + parent path and the app mkdirs + opens it (daemon fs.mkdir). */
	onCreateProject?(): void;
	/** Open the ZCode-style collab remote-control dialog. */
	onOpenCollab?(): void;
	/** Persist a user-set session title (daemon session.rename). */
	onRenameSession?(sessionId: string, title: string): void;
	/** Open the app-level command palette (⌘K / sidebar 搜索). */
	onOpenSearch(): void;
	/** Open the skill manager (sidebar 技能 entry → settings skills tab). */
	onOpenSkills(): void;
	collapsed: boolean;
	/** Permanently delete a session's local data (journal + index) via the
	 *  daemon; returns success so the UI only drops the archive row on a real
	 *  deletion (ZCode confirm dialog wording promises data cleanup). */
	onDeleteArchived(sessionId: string): Promise<boolean>;
	/** Pane width in px (draggable resize). */
	width?: number;
	/** Unread session ids (single source: app-level unread set — pet
	 *  bubbles, cursor-based derivation, and manual context-menu toggles). */
	unread?: ReadonlySet<string>;
	/** Context-menu 标记为已读/未读 toggle. */
	onToggleUnread?(sessionId: string): void;
	/** Open the session-import dialog (projects tab entry). */
	onImportSessions?(): void;
}): ReactNode {
	const [tab, setTab] = useState<"groups" | "projects">("groups");
	const [projMenu, setProjMenu] = useState(false);
	// Tab-row quick toggle: null = per-group state, true = all open, false = all closed.
	const [groupsAll, setGroupsAll] = useState<boolean | null>(null);
	const [pinned, setPinned] = useState<string[]>(() => {
		try {
			return JSON.parse(localStorage.getItem("musepi-gui-pinned") ?? "[]") as string[];
		} catch {
			return [];
		}
	});
	const persistPinned = (next: string[]): void => {
		setPinned(next);
		try {
			localStorage.setItem("musepi-gui-pinned", JSON.stringify(next));
		} catch {
			// storage unavailable
		}
	};
	// Manual per-session status tags (ContextMenu #完成/#中断/#错误…) —
	// persisted locally like pinned/groups; overrides the derived lifecycle
	// status for the row's left square.
	const [manualTags, setManualTags] = useState<ReadonlyMap<string, SessionStatus>>(() => {
		try {
			const raw = localStorage.getItem("musepi-gui-session-tags");
			return raw ? new Map(Object.entries(JSON.parse(raw) as Record<string, SessionStatus>)) : new Map();
		} catch {
			return new Map();
		}
	});
	const persistManualTags = (next: ReadonlyMap<string, SessionStatus>): void => {
		setManualTags(next);
		try {
			localStorage.setItem("musepi-gui-session-tags", JSON.stringify(Object.fromEntries(next)));
		} catch {
			// storage unavailable
		}
	};
	const setSessionTag = (id: string, tag: SessionStatus | null): void => {
		const next = new Map(manualTags);
		if (tag === null) next.delete(id);
		else next.set(id, tag);
		persistManualTags(next);
	};
	// Derived lifecycle status per session (complete/interrupted/aborted/
	// error/pending) — TUI session-list parity, from session.list.
	const statuses = useMemo(
		() =>
			new Map<string, SessionStatus>(
				[...sessionMeta.entries()]
					.filter(([, m]) => m.status !== undefined)
					.map(([id, m]) => [id, m.status as SessionStatus]),
			),
		[sessionMeta],
	);
	const { prompt } = usePrompt();
	const { confirm } = useConfirm();
	const renameSession = (id: string): void => {
		const current = nodes.find(n => n.entry.id === id)?.entry.label ?? "";
		void prompt({ title: t("rename session"), defaultValue: current }).then(next => {
			if (!next || next === current) return;
			onRenameSession?.(id, next);
		});
	};
	const openInFinder = (id: string): void => {
		const cwd = sessionMeta.get(id)?.cwd;
		if (!cwd) return;
		const api = (window as unknown as { electronAPI?: { revealPath?(p: string): Promise<void> } }).electronAPI;
		if (api?.revealPath) void api.revealPath(cwd);
	};
	const [viewMenu, setViewMenu] = useState(false);
	const viewMenuAnchorRef = useRef<HTMLButtonElement | null>(null);
	const projMenuAnchorRef = useRef<HTMLButtonElement | null>(null);
	const [projView, setProjView] = useState<"project" | "timeline">("project");
	const [projSort, setProjSort] = useState<"updated" | "created">("updated");
	const [groups, setGroups] = useState<{ name: string; sessions: string[]; color?: string }[]>(() => {
		try {
			const raw = localStorage.getItem("musepi-gui-groups");
			return raw ? (JSON.parse(raw) as { name: string; sessions: string[]; color?: string }[]) : [];
		} catch {
			return [];
		}
	});
	// Inline group-name editing (double-click the block / context menu).
	const [groupEditIdx, setGroupEditIdx] = useState<number | null>(null);
	// Archived sessions (ZCode archive view): archivedAt is display time;
	// cwd is captured at archive time from session.list so the archive row
	// can show the folder (tree nodes carry no cwd).
	const [archived, setArchived] = useState<{ sessionId: string; archivedAt: number; cwd?: string }[]>(() => {
		try {
			const raw = localStorage.getItem("musepi-gui-archived");
			return raw ? (JSON.parse(raw) as { sessionId: string; archivedAt: number }[]) : [];
		} catch {
			return [];
		}
	});
	const [archivedView, setArchivedView] = useState(false);
	// Content-boundary feather (transcript parity): the session list scrolls
	// inside the sidebar — data-top-scroll / data-bottom-scroll flip the
	// mask-image fade on and off as the list overflows (useScrollShadow).
	const sessionListRef = useRef<HTMLDivElement | null>(null);
	useScrollShadow(sessionListRef);
	// Persisted project list (projects tab): every folder the app knows —
	// seeded from session cwds on first load and grown by folder picks
	// (musepi-gui-project-added, dispatched by app.tsx after pickDirectory) so
	// empty folders show up even before any session exists. Full paths.
	const [projects, setProjects] = useState<string[]>(() => {
		try {
			const raw = localStorage.getItem("musepi-gui-projects");
			const parsed: unknown = raw ? JSON.parse(raw) : [];
			return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
		} catch {
			return [];
		}
	});
	// Per-project collapse state, keyed by path (expanded by default).
	const [collapsedProjects, setCollapsedProjects] = useState<string[]>(() => {
		try {
			const raw = localStorage.getItem("musepi-gui-projects-collapsed");
			const parsed: unknown = raw ? JSON.parse(raw) : [];
			return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
		} catch {
			return [];
		}
	});
	const [sessionCtx, setSessionCtx] = useState<{ id: string; x: number; y: number } | null>(null);
	const [groupCtx, setGroupCtx] = useState<{ index: number; x: number; y: number } | null>(null);
	const [projectCtx, setProjectCtx] = useState<{ path: string; x: number; y: number } | null>(null);
	// Paused sessions (per-session freeze) — rendered as a pause chip on rows.
	const pausedIds = useMemo(
		() => new Set([...sessionMeta.entries()].filter(([, meta]) => meta.paused === true).map(([id]) => id)),
		[sessionMeta],
	);
	// Live sessions with a running agent turn (kimi 进行中 parity) — a
	// pulsing accent dot on the row, fed by the app's session.list poll.
	const workingIds = useMemo(
		() =>
			new Set(
				[...sessionMeta.entries()]
					.filter(([, meta]) => meta.working === true && meta.paused !== true)
					.map(([id]) => id),
			),
		[sessionMeta],
	);

	const deleteArchived = useCallback(
		async (id: string): Promise<void> => {
			// Confirm lives in deleteSession (settings toggle); real cleanup
			// (journal + index) happens daemon-side — only drop the archive
			// row when the RPC confirmed the data is gone.
			const ok = await onDeleteArchived(id);
			if (ok) {
				setArchived(prev => prev.filter(a => a.sessionId !== id));
			}
		},
		[onDeleteArchived],
	);
	useEffect(() => {
		localStorage.setItem("musepi-gui-groups", JSON.stringify(groups));
	}, [groups]);
	useEffect(() => {
		localStorage.setItem("musepi-gui-archived", JSON.stringify(archived));
	}, [archived]);
	useEffect(() => {
		try {
			localStorage.setItem("musepi-gui-projects", JSON.stringify(projects));
		} catch {
			// storage unavailable
		}
	}, [projects]);
	useEffect(() => {
		try {
			localStorage.setItem("musepi-gui-projects-collapsed", JSON.stringify(collapsedProjects));
		} catch {
			// storage unavailable
		}
	}, [collapsedProjects]);
	// Folders the app picks (打开文件夹 menu, ⌘O, welcome composer) announce
	// themselves here — add them so empty projects appear immediately.
	useEffect(() => {
		const onProjectAdded = (e: Event): void => {
			const path = (e as CustomEvent<string>).detail;
			if (typeof path !== "string" || !path) return;
			setProjects(prev => (prev.includes(path) ? prev : [...prev, path]));
		};
		window.addEventListener("musepi-gui-project-added", onProjectAdded);
		return () => window.removeEventListener("musepi-gui-project-added", onProjectAdded);
	}, []);
	// The header's session ⋯ menu can archive the active session — re-read
	// the shared archive list so this component's in-memory copy follows.
	useEffect(() => {
		const onArchived = (): void => {
			try {
				setArchived(JSON.parse(localStorage.getItem("musepi-gui-archived") ?? "[]") as typeof archived);
			} catch {
				// storage unavailable
			}
		};
		window.addEventListener("musepi-gui-sessions-archived", onArchived);
		return () => window.removeEventListener("musepi-gui-sessions-archived", onArchived);
	}, []);
	const archivedIds = new Set(archived.map(a => a.sessionId));
	const visibleNodes = nodes.filter(n => !archivedIds.has(n.entry.id));
	const pinnedNodes = nodes.filter(n => pinned.includes(n.entry.id));
	// Fixed session search: filter the tree by label (recursively — a node
	// stays when it matches or any descendant matches). Empty → everything.
	const [sessionQuery, setSessionQuery] = useState("");
	const matchTree = useCallback((list: SessionListNode[], q: string): SessionListNode[] => {
		if (!q) return list;
		const needle = q.toLowerCase();
		const walk = (n: SessionListNode): SessionListNode | null => {
			const kids = n.children.map(walk).filter((x): x is SessionListNode => x !== null);
			const self = (n.label ?? n.entry.label ?? "").toLowerCase().includes(needle);
			if (self || kids.length > 0) return { ...n, children: kids };
			return null;
		};
		return list.map(walk).filter((x): x is SessionListNode => x !== null);
	}, []);
	const searchedNodes = useMemo(
		() => matchTree(visibleNodes, sessionQuery.trim()),
		[matchTree, visibleNodes, sessionQuery],
	);
	// Scheduled-task sessions get their own section (定时任务) instead of
	// cluttering the regular session flow. Pinned wins (pinned section
	// owns them while pinned).
	const cronNodes = searchedNodes.filter(n => n.entry.source === "cron" && !pinned.includes(n.entry.id));
	const regularNodes = searchedNodes.filter(n => n.entry.source !== "cron" && !pinned.includes(n.entry.id));
	/** Shared 定时任务 section block (used by groups + projects tabs). */
	const cronSection = (
		<div className="mb-1.5">
			<div className="gui-group-label flex items-center gap-1 px-2 pb-1 pt-2.5">
				<Icon name="calendar-schedule" className="h-3.5 w-3.5" />
				{t("scheduled tasks")}
			</div>
			<SessionList
				nodes={cronNodes}
				selectedId={selectedId}
				onSelect={onSelect}
				onContextMenu={(id, x, y) => setSessionCtx({ id, x, y })}
				pausedIds={pausedIds}
				workingIds={workingIds}
				statuses={statuses}
				manualTags={manualTags}
			/>
		</div>
	);
	const archiveSession = (id: string): void => {
		setArchived(prev => [
			...prev.filter(a => a.sessionId !== id),
			{ sessionId: id, archivedAt: Date.now(), cwd: sessionMeta.get(id)?.cwd },
		]);
	};
	// Scheduled-task deletes can archive their sessions (ScheduledTasksPage
	// writes localStorage + dispatches this event) — re-read so the archive
	// view reflects the change without a full reload.
	useEffect(() => {
		const onArchivedChanged = (): void => {
			try {
				setArchived(
					JSON.parse(localStorage.getItem("musepi-gui-archived") ?? "[]") as {
						sessionId: string;
						archivedAt: number;
					}[],
				);
			} catch {
				// ignore malformed storage
			}
		};
		window.addEventListener("musepi-gui-archived-changed", onArchivedChanged);
		return () => window.removeEventListener("musepi-gui-archived-changed", onArchivedChanged);
	}, []);

	const unarchiveSession = (id: string): void => {
		setArchived(prev => prev.filter(a => a.sessionId !== id));
	};
	const toggleProject = (path: string): void => {
		setCollapsedProjects(prev => (prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path]));
	};
	const removeProject = (path: string): void => {
		void confirm(`${t("remove project")} ${baseName(path)}?`, t("remove")).then(ok => {
			if (!ok) return;
			setProjects(prev => prev.filter(p => p !== path));
			setCollapsedProjects(prev => prev.filter(p => p !== path));
		});
	};
	// Collapse/expand every project at once (tab-row quick toggle).
	const collapseAllProjects = (collapse: boolean): void => {
		setCollapsedProjects(collapse ? [...projects] : []);
	};
	const renameGroup = (index: number): void => {
		// Inline edit inside the group block (no prompt dialog).
		setGroupCtx(null);
		setGroupEditIdx(index);
	};
	return (
		<aside
			className={`gui-pane-side gui-pane-side--immersive flex h-full flex-shrink-0 flex-col overflow-hidden${collapsed ? " gui-pane-side--collapsed" : ""}`}
			style={{ width: collapsed ? 0 : (width ?? 256) }}
		>
			<div className="flex h-full min-h-0 w-full flex-col">
				{/* Traffic-light clearance (macOS overlay title bar, y=14). */}
				<div className="gui-pane-drag flex h-9 flex-shrink-0 items-center justify-end pr-2" />
				{/* Menu: new session is the primary action; others are placeholders. */}
				<div className="gui-side-menu flex flex-col gap-0.5 px-2.5">
					<button type="button" className="gui-menu-item" onClick={onNewSession}>
						<Icon name="add-circle" className="h-4 w-4" />
						<span>{t("new task")}</span>
						<span className="gui-menu-kbd">{shortcutLabel("⌘N")}</span>
					</button>
					<button type="button" className="gui-menu-item" onClick={onOpenSearch} title={t("search")}>
						<Icon name="search" className="h-4 w-4" />
						<span>{t("search")}</span>
						<span className="gui-menu-kbd">{shortcutLabel("⌘K")}</span>
					</button>
					{onOpenScheduled && (
						<button
							type="button"
							className={`gui-menu-item${scheduledActive ? " gui-menu-item--active" : ""}${cronGlow ? " gui-menu-item--glow" : ""}`}
							onClick={onOpenScheduled}
							title={t("scheduled tasks")}
						>
							<Icon name="calendar-schedule" className="h-4 w-4" />
							<span>{t("scheduled tasks")}</span>
						</button>
					)}
					{onOpenBoard && (
						<button
							type="button"
							className={`gui-menu-item${boardActive ? " gui-menu-item--active" : ""}`}
							onClick={onOpenBoard}
							title={t("board")}
						>
							<Icon name="layout-column" className="h-4 w-4" />
							<span>{t("board")}</span>
						</button>
					)}
					{onOpenAgents && (
						<button
							type="button"
							className={`gui-menu-item${agentsActive ? " gui-menu-item--active" : ""}`}
							onClick={onOpenAgents}
							title={t("agents center")}
						>
							<Icon name="ai-agent-fill" className="h-4 w-4" />
							<span>{t("agents center")}</span>
						</button>
					)}
					<button type="button" className="gui-menu-item" onClick={onOpenSkills} title={t("extensions")}>
						<Icon name="sparkling" className="h-4 w-4" />
						<span>{t("extensions")}</span>
					</button>
				</div>
				{/* Group / project tabs: the capsule wraps ONLY the two fixed-width
				 * pills; the right cluster carries a collapse/expand-all quick toggle
				 * plus the contextual and archive actions. mx-5 keeps the capsule
				 * flush with the menu row's content above (px-2.5 container + 10px
				 * item padding), and ml-auto on the cluster mirrors the shortcut
				 * symbols' right edge — both scale with pane width. */}
				<div className="gui-tabstrip mx-5 mt-3 flex items-center">
					<div className="gui-tabstrip-capsule">
						<button
							type="button"
							className={`gui-tab-pill gui-tab-pill--fixed${tab === "groups" ? " gui-tab-pill--active" : ""}`}
							onClick={() => setTab("groups")}
						>
							<Icon name="folder-3" className="h-3.5 w-3.5" />
							<span>{t("groups")}</span>
						</button>
						<button
							type="button"
							className={`gui-tab-pill gui-tab-pill--fixed${tab === "projects" ? " gui-tab-pill--active" : ""}`}
							onClick={() => setTab("projects")}
						>
							<Icon name="folder" className="h-3.5 w-3.5" />
							<span>{t("projects")}</span>
						</button>
					</div>
					{/* Right cluster: never shrinks — the capsule flexes instead, so
					 * the toggle/add/archive buttons stay fully visible at any pane
					 * width and always sit flush to the strip's right edge. */}
					<div className="ml-auto flex flex-shrink-0 items-center gap-0.5">
						<button
							type="button"
							className="gui-tab-action"
							title={t("expand or collapse all")}
							aria-label={t("expand or collapse all")}
							onClick={() => {
								if (tab === "groups") {
									setGroupsAll(prev => prev === false);
								} else {
									// Toggle: any collapsed → expand all; all expanded → collapse all.
									// (Was `length > 0`, which re-collapsed instead of expanding.)
									collapseAllProjects(collapsedProjects.length === 0);
								}
							}}
						>
							<Icon name="expand-up-down" className="h-3.5 w-3.5" />
						</button>
						{tab === "groups" ? (
							<button
								type="button"
								className="gui-tab-action"
								title={t("new group")}
								aria-label={t("new group")}
								onClick={() =>
									setGroups(g => [
										...g,
										{
											name: t("new group"),
											sessions: [],
											color: GROUP_COLORS[Math.floor(Math.random() * GROUP_COLORS.length)],
										},
									])
								}
							>
								<Icon name="add-circle" className="h-3.5 w-3.5" />
							</button>
						) : (
							<button
								ref={viewMenuAnchorRef}
								type="button"
								className="gui-tab-action"
								title={t("view and sort")}
								aria-label={t("view and sort")}
								aria-expanded={viewMenu}
								onClick={() => setViewMenu(v => !v)}
							>
								<Icon name="equalizer-2" className="h-3.5 w-3.5" />
							</button>
						)}
						<button
							type="button"
							className="gui-tab-action"
							title={t("archive")}
							aria-label={t("archive")}
							onClick={() => {
								setArchivedView(v => !v);
								setViewMenu(false);
							}}
						>
							<Icon name="archive" className="h-3.5 w-3.5" />
						</button>
					</div>
				</div>
				{/* View/sort menu (projects tab) — ZCode parity. Floating portal
				 * (not an inline block) so it overlays the tree like the other
				 * menus. */}
				{tab === "projects" && (
					<Pop
						open={viewMenu}
						className="gui-view-menu"
						portal
						anchor={viewMenuAnchorRef.current}
						align="right"
						onOpenChange={setViewMenu}
					>
						<div className="px-2 py-1 text-[13px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
							{t("view")}
						</div>
						<button
							type="button"
							className={`gui-view-opt${projView === "project" ? " gui-view-opt--active" : ""}`}
							onClick={() => {
								setProjView("project");
								setViewMenu(false);
							}}
						>
							<Icon name="folder" className="h-3.5 w-3.5" />
							<span>{t("by project")}</span>
							{projView === "project" && <Icon name="check" className="h-3 w-3 ml-auto" />}
						</button>
						<button
							type="button"
							className={`gui-view-opt${projView === "timeline" ? " gui-view-opt--active" : ""}`}
							onClick={() => {
								setProjView("timeline");
								setViewMenu(false);
							}}
						>
							<Icon name="history" className="h-3.5 w-3.5" />
							<span>{t("timeline")}</span>
							{projView === "timeline" && <Icon name="check" className="h-3 w-3 ml-auto" />}
						</button>
						<div className="mt-1 px-2 py-1 text-[13px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
							{t("sort by")}
						</div>
						<button
							type="button"
							className={`gui-view-opt${projSort === "updated" ? " gui-view-opt--active" : ""}`}
							onClick={() => {
								setProjSort("updated");
								setViewMenu(false);
							}}
						>
							<Icon name="chat-1" className="h-3.5 w-3.5" />
							<span>{t("updated time")}</span>
							{projSort === "updated" && <Icon name="check" className="h-3 w-3 ml-auto" />}
						</button>
						<button
							type="button"
							className={`gui-view-opt${projSort === "created" ? " gui-view-opt--active" : ""}`}
							onClick={() => {
								setProjSort("created");
								setViewMenu(false);
							}}
						>
							<Icon name="history" className="h-3.5 w-3.5" />
							<span>{t("created time")}</span>
							{projSort === "created" && <Icon name="check" className="h-3 w-3 ml-auto" />}
						</button>
					</Pop>
				)}
				{/* Sessions list — custom groups in groups tab; project/timeline in
				 * projects; archived sessions in the archive view (ZCode). */}
				<div className="gui-sessions-tab mt-2 flex min-h-0 flex-1 flex-col overflow-hidden">
					<div className="gui-session-search">
						<Icon name="search" className="h-3.5 w-3.5 flex-none" />
						<input
							className="gui-input min-w-0 flex-1"
							value={sessionQuery}
							onChange={e => setSessionQuery(e.target.value)}
							placeholder={t("search sessions…")}
							aria-label={t("search sessions…")}
						/>
						{sessionQuery && (
							<button
								type="button"
								className="rounded-md p-0.5 text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
								onClick={() => setSessionQuery("")}
								title={t("clear")}
								aria-label={t("clear")}
							>
								<Icon name="close" className="h-3 w-3" />
							</button>
						)}
					</div>
					<div className="flex items-center justify-end px-4 py-1.5">
						{archivedView && (
							<button
								type="button"
								className="rounded-md p-1 text-[var(--color-text-faint)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
								onClick={() => setArchivedView(false)}
								title={t("back")}
								aria-label={t("back")}
							>
								<Icon name="arrow-left-s" className="h-3.5 w-3.5" />
							</button>
						)}
					</div>
					<div
						ref={sessionListRef}
						className="gui-sessions-list min-h-0 flex-1 overflow-y-auto px-1.5 pb-2"
						data-top-scroll="false"
						data-bottom-scroll="false"
					>
						{archivedView ? (
							archived.length === 0 ? (
								<p className="px-2 py-4 text-[13px] text-[var(--color-text-faint)]">
									{t("no archived sessions")}
								</p>
							) : (
								archived.map(a => {
									const node = nodes.find(n => n.entry.id === a.sessionId);
									return (
										<div key={a.sessionId} className="gui-archive-row">
											<div className="min-w-0 flex-1">
												<div className="truncate text-[13px]">
													{node?.entry.label ?? t("untitled session")}
												</div>
												<div className="flex items-center gap-1 text-[13px] text-[var(--color-text-faint)]">
													<Icon name="folder-3" className="h-3 w-3 flex-shrink-0" />
													<span className="min-w-0 flex-1 truncate">
														{a.cwd ? (a.cwd.split("/").filter(Boolean).at(-1) ?? a.cwd) : t("no folder")}
													</span>
													<span className="flex-shrink-0">{new Date(a.archivedAt).toLocaleString()}</span>
												</div>
											</div>
											<button
												type="button"
												className="gui-archive-act"
												title={t("unarchive")}
												aria-label={t("unarchive")}
												onClick={() => unarchiveSession(a.sessionId)}
											>
												<Icon name="restart" className="h-3.5 w-3.5" />
											</button>
											<button
												type="button"
												className="gui-archive-act gui-archive-act--danger"
												title={t("delete")}
												aria-label={t("delete")}
												onClick={() => void deleteArchived(a.sessionId)}
											>
												<Icon name="delete-bin" className="h-3.5 w-3.5" />
											</button>
										</div>
									);
								})
							)
						) : tab === "projects" ? (
							<>
								{/* Add-project button lives above BOTH view modes (the
								 * timeline default hid it before — ZCode parity: 项目 tab
								 * always offers 打开文件夹 / 远程连接). */}
								<div className="relative">
									<button
										type="button"
										className="gui-connect-add"
										ref={projMenuAnchorRef}
										onClick={() => setProjMenu(v => !v)}
									>
										<Icon name="add-circle" className="h-4 w-4" />
										<span>{t("add project or remote")}</span>
									</button>
									<Pop
										open={projMenu}
										className="gui-add-project-menu"
										anchor={projMenuAnchorRef.current}
										onOpenChange={setProjMenu}
									>
										<button
											type="button"
											className="gui-view-opt"
											onClick={() => {
												setProjMenu(false);
												onPickFolder?.();
											}}
										>
											<Icon name="folder-open" className="h-3.5 w-3.5" />
											<span>{t("open folder")}</span>
										</button>
										<button
											type="button"
											className="gui-view-opt"
											onClick={() => {
												setProjMenu(false);
												onCreateProject?.();
											}}
										>
											<Icon name="folder-add" className="h-3.5 w-3.5" />
											<span>{t("new blank project")}</span>
										</button>
										<button
											type="button"
											className="gui-view-opt"
											onClick={() => {
												setProjMenu(false);
												onOpenConnect();
											}}
										>
											<Icon name="server" className="h-3.5 w-3.5" />
											<span>{t("remote connection")}</span>
										</button>
										<button
											type="button"
											className="gui-view-opt"
											onClick={() => {
												setProjMenu(false);
												onImportSessions?.();
											}}
										>
											<Icon name="download" className="h-3.5 w-3.5" />
											<span>{t("import sessions")}</span>
										</button>
									</Pop>
								</div>
								{projView === "timeline" ? (
									<>
										{pinnedNodes.length > 0 && (
											<div className="mb-1.5">
												<div className="gui-group-label px-2 pb-1 pt-2.5">{t("pinned")}</div>
												<SessionList
													nodes={pinnedNodes}
													selectedId={selectedId}
													onSelect={onSelect}
													onContextMenu={(id, x, y) => setSessionCtx({ id, x, y })}
													pausedIds={pausedIds}
													workingIds={workingIds}
													statuses={statuses}
													manualTags={manualTags}
												/>
											</div>
										)}
										{cronNodes.length > 0 && cronSection}
										<GroupedSessionList
											nodes={regularNodes}
											selectedId={selectedId}
											onSelect={onSelect}
											onContextMenu={(id, x, y) => setSessionCtx({ id, x, y })}
											unread={unread}
											pausedIds={pausedIds}
											workingIds={workingIds}
											statuses={statuses}
											manualTags={manualTags}
										/>
									</>
								) : (
									(() => {
										// ZCode project blocks: persisted folder list, each a
										// collapsible block. Sessions group by exact cwd; folders
										// without sessions still show (empty state) so a freshly
										// picked 打开文件夹 appears immediately.
										const byCwd = new Map<string, SessionListNode[]>();
										const noFolder: SessionListNode[] = [];
										for (const n of regularNodes) {
											const cwd = sessionMeta.get(n.entry.id)?.cwd;
											if (cwd) {
												const list = byCwd.get(cwd) ?? [];
												list.push(n);
												byCwd.set(cwd, list);
											} else {
												noFolder.push(n);
											}
										}
										// Only user-added workspaces show; their sessions appear below.
										const known = [...projects];
										// Most recently touched projects first; empty ones keep
										// list order at the bottom.
										const order = known.sort((a, b) => {
											const la = byCwd.get(a);
											const lb = byCwd.get(b);
											if (!la && !lb) return 0;
											if (!la) return 1;
											if (!lb) return -1;
											return (
												new Date(lb[0]!.entry.timestamp).getTime() -
												new Date(la[0]!.entry.timestamp).getTime()
											);
										});
										return (
											<>
												{pinnedNodes.length > 0 && (
													<div className="mb-1.5">
														<div className="gui-group-label px-2 pb-1 pt-2.5">{t("pinned")}</div>
														<SessionList
															nodes={pinnedNodes}
															selectedId={selectedId}
															onSelect={onSelect}
															onContextMenu={(id, x, y) => setSessionCtx({ id, x, y })}
															pausedIds={pausedIds}
															workingIds={workingIds}
															statuses={statuses}
															manualTags={manualTags}
														/>
													</div>
												)}
												{cronNodes.length > 0 && cronSection}
												{order.map(path => {
													const list = byCwd.get(path) ?? [];
													const isCollapsed = collapsedProjects.includes(path);
													return (
														<div
															key={path}
															className="mb-1.5"
															onDragOver={e => {
																e.preventDefault();
																e.dataTransfer.dropEffect = "move";
															}}
															onDrop={e => {
																e.preventDefault();
																const data = e.dataTransfer.getData("text/plain");
																if (!data.startsWith("project:")) return;
																const from = data.slice(8);
																if (from === path) return;
																setProjects(prev => {
																	const fi = prev.indexOf(from);
																	const ti = prev.indexOf(path);
																	if (fi < 0 || ti < 0) return prev;
																	const next = [...prev];
																	const [moved] = next.splice(fi, 1);
																	next.splice(ti, 0, moved);
																	return next;
																});
															}}
														>
															<div className="gui-project-block">
																<button
																	type="button"
																	className="gui-project-head"
																	title={path}
																	aria-expanded={!isCollapsed}
																	draggable
																	onDragStart={e => {
																		e.dataTransfer.setData("text/plain", `project:${path}`);
																		e.dataTransfer.effectAllowed = "move";
																	}}
																	onClick={() => toggleProject(path)}
																	onContextMenu={e => {
																		// ZCode parity: project blocks carry the same right-click
																		// menu as group blocks (remove project lives here, not as
																		// a lone side button).
																		e.preventDefault();
																		setProjectCtx({ path, x: e.clientX, y: e.clientY });
																	}}
																>
																	<Icon name="folder" className="h-3 w-3" />
																	<span className="min-w-0 flex-1 truncate">{baseName(path)}</span>
																	<span className="gui-project-count">{list.length}</span>
																	<Icon
																		name="arrow-down-s"
																		className={`gui-project-chevron${isCollapsed ? " gui-project-chevron--closed" : ""}`}
																	/>
																</button>
															</div>
															<ProjectCollapse collapsed={isCollapsed}>
																{list.length === 0 ? (
																	<p className="gui-project-empty">{t("no sessions")}</p>
																) : (
																	<SessionList
																		nodes={list}
																		selectedId={selectedId}
																		onSelect={onSelect}
																		onContextMenu={(id, x, y) => setSessionCtx({ id, x, y })}
																		unread={unread}
																		pausedIds={pausedIds}
																		workingIds={workingIds}
																		statuses={statuses}
																		manualTags={manualTags}
																	/>
																)}
															</ProjectCollapse>
														</div>
													);
												})}
												{noFolder.length > 0 && (
													<div className="mb-1.5">
														<div className="gui-group-label flex items-center gap-1 px-2 pb-1 pt-2.5">
															<Icon name="folder" className="h-3 w-3" />
															<span className="min-w-0 flex-1 truncate">{t("no folder")}</span>
															<span className="text-[12px] text-[var(--color-text-faint)]">
																{noFolder.length}
															</span>
														</div>
														<SessionList
															nodes={noFolder}
															selectedId={selectedId}
															onSelect={onSelect}
															onContextMenu={(id, x, y) => setSessionCtx({ id, x, y })}
															unread={unread}
															pausedIds={pausedIds}
															workingIds={workingIds}
															statuses={statuses}
															manualTags={manualTags}
														/>
													</div>
												)}
											</>
										);
									})()
								)}
							</>
						) : (
							<>
								{/* Pinned sessions show in the groups tab too (ZCode
								 * 已置顶 parity), above custom groups. */}
								{pinnedNodes.length > 0 && (
									<div className="mb-1.5">
										<div className="gui-group-label px-2 pb-1 pt-2.5">{t("pinned")}</div>
										<SessionList
											nodes={pinnedNodes}
											selectedId={selectedId}
											onSelect={onSelect}
											onContextMenu={(id, x, y) => setSessionCtx({ id, x, y })}
											pausedIds={pausedIds}
											workingIds={workingIds}
											statuses={statuses}
											manualTags={manualTags}
										/>
									</div>
								)}
								{/* ZCode: the groups tab lists sessions too — custom
								 * groups on top, then the time-grouped session tree. */}
								<CustomGroups
									groups={groups}
									allOverride={groupsAll}
									onOverrideClear={() => setGroupsAll(null)}
									// Pinned sessions leave their groups (mutually exclusive): the
									// pinned section above owns them while pinned.
									nodes={visibleNodes.filter(n => !pinned.includes(n.entry.id))}
									selectedId={selectedId}
									onSelect={onSelect}
									onSessionContextMenu={(id, x, y) => setSessionCtx({ id, x, y })}
									onAddGroup={() =>
										setGroups(g => [
											...g,
											{
												name: t("new group"),
												sessions: [],
												color: GROUP_COLORS[Math.floor(Math.random() * GROUP_COLORS.length)],
											},
										])
									}
									onNewSession={onNewSession}
									onDropSession={(i, id) =>
										setGroups(gs =>
											gs.map((g, gi) =>
												gi !== i
													? g
													: { ...g, sessions: g.sessions.includes(id) ? g.sessions : [...g.sessions, id] },
											),
										)
									}
									onContextMenu={(i, x, y) => setGroupCtx({ index: i, x, y })}
									onReorder={(from, to) =>
										setGroups(gs => {
											const next = [...gs];
											const [moved] = next.splice(from, 1);
											next.splice(to, 0, moved);
											return next;
										})
									}
									editIndex={groupEditIdx}
									onEditStart={setGroupEditIdx}
									onRename={(i, name) => setGroups(gs => gs.map((g, gi) => (gi === i ? { ...g, name } : g)))}
									onReorderMember={(gi, sessionId, to) =>
										setGroups(gs =>
											gs.map((g, i) => {
												if (i !== gi) return g;
												const from = g.sessions.indexOf(sessionId);
												if (from < 0) return g;
												const next = [...g.sessions];
												next.splice(from, 1);
												next.splice(to, 0, sessionId);
												return { ...g, sessions: next };
											}),
										)
									}
									unread={unread}
									pausedIds={pausedIds}
									workingIds={workingIds}
									statuses={statuses}
									manualTags={manualTags}
								/>
								{cronNodes.length > 0 && cronSection}
								<GroupedSessionList
									nodes={regularNodes}
									selectedId={selectedId}
									onSelect={onSelect}
									onContextMenu={(id, x, y) => setSessionCtx({ id, x, y })}
									unread={unread}
									pausedIds={pausedIds}
									workingIds={workingIds}
									statuses={statuses}
									manualTags={manualTags}
								/>
							</>
						)}
					</div>
				</div>
				{/* User footer: daemon status + settings (theme/language moved into
				 * the settings dialog, ZCode-style). */}
				<div className="gui-sidebar-footer flex items-center gap-1.5 border-t border-[var(--border)] px-3 py-2">
					<div className="flex flex-1 items-center gap-1.5 text-[13px] text-[var(--color-text-muted)]">
						<span className={`gui-dot gui-dot-${status}`} />
						<span>{status === "open" ? t("local daemon") : t("disconnected")}</span>
					</div>
					<button
						type="button"
						className="rounded-md p-1 text-[var(--color-text-faint)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
						onClick={onOpenSettings}
						title={t("settings")}
						aria-label={t("settings")}
					>
						<Icon name="settings-3" className="h-4 w-4" />
					</button>
					<button
						type="button"
						className="rounded-md p-1 text-[var(--color-text-faint)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
						onClick={onOpenCollab}
						title={t("mobile remote control")}
						aria-label={t("mobile remote control")}
					>
						<Icon name="smartphone" className="h-4 w-4" />
					</button>
					<button
						type="button"
						className="rounded-md p-1 text-[var(--color-text-faint)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
						onClick={onDisconnect}
						title={t("Disconnect")}
						aria-label={t("Disconnect")}
					>
						<Icon name="close" className="h-4 w-4" />
					</button>
				</div>
			</div>
			{/* Session right-click menu (ZCode task menu): archive, copy id. */}
			<ContextMenu
				open={sessionCtx !== null}
				x={sessionCtx?.x ?? 0}
				y={sessionCtx?.y ?? 0}
				onClose={() => setSessionCtx(null)}
				items={
					sessionCtx
						? [
								{
									label: pinned.includes(sessionCtx.id) ? t("unpin task") : t("pin task"),
									icon: "pushpin",
									onSelect: () =>
										persistPinned(
											pinned.includes(sessionCtx.id)
												? pinned.filter(x => x !== sessionCtx.id)
												: [sessionCtx.id, ...pinned],
										),
								},
								{
									label: t("rename task"),
									icon: "pencil",
									onSelect: () => void renameSession(sessionCtx.id),
								},
								{
									label: t("archive task"),
									icon: "archive",
									onSelect: () => archiveSession(sessionCtx.id),
								},
								{
									label: unread?.has(sessionCtx.id) ? t("mark as read") : t("mark as unread"),
									icon: "chat-1",
									onSelect: () => onToggleUnread?.(sessionCtx.id),
								},
								{ divider: true },
								// Status tag (#完成/#中断/#错误…): manually tag a session
								// so unfinished history reads at a glance even without
								// grouping. The tag overrides the derived lifecycle
								// status on the row's left square; 清除标记 restores it.
								...(
									[
										{ tag: "complete", dot: "ok", label: t("tag complete") },
										{ tag: "interrupted", dot: "warning", label: t("tag interrupted") },
										{ tag: "error", dot: "danger", label: t("tag error") },
										{ tag: "aborted", dot: "muted", label: t("tag aborted") },
										{ tag: "pending", dot: "accent", label: t("tag pending") },
									] as const
								).map(({ tag, dot, label }) => ({
									label: `#${label}`,
									icon: "circle" as const,
									color: dot,
									onSelect: () => setSessionTag(sessionCtx.id, tag),
								})),
								{
									label: t("clear tag"),
									icon: "palette",
									disabled: !manualTags.has(sessionCtx.id),
									onSelect: () => setSessionTag(sessionCtx.id, null),
								},
								{ divider: true },
								{
									label: t("copy path"),
									icon: "folder",
									disabled: !sessionMeta.get(sessionCtx.id)?.cwd,
									onSelect: () => {
										const cwd = sessionMeta.get(sessionCtx.id)?.cwd;
										if (cwd) void navigator.clipboard?.writeText(cwd).catch(() => {});
									},
								},
								{
									label: t("copy session id"),
									icon: "clipboard",
									onSelect: () => {
										void navigator.clipboard?.writeText(sessionCtx.id).catch(() => {});
									},
								},
								{ divider: true },
								{
									label: t("open in finder"),
									icon: "folder-open",
									disabled: !sessionMeta.get(sessionCtx.id)?.cwd,
									onSelect: () => openInFinder(sessionCtx.id),
								},
							]
						: []
				}
			/>
			{/* Group right-click menu: rename / delete. */}
			<ContextMenu
				open={groupCtx !== null}
				x={groupCtx?.x ?? 0}
				y={groupCtx?.y ?? 0}
				onClose={() => setGroupCtx(null)}
				items={
					groupCtx
						? [
								{
									label: t("rename group"),
									icon: "pencil",
									onSelect: () => renameGroup(groupCtx.index),
								},
								{ divider: true },
								...GROUP_COLORS.map(color => ({
									label: t("group color {color}", { color: color }),
									icon: "circle" as const,
									onSelect: () =>
										setGroups(gs => gs.map((g, i) => (i === groupCtx.index ? { ...g, color } : g))),
									color,
								})),
								{ divider: true },
								{
									label: t("delete group"),
									icon: "delete-bin",
									danger: true,
									onSelect: () => setGroups(gs => gs.filter((_, i) => i !== groupCtx.index)),
								},
							]
						: []
				}
			/>
			{/* Project block right-click menu (ZCode parity with the group
			 * menu — same frosted-glass ContextMenu component): open folder,
			 * copy path, remove project. */}
			<ContextMenu
				open={projectCtx !== null}
				x={projectCtx?.x ?? 0}
				y={projectCtx?.y ?? 0}
				onClose={() => setProjectCtx(null)}
				items={
					projectCtx
						? [
								{
									label: t("open in finder"),
									icon: "folder-open",
									onSelect: () => {
										const api = (
											window as unknown as { electronAPI?: { revealPath?(p: string): Promise<void> } }
										).electronAPI;
										if (api?.revealPath) void api.revealPath(projectCtx.path);
									},
								},
								{
									label: t("copy path"),
									icon: "clipboard",
									onSelect: () => {
										void navigator.clipboard?.writeText(projectCtx.path).catch(() => {});
									},
								},
								{ divider: true },
								{
									label: t("remove project"),
									icon: "delete-bin",
									danger: true,
									onSelect: () => removeProject(projectCtx.path),
								},
							]
						: []
				}
			/>
		</aside>
	);
}
