import { t, useArchivedSessions } from "@musepi/client-core";
import type { SessionDirectoryInfo, WorkspaceProject } from "@musepi/pi-wire";
import {
	Archive as ArchiveIconData,
	ArchiveRestore as ArchiveRestoreIconData,
	ChevronsDownUp as ChevronsDownUpIconData,
	ChevronsUpDown as ChevronsUpDownIconData,
	Search as SearchIconData,
	X as XIconData,
} from "lucide";
import { MorphIcon } from "morphicons/react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { pushActionToast } from "../lib/action-toast";
import { isElectron, openPathInFileManager, pickDirectory } from "../lib/electron";
import type { ModeLabelEntry } from "../lib/mode-label";
import { pathBaseName, projectLabel, projectLabels } from "../lib/project-label";
import { useConfirm, usePrompt } from "../lib/prompt-dialog";
import type { RemoteHost } from "../lib/remote-hosts";
import type { RpcClient } from "../lib/rpc";
import { shortcutLabel } from "../lib/shortcuts";
import { useScrollShadow } from "../lib/use-scroll-shadow";
import {
	addSessionDirectory,
	createProject,
	deleteProject,
	directoriesEqual,
	listProjects,
	listSessionDirectories,
	migrateLegacyProjects,
	mirrorProjects,
	removeSessionDirectory,
	updateProject,
	type WorkspaceMutationResult,
} from "../lib/workspace-projects";
import { fileRootSelection, isRemoteMirrorCwd, resolveWorkspaceRoot, rootSelectionKey } from "../lib/workspace-roots";
import { Icon } from "../vendor/oc-icons";
import { ContextMenu } from "./ContextMenu";
import { type CustomGroup, CustomGroups } from "./CustomGroups";
import { DialogFrame } from "./DialogFrame";
import { GroupedSessionList } from "./GroupedSessionList";
import { InstanceButton } from "./InstanceButton";
import { MenuPopup } from "./MenuPopup";
import { ProjectDialog, type ProjectDialogTarget } from "./ProjectDialog";
import { Reveal } from "./Reveal";
import { ScrollEdgeBlur } from "./ScrollEdgeBlur";
import { SessionHoverCard } from "./SessionHoverCard";
import {
	hasCollapsedSubtrees,
	revealSessionInTree,
	SessionList,
	type SessionListNode,
	type SessionStatus,
	setAllSubtreesCollapsed,
	useHasCollapsedSubtrees,
} from "./SessionList";
import { SessionSearchBar } from "./SessionSearchBar";
import { filterSessionTree } from "./session-list-shared";

const SESSION_EMOJI_PALETTE = [
	"📁",
	"🐛",
	"✨",
	"🧠",
	"🚀",
	"🔧",
	"📝",
	"🎨",
	"⚡",
	"🔍",
	"🧪",
	"📦",
	"🌱",
	"🔥",
	"💡",
	"🧩",
	"🛠️",
	"📊",
	"🎯",
	"🤖",
	"📌",
	"🗂️",
	"🧭",
	"🫧",
] as const;

/**
 * Left pane: menu (new/search/scheduled/skills), a group/
 * project tab row, then the session list, and a user footer with daemon
 * status + theme toggles. Rounded containers, background-delta hierarchy,
 * no hairline borders.
 */
/** Accent colors for custom groups (right-click → 更改颜色). */
const GROUP_COLORS = ["accent", "green", "orange", "blue", "purple", "pink"];

/**
 * Outcome of an AI rename as the row menu consumes it. `ok` carries the
 * generated title so the caller can show it before its list refresh lands;
 * a failure carries why, so the toast names the next action instead of a
 * generic "failed" (the reason vocabulary is the daemon's own, plus the
 * client-side transport/version failures).
 */
export interface SessionRetitleResult {
	ok: boolean;
	title?: string;
	reason?: "empty" | "generation-failed" | "offline" | "timeout" | "unsupported" | "failed";
}

/** Failure copy per reason. `unsupported` is an old daemon that predates
 *  `session.retitle` — only an app/daemon restart loads the handler. */
function retitleFailureMessage(reason: string | undefined): string {
	switch (reason) {
		case "empty":
			return t("general.aiRenameEmpty");
		case "generation-failed":
			return t("general.aiRenameGenerationFailed");
		case "offline":
			return t("general.aiRenameOffline");
		case "timeout":
			return t("general.aiRenameTimeout");
		case "unsupported":
			return t("general.aiRenameUnsupported");
		default:
			return t("general.aiRenameFailed");
	}
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
	onNewSessionInProject,
	onDisconnect,
	onOpenConnect,
	onOpenWorkspace,
	onOpenSettings,
	onAddProject,
	onOpenCollab,
	onOpenInstanceManager,
	onOpenRemoteDisclaimer,
	onOpenShortcuts,
	onRenameSession,
	onOpenSearch,
	onOpenMiniChat,
	collapsed,
	width,
	onDeleteArchived,
	onDeleteSession,
	onExportSession,
	onRetitleSession,
	onReloadSession,
	unread,
	onToggleUnread,
	onImportSessions,
	modeCatalog,
	showFooter = true,
	gettingStarted,
	rpc,
	connected,
	daemonUrl,
	onReconnect,
	hosts,
	onSwitchHost,
	onAddHost,
	onRemoveHost,
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
			/** 会话预设 id — 悬浮卡的模式行(app 侧 SessionMetaRow 的子集)。 */
			modeId?: string;
			/** 子代理数（session.list agentCount）—— >0 的会话行出现展开 chevron。 */
			agentCount?: number;
		}
	>;
	selectedId: string | null;
	onSelect(id: string): void;
	onNewSession(): void;
	/** Create a session rooted at one project row (hover "+"). */
	onNewSessionInProject?(cwd: string): void;
	onDisconnect(): void;
	onOpenConnect(): void;
	onOpenWorkspace(cwd: string): void;
	onOpenSettings(): void;
	/** 添加项目 — native directory picker, then the project dialog. */
	onAddProject?(): void;
	/** Open the collab remote-control dialog. */
	onOpenCollab?(): void;
	onOpenInstanceManager(open: () => void): void;
	onOpenRemoteDisclaimer(): void;
	/** Open the keyboard-shortcuts reference. */
	onOpenShortcuts?(): void;
	/** Persist a user-set session title (daemon session.rename). */
	onRenameSession?(sessionId: string, title: string): void;
	/** Open the app-level command palette (⌘K / sidebar 搜索). */
	onOpenSearch(): void;
	collapsed: boolean;
	/** Permanently delete a session's local data (journal + index) via the
	 *  daemon; returns success so the UI only drops the archive row on a real
	 *  deletion (the confirm dialog wording promises data cleanup). */
	onDeleteArchived(sessionId: string): Promise<boolean>;
	/** Permanently delete a session from its row menu (same daemon
	 *  session.delete + centralized confirm as the top-bar menu).
	 *  Optional: without it the row menu simply omits the delete item. */
	onDeleteSession?(sessionId: string): Promise<boolean> | void;
	/** Export a session transcript as Markdown from its row menu (same
	 *  client-side download as the top-bar menu). Optional: without it
	 *  the row menu omits the export item. */
	onExportSession?(sessionId: string, title: string): Promise<boolean>;
	/** AI rename a session from its row menu (daemon session.retitle).
	 *  Resolves the outcome so the menu can toast the failure reason.
	 *  Optional: without it the row menu omits the AI item. */
	onRetitleSession?(sessionId: string): Promise<SessionRetitleResult>;
	/** Reload a session from disk (daemon session.reload), then reopen it. */
	onReloadSession?(sessionId: string): void;
	/** Pane width in px (draggable resize). */
	width?: number;
	/** Unread session ids (single source: app-level unread set — pet
	 *  bubbles, cursor-based derivation, and manual context-menu toggles). */
	unread?: ReadonlySet<string>;
	/** Context-menu 标记为已读/未读 toggle. */
	onToggleUnread?(sessionId: string): void;
	/** Open the session-import dialog (projects tab entry). */
	onImportSessions?(): void;
	/** modes.list catalog (builtin + user-created presets) — forwarded to the
	 *  hover card's mode row (shared naming chain, lib/mode-label.ts). */
	modeCatalog?: readonly ModeLabelEntry[] | null;
	/** Render the bottom instance/shortcuts/settings/remote footer. The two-
	 *  tier shell hosts those entries in the permanent rail, so app.tsx sets
	 *  false; other hosts (and the sidebar contract tests) keep the default. */
	showFooter?: boolean;
	/** Bottom-of-panel getting-started checklist. The host owns the card and
	 *  its actions; the sidebar only supplies the layout slot so the card
	 *  folds and peeks together with the session list. */
	gettingStarted?: ReactNode;
	/** Mini chat: pop a session row out into the
	 *  picture-in-picture mini chat window (Electron); non-Electron hosts
	 *  should fall back to opening the session in place. */
	onOpenMiniChat?(sessionId: string): void;
	/** Daemon RPC client — the projects-tab ghost sweep probes each persisted
	 *  folder with fs.stat; absent (non-Electron dev hosts) the sweep skips. */
	rpc?: RpcClient;
	/** Daemon connection state (footer instance button status dot). */
	connected: boolean;
	/** WebSocket endpoint URL of the connected daemon (instance menu host row). */
	daemonUrl: string;
	/** Re-run the daemon boot/connect chain (instance menu 重新连接). */
	onReconnect(): void;
	/** Saved remote daemon hosts for the instance switcher. */
	hosts: RemoteHost[];
	/** Switch the GUI to a host (remote or the implicit local daemon). */
	onSwitchHost(host: RemoteHost | null): void;
	/** Persist a new host entry from the add form. */
	onAddHost(host: { label: string; url: string; token?: string }): void;
	/** Remove a saved host by id. */
	onRemoveHost(id: string): void;
}): ReactNode {
	// groups ↔ projects is persisted (issue #34): opening Settings unmounts
	// this whole subtree, so in-memory state silently reset to "groups" on
	// every return. Lazy-init from storage + write on change keeps the user's
	// chosen view across settings round-trips and restarts.
	const [tab, setTab] = useState<"groups" | "projects">(() => {
		try {
			return localStorage.getItem("musepi-gui-sidebar-tab") === "projects" ? "projects" : "groups";
		} catch {
			return "groups";
		}
	});
	const pickTab = (next: "groups" | "projects"): void => {
		setTab(next);
		try {
			localStorage.setItem("musepi-gui-sidebar-tab", next);
		} catch {
			// storage unavailable
		}
	};
	// The capsule holds two content-sized pills; its thumb is measured from
	// the active pill instead of assuming equal widths (labels differ by
	// locale). A hidden copy of the labelled capsule reports how much room
	// the row needs, so the pills morph to icons exactly when the pane can
	// no longer fit the text — not at a hardcoded pixel width.
	const tabstripRef = useRef<HTMLDivElement | null>(null);
	const tabCapsuleRef = useRef<HTMLDivElement | null>(null);
	const tabMeasureRef = useRef<HTMLDivElement | null>(null);
	const tabActionsRef = useRef<HTMLDivElement | null>(null);
	const tabPillRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const [tabsIconOnly, setTabsIconOnly] = useState(false);
	const syncTabstrip = useCallback((): void => {
		const strip = tabstripRef.current;
		const capsule = tabCapsuleRef.current;
		const measure = tabMeasureRef.current;
		const actions = tabActionsRef.current;
		if (!strip || !capsule || !measure || !actions) return;
		setTabsIconOnly(measure.offsetWidth + actions.offsetWidth + 4 > strip.clientWidth);
		const pill = tabPillRefs.current[tab === "groups" ? 0 : 1];
		if (!pill) return;
		// The thumb is inset 2px (capsule padding) and offsetLeft is measured
		// from the capsule's padding box, so subtract that inset.
		capsule.style.setProperty("--tab-thumb-x", `${pill.offsetLeft - 2}px`);
		capsule.style.setProperty("--tab-thumb-w", `${pill.offsetWidth}px`);
	}, [tab]);
	useLayoutEffect(() => {
		syncTabstrip();
	}, [syncTabstrip, tabsIconOnly]);
	useEffect(() => {
		const strip = tabstripRef.current;
		const measure = tabMeasureRef.current;
		const actions = tabActionsRef.current;
		if (!strip || !measure || !actions || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => syncTabstrip());
		observer.observe(strip);
		observer.observe(measure);
		observer.observe(actions);
		return () => observer.disconnect();
	}, [syncTabstrip]);
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
	const [sessionEmoji, setSessionEmojiMap] = useState<ReadonlyMap<string, string>>(() => {
		try {
			const raw = localStorage.getItem("musepi-gui-session-emoji");
			return raw ? new Map(Object.entries(JSON.parse(raw) as Record<string, string>)) : new Map();
		} catch {
			return new Map();
		}
	});
	const setSessionEmoji = (id: string, emoji: string | null): void => {
		const next = new Map(sessionEmoji);
		if (emoji === null || emoji.trim().length === 0) next.delete(id);
		else next.set(id, emoji.trim().slice(0, 16));
		setSessionEmojiMap(next);
		try {
			localStorage.setItem("musepi-gui-session-emoji", JSON.stringify(Object.fromEntries(next)));
		} catch {
			// storage unavailable
		}
	};
	const [emojiTarget, setEmojiTarget] = useState<string | null>(null);
	const [emojiDraft, setEmojiDraft] = useState("");
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
		void prompt({ title: t("settings.renameSession"), defaultValue: current }).then(next => {
			if (!next || next === current) return;
			onRenameSession?.(id, next);
		});
	};
	// The OS label follows the shell, not the UI language: Finder is macOS-only.
	const openFolderLabel = (): string => {
		const platform = (window as unknown as { electronAPI?: { platform?: string } }).electronAPI?.platform ?? "";
		if (platform === "win32") return t("settings.openInExplorer");
		if (platform === "darwin") return t("settings.openFinder");
		return t("settings.openInFileManager");
	};
	const openFolder = (target: string): void => {
		// The web build has no OS bridge; a failed toast there would blame the
		// path for a missing shell feature.
		if (!isElectron()) return;
		void openPathInFileManager(target).then(ok => {
			if (!ok) pushActionToast({ kind: "error", message: t("settings.openFolderFailed") });
		});
	};
	const openInFinder = (id: string): void => {
		const cwd = sessionMeta.get(id)?.cwd;
		if (!cwd) return;
		openFolder(cwd);
	};
	const [viewMenu, setViewMenu] = useState(false);
	const viewMenuAnchorRef = useRef<HTMLButtonElement | null>(null);
	const projMenuAnchorRef = useRef<HTMLButtonElement | null>(null);
	const [projView, setProjView] = useState<"project" | "timeline">("project");
	const [projSort, setProjSort] = useState<"updated" | "created">("updated");
	// `cwd` is a workspace-derived group's stable identity (issue #15).
	const [groups, setGroups] = useState<CustomGroup[]>(() => {
		try {
			const raw = localStorage.getItem("musepi-gui-groups");
			return raw ? (JSON.parse(raw) as CustomGroup[]) : [];
		} catch {
			return [];
		}
	});
	// Inline group-name editing (double-click the block / context menu).
	const [groupEditIdx, setGroupEditIdx] = useState<number | null>(null);
	// Archived sessions (archive view). Shared with the guest/mobile shell
	// through guest-client's session-archive module — one localStorage key, one
	// event, and it migrates the two legacy keys (2026-09-15). archivedAt is
	// display time; cwd is captured at archive time from session.list so the
	// archive row can show the folder (tree nodes carry no cwd).
	const { archived, ids: archivedIds, archive: archiveSession, unarchive: unarchiveSession } = useArchivedSessions();
	const [archivedView, setArchivedView] = useState(false);
	// Archive rows name the folder; two archived workspaces that share a
	// basename widen to their parent instead of reading as the same project.
	// The full cwd stays on the row's title.
	const archivedLabels = useMemo(() => projectLabels(archived.flatMap(a => (a.cwd ? [a.cwd] : []))), [archived]);
	// Content-boundary feather (transcript parity): the session list scrolls
	// inside the sidebar — data-top-scroll / data-bottom-scroll flip the
	// mask-image fade on and off as the list overflows (useScrollShadow).
	const sessionListRef = useRef<HTMLDivElement | null>(null);
	useScrollShadow(sessionListRef);
	// Project blocks (projects tab): the daemon's persisted registry
	// (`workspace.list`) — explicit managed projects plus implicit rows
	// backfilled from session cwds. The sidebar keeps no project list of its
	// own; every mutation goes through RPC and then reloads.
	const [projects, setProjects] = useState<WorkspaceProject[]>([]);
	const [projectsError, setProjectsError] = useState<string | null>(null);
	// Bumped after a mutation or a project-added broadcast to re-run the load.
	const [projectsRevision, setProjectsRevision] = useState(0);
	const reloadProjects = useCallback((): void => setProjectsRevision(revision => revision + 1), []);
	/** Visual order only (drag-to-reorder). Daemon rows the order does not name
	 *  keep their `lastOpenedAt` order at the bottom. */
	const [projectOrder, setProjectOrder] = useState<string[]>(() => {
		try {
			const raw = localStorage.getItem("musepi-gui-projects-order");
			const parsed: unknown = raw ? JSON.parse(raw) : [];
			return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
		} catch {
			return [];
		}
	});
	const orderedProjects = useMemo(() => {
		const rank = new Map(projectOrder.map((root, index) => [root, index]));
		return [...projects].sort((a, b) => {
			const left = rank.get(a.root);
			const right = rank.get(b.root);
			if (left === undefined && right === undefined) return 0;
			if (left === undefined) return 1;
			if (right === undefined) return -1;
			return left - right;
		});
	}, [projects, projectOrder]);
	/** Insert-edge hint while dragging a project head (M2.8): which block
	 * shows the shared .gui-drop-line, and on which edge. The block body
	 * keeps its swap-on-drop semantics; the head offers precise
	 * insert-before/after positioning. */
	const [projInsert, setProjInsert] = useState<{
		path: string;
		edge: "before" | "after";
	} | null>(null);
	// Per-project collapse state, keyed by root (expanded by default).
	const [collapsedProjects, setCollapsedProjects] = useState<string[]>(() => {
		try {
			const raw = localStorage.getItem("musepi-gui-projects-collapsed");
			const parsed: unknown = raw ? JSON.parse(raw) : [];
			return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
		} catch {
			return [];
		}
	});
	// Selecting or creating a session reveals it once: its project and its
	// parent-session chain expand, while every unrelated manual fold stays put.
	const revealedSelection = useRef<string | null>(null);
	useEffect(() => {
		if (!selectedId || revealedSelection.current === selectedId) return;
		const cwd = sessionMeta.get(selectedId)?.cwd;
		if (cwd) {
			setCollapsedProjects(current => (current.includes(cwd) ? current.filter(path => path !== cwd) : current));
		}
		// A brand-new session reaches the tree one poll later; leave the marker
		// unset until then so the parent chain still opens.
		if (revealSessionInTree(nodes, selectedId)) revealedSelection.current = selectedId;
	}, [nodes, selectedId, sessionMeta]);
	const [sessionCtx, setSessionCtx] = useState<{
		id: string;
		x: number;
		y: number;
	} | null>(null);
	/** Working directories of the session whose row menu is open (loaded on
	 *  demand; a snapshot session has none). */
	const [sessionDirs, setSessionDirs] = useState<SessionDirectoryInfo[] | null>(null);
	// Stable row callback: session rows are memoized, so an inline arrow at each
	// call site would defeat the memo on every sidebar render (5s status poll,
	// streaming updates, pinned/tag edits) and re-render the whole list.
	const openSessionCtx = useCallback((id: string, x: number, y: number): void => {
		setSessionCtx({ id, x, y });
	}, []);
	// AI rename in flight (row menu item disables while its own run is
	// pending -- show a spinner; disabled-with-same-label
	// is the ContextMenu vocabulary for busy here).
	const [retitlingId, setRetitlingId] = useState<string | null>(null);
	// Row display title for the export filename/header: node label wins,
	// then the entry label, then the raw id.
	const sessionLabelOf = (id: string): string => {
		const walk = (ns: SessionListNode[]): string | null => {
			for (const n of ns) {
				if (n.entry.id === id) return n.label ?? n.entry.label ?? id;
				const child = walk(n.children ?? []);
				if (child) return child;
			}
			return null;
		};
		return walk(nodes) ?? id;
	};
	const [groupCtx, setGroupCtx] = useState<{
		index: number;
		x: number;
		y: number;
	} | null>(null);
	const [projectCtx, setProjectCtx] = useState<{
		path: string;
		x: number;
		y: number;
	} | null>(null);
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
				unarchiveSession(id);
			}
		},
		[onDeleteArchived, unarchiveSession],
	);
	useEffect(() => {
		localStorage.setItem("musepi-gui-groups", JSON.stringify(groups));
	}, [groups]);
	// Import-created groups (ImportSessionsSetup merges into the same store
	// and dispatches this) — the storage event is same-document-deaf, so a
	// custom event re-reads them live.
	useEffect(() => {
		const onExternal = (): void => {
			try {
				const raw = localStorage.getItem("musepi-gui-groups");
				setGroups(
					raw
						? (JSON.parse(raw) as {
								name: string;
								sessions: string[];
								color?: string;
							}[])
						: [],
				);
			} catch {
				// ignore malformed storage
			}
		};
		window.addEventListener("musepi-gui-groups-changed", onExternal);
		return () => window.removeEventListener("musepi-gui-groups-changed", onExternal);
	}, []);
	useEffect(() => {
		try {
			localStorage.setItem("musepi-gui-projects-collapsed", JSON.stringify(collapsedProjects));
		} catch {
			// storage unavailable
		}
	}, [collapsedProjects]);
	useEffect(() => {
		try {
			localStorage.setItem("musepi-gui-projects-order", JSON.stringify(projectOrder));
		} catch {
			// storage unavailable
		}
	}, [projectOrder]);
	// Session cwds are the daemon's implicit-project backfill input, so a new
	// workspace must re-run `workspace.list` — that is how a folder picked in
	// the header (or a session created elsewhere) reaches this tab. Remote
	// mirrors (~/.musepi/remote/…) stay out; they belong to 远程连接.
	const sessionCwdKey = useMemo(() => {
		const cwds = new Set<string>();
		for (const [, meta] of sessionMeta) {
			if (meta.cwd && !/(^|[\\/])\.musepi[\\/]remote[\\/]/.test(meta.cwd)) cwds.add(meta.cwd);
		}
		return [...cwds].sort().join("\n");
	}, [sessionMeta]);
	// Registry load: import the pre-registry localStorage list once, then read
	// `workspace.list` and mirror the roots back for surfaces that still read
	// the legacy key (WelcomeComposer, PR board, scheduled tasks).
	useEffect(() => {
		if (!rpc) {
			setProjects([]);
			return;
		}
		let cancelled = false;
		void (async () => {
			try {
				const migration = await migrateLegacyProjects(rpc);
				if (cancelled) return;
				if (!migration.migrated && migration.imported.length === 0 && migration.failed.length > 0) {
					pushActionToast({ kind: "error", message: t("settings.projectMigrationFailed") });
				}
				const rows = await listProjects(rpc);
				if (cancelled) return;
				// Remote-session mirrors (~/.musepi/remote/…) belong to 远程连接,
				// not the local workspace list: keep them out of the implicit
				// blocks the daemon backfills from every session cwd.
				const visible = rows.filter(
					row => row.kind !== "implicit" || !/(^|[\\/])\.musepi[\\/]remote[\\/]/.test(row.root),
				);
				setProjects(visible);
				setProjectsError(null);
				mirrorProjects(localStorage, visible);
			} catch (error) {
				if (cancelled) return;
				setProjectsError(error instanceof Error ? error.message : String(error));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [rpc, projectsRevision, sessionCwdKey]);
	// Folders the app picks (添加项目 menu, ⌘O, welcome composer) create the
	// registry row themselves and announce it — re-read instead of patching a
	// local copy, so the daemon stays the only list.
	useEffect(() => {
		const onProjectsChanged = (): void => reloadProjects();
		window.addEventListener("musepi-gui-projects-changed", onProjectsChanged);
		window.addEventListener("musepi-gui-project-added", onProjectsChanged);
		return () => {
			window.removeEventListener("musepi-gui-projects-changed", onProjectsChanged);
			window.removeEventListener("musepi-gui-project-added", onProjectsChanged);
		};
	}, [reloadProjects]);
	// Implicit rows are backfilled from session cwds, so deleted temp/test
	// workspaces (Temp\daemon-viewkey-*) would linger forever. Sweep only
	// implicit rows (a managed row was added deliberately and may be a
	// temporarily unavailable mount); the daemon tombstones the root, so the
	// removed row does not come back on the next load.
	useEffect(() => {
		if (!rpc) return;
		const gone = projects.filter(project => project.kind === "implicit");
		if (gone.length === 0) return;
		let cancelled = false;
		void Promise.all(
			gone.map(p => rpc.request<{ exists?: boolean }>("fs.stat", { path: p.root }).catch(() => null)),
		).then(results => {
			if (cancelled) return;
			const missing = gone.filter((_, index) => results[index]?.exists === false);
			if (missing.length === 0) return;
			void Promise.allSettled(missing.map(project => deleteProject(rpc, project.id))).then(() => {
				if (!cancelled) reloadProjects();
			});
		});
		return () => {
			cancelled = true;
		};
	}, [rpc, projects, reloadProjects]);
	// Root choices in the session row menu need the live session's working
	// directories; load them when the menu opens and drop them on close.
	useEffect(() => {
		const sessionId = sessionCtx?.id;
		setSessionDirs(null);
		if (!rpc || !sessionId) return;
		let cancelled = false;
		void listSessionDirectories(rpc, sessionId)
			.then(rows => {
				if (!cancelled) setSessionDirs(rows);
			})
			.catch(() => {
				// A snapshot session is not live: no additional roots to offer.
			});
		return () => {
			cancelled = true;
		};
	}, [rpc, sessionCtx?.id]);
	// The header's session ⋯ menu (and the task center) can archive sessions —
	// useArchivedSessions subscribes to the shared store, so this component's
	// copy follows every writer without a reload.
	const visibleNodes = nodes.filter(n => !archivedIds.has(n.entry.id));
	// Session search: the tree is filtered by
	// label + cwd through the shared filterSessionTree, which also reports how
	// many sessions the query kept — the box's count and the filtered list come
	// from the same pass and so can never disagree.
	const [sessionQuery, setSessionQuery] = useState("");
	const [searchOpen, setSearchOpen] = useState(false);
	const searchInputRef = useRef<HTMLInputElement | null>(null);
	const { nodes: searchedNodes, matched: searchMatchCount } = useMemo(
		() =>
			filterSessionTree(
				visibleNodes,
				sessionQuery,
				n => `${n.label ?? n.entry.label ?? ""} ${sessionMeta.get(n.entry.id)?.cwd ?? ""}`,
			),
		[visibleNodes, sessionQuery, sessionMeta],
	);
	const searchActive = sessionQuery.trim().length > 0;
	const pinnedNodes = searchedNodes.filter(n => pinned.includes(n.entry.id));
	// Closing the box clears the query with it: a filtered list must never
	// outlive the control that explains it.
	const closeSearch = useCallback((): void => {
		setSearchOpen(false);
		setSessionQuery("");
	}, []);
	const handleSearchOpenChange = useCallback(
		(next: boolean): void => {
			if (next) setSearchOpen(true);
			else closeSearch();
		},
		[closeSearch],
	);
	// Sidebar-search accelerator: ⌘⇧F (Ctrl+Shift+F elsewhere). Plain ⌘F
	// belongs to the in-chat find bar (find-in-chat in the shortcut
	// registry) — the two entry points never fight; ⌘K remains
	// the app command palette; a collapsed pane leaves the keys alone.
	useEffect(() => {
		if (collapsed) return;
		const onKey = (event: KeyboardEvent): void => {
			if (!(event.metaKey || event.ctrlKey) || event.altKey || !event.shiftKey) return;
			if (event.key.toLowerCase() !== "f") return;
			event.preventDefault();
			setSearchOpen(true);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [collapsed]);
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
				{t("settings.scheduledTasks")}
			</div>
			<SessionList
				nodes={cronNodes}
				selectedId={selectedId}
				onSelect={onSelect}
				onContextMenu={openSessionCtx}
				pausedIds={pausedIds}
				workingIds={workingIds}
				statuses={statuses}
				manualTags={manualTags}
				emojis={sessionEmoji}
				onRenameSession={onRenameSession}
				searchQuery={sessionQuery}
				retitlingId={retitlingId}
			/>
		</div>
	);
	const projectRoots = useMemo(() => projects.map(project => project.root), [projects]);
	const projectOf = useCallback(
		(root: string): WorkspaceProject | undefined => projects.find(project => project.root === root),
		[projects],
	);
	/** Run one registry mutation, then re-read `workspace.list`. */
	const runProjectMutation = useCallback(
		async (action: () => Promise<unknown>, message: string): Promise<void> => {
			try {
				await action();
				reloadProjects();
			} catch (error) {
				const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
				pushActionToast({ kind: "error", message: `${message}${detail}` });
			}
		},
		[reloadProjects],
	);
	const toggleProject = (path: string): void => {
		setCollapsedProjects(prev => (prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path]));
	};
	const removeProject = (root: string): void => {
		const project = projectOf(root);
		if (!rpc || !project) return;
		// Disambiguated too (issue #15) — "remove demo?" is ambiguous when two
		// different folders are both called demo.
		void confirm(`${t("general.removeProject")} ${projectLabel(root, projectRoots)}?`, t("general.remove"), {
			destructive: true,
		}).then(ok => {
			if (!ok) return;
			void runProjectMutation(() => deleteProject(rpc, project.id), t("settings.projectDeleteFailed")).then(() => {
				setCollapsedProjects(prev => prev.filter(p => p !== root));
				setProjectOrder(prev => prev.filter(p => p !== root));
			});
		});
	};
	const promoteProject = (root: string): void => {
		const project = projectOf(root);
		if (!rpc || !project) return;
		void createProject(rpc, project.root, project.name)
			.then(result => {
				reloadProjects();
				// Promotion is a claim to manage the project; open the editor so
				// the next action (naming/source folders) is one click away.
				setProjectDialog({
					mode: "edit",
					target: {
						id: result.workspace.id,
						root: result.workspace.root,
						name: result.workspace.name,
						additionalDirs: result.workspace.additionalDirs,
					},
				});
			})
			.catch(error => {
				const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
				pushActionToast({ kind: "error", message: `${t("settings.projectPromoteFailed")}${detail}` });
			});
	};
	// One modal owns every project mutation (name + source folders). The
	// daemon row stays the authority: the dialog is seeded from the loaded
	// list, and a successful save re-reads it.
	const [projectDialog, setProjectDialog] = useState<{
		mode: "create" | "edit";
		target: ProjectDialogTarget;
	} | null>(null);
	const openProjectEditor = (root: string): void => {
		const project = projectOf(root);
		if (!project) return;
		setProjectDialog({
			mode: "edit",
			target: {
				id: project.id,
				root: project.root,
				name: project.name,
				additionalDirs: project.additionalDirs,
			},
		});
	};
	const applyProjectResult = useCallback(
		(result: WorkspaceMutationResult): void => {
			const previousRoot = projectDialog?.target.root;
			const workspace = result.workspace;
			// Collapse/order state is keyed by root; move it with a primary swap
			// so the block keeps its place instead of reopening elsewhere.
			if (previousRoot && !directoriesEqual(previousRoot, workspace.root)) {
				const remap = (root: string): string => (directoriesEqual(root, previousRoot) ? workspace.root : root);
				setCollapsedProjects(prev => prev.map(remap));
				setProjectOrder(prev => prev.map(remap));
			}
			reloadProjects();
		},
		[projectDialog?.target.root, reloadProjects],
	);
	// ── Session working directories (live session header) ──────────────
	// The file pane offers these roots; the daemon validates and reports an
	// already-present directory through `duplicate` instead of failing.
	const addWorkingDirectory = async (sessionId: string, remember = false): Promise<void> => {
		if (!rpc) return;
		const directory = (await pickDirectory())?.trim();
		if (!directory) return;
		try {
			const result = await addSessionDirectory(rpc, sessionId, directory);
			setSessionDirs(result.directories);
			if (result.duplicate) {
				pushActionToast({
					kind: "error",
					message: t("settings.directoryDuplicate", { path: result.duplicate.directory }),
				});
				return;
			}
			pushActionToast({
				kind: "success",
				message: t("settings.directoryAdded", { path: result.directory ?? directory }),
			});
			if (!remember) return;
			const cwd = sessionMeta.get(sessionId)?.cwd;
			if (!cwd || isRemoteMirrorCwd(cwd)) return;
			const project = projectOf(cwd);
			try {
				if (project?.kind === "managed") {
					const next = [...project.additionalDirs];
					if (!next.some(existing => directoriesEqual(existing, directory))) next.push(directory);
					await updateProject(rpc, project.id, { additionalDirs: next });
				} else {
					// Implicit row (session-history backfill): creating the project
					// promotes it and seeds the directory in one call.
					await createProject(rpc, cwd, project?.name ?? pathBaseName(cwd), [directory]);
				}
				reloadProjects();
				pushActionToast({
					kind: "success",
					message: t("settings.directoryRemembered", { path: directory }),
				});
			} catch (rememberError) {
				const detail = rememberError instanceof Error && rememberError.message ? `: ${rememberError.message}` : "";
				pushActionToast({ kind: "error", message: `${t("settings.rememberDirectoryFailed")}${detail}` });
			}
		} catch (error) {
			const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
			pushActionToast({ kind: "error", message: `${t("settings.addDirectoryFailed")}${detail}` });
		}
	};
	const removeWorkingDirectory = async (sessionId: string, directory: string): Promise<void> => {
		if (!rpc) return;
		try {
			setSessionDirs(await removeSessionDirectory(rpc, sessionId, directory));
			pushActionToast({
				kind: "success",
				message: t("settings.directoryRemoved", { path: directory }),
			});
		} catch (error) {
			const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
			pushActionToast({ kind: "error", message: `${t("settings.removeDirectoryFailed")}${detail}` });
		}
	};
	// Collapse/expand every project at once (tab-row quick toggle).
	const collapseAllProjects = (collapse: boolean): void => {
		setCollapsedProjects(collapse ? [...projectRoots] : []);
	};
	// Icon direction for the same button: any collapsed subtree/block means
	// the next click expands, so the glyph shows the action, not a fixed shape.
	const subtreesCollapsed = useHasCollapsedSubtrees();
	const anyCollapsed =
		tab === "groups" ? groupsAll === true || subtreesCollapsed : collapsedProjects.length > 0 || subtreesCollapsed;
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
						<span>{t("settings.newTask")}</span>
						<span className="gui-menu-kbd">{shortcutLabel("⌘N")}</span>
					</button>
					<button type="button" className="gui-menu-item" onClick={onOpenSearch} title={t("settings.search")}>
						<Icon name="search" className="h-4 w-4" />
						<span>{t("settings.search")}</span>
						<span className="gui-menu-kbd">{shortcutLabel("⌘K")}</span>
					</button>
				</div>
				{/* Group / project tabs: the capsule wraps ONLY the two pills; the
				 * right cluster carries a collapse/expand-all quick toggle plus the
				 * contextual and archive actions. mx-5 keeps the capsule flush with
				 * the menu row's content above (px-2.5 container + 10px item
				 * padding), and ml-auto on the cluster mirrors the shortcut
				 * symbols' right edge — both scale with pane width. */}
				<div className="gui-tabstrip mx-5 mt-3 flex items-center" ref={tabstripRef}>
					{/* Sliding thumb: the capsule tracks the active tab with one
					 * translating highlight. Pills size to their labels (locale-
					 * dependent), so the thumb geometry is measured from the active
					 * pill instead of assuming equal halves. */}
					<div
						className={`gui-tabstrip-capsule${tabsIconOnly ? " gui-tabstrip-capsule--icon" : ""}`}
						ref={tabCapsuleRef}
					>
						<span className="gui-tab-thumb" aria-hidden />
						{/* Hidden label copy: reports the width the row needs for text,
						 * so the morph below reacts to the real content, not a guess. */}
						<div className="gui-tab-measure" aria-hidden ref={tabMeasureRef}>
							<span className="gui-tab-pill gui-tab-pill--fixed">
								<Icon name="stack" className="h-3.5 w-3.5" />
								<span className="gui-tab-pill-label">{t("settings.groups")}</span>
							</span>
							<span className="gui-tab-pill gui-tab-pill--fixed">
								<Icon name="folder" className="h-3.5 w-3.5" />
								<span className="gui-tab-pill-label">{t("settings.projects")}</span>
							</span>
						</div>
						<button
							type="button"
							ref={el => {
								tabPillRefs.current[0] = el;
							}}
							className={`gui-tab-pill gui-tab-pill--fixed${tab === "groups" ? " gui-tab-pill--active" : ""}`}
							title={t("settings.groups")}
							aria-label={t("settings.groups")}
							onClick={() => pickTab("groups")}
						>
							<Icon name="stack" className="h-3.5 w-3.5" />
							<span className="gui-tab-pill-label">{t("settings.groups")}</span>
						</button>
						<button
							type="button"
							ref={el => {
								tabPillRefs.current[1] = el;
							}}
							className={`gui-tab-pill gui-tab-pill--fixed${tab === "projects" ? " gui-tab-pill--active" : ""}`}
							title={t("settings.projects")}
							aria-label={t("settings.projects")}
							onClick={() => pickTab("projects")}
						>
							<Icon name="folder" className="h-3.5 w-3.5" />
							<span className="gui-tab-pill-label">{t("settings.projects")}</span>
						</button>
					</div>
					{/* Right cluster: never shrinks — the capsule flexes instead, so
					 * the toggle/add/archive buttons stay fully visible at any pane
					 * width and always sit flush to the strip's right edge. */}
					<div className="ml-auto flex flex-shrink-0 items-center gap-0.5" ref={tabActionsRef}>
						{/* Session search toggle: keyboard reachable (Tab → Enter) and
						 * the ⌘⇧F accelerator (⌘F is the in-chat find bar); `data-search-toggle`
						 * keeps the box's outside-dismiss from swallowing the closing click. */}
						<button
							type="button"
							className="gui-tab-action"
							data-search-toggle="true"
							title={`${t("settings.searchSessions")} (${shortcutLabel("⌘⇧F")})`}
							aria-label={t("settings.searchSessions")}
							aria-expanded={searchOpen}
							onClick={() => {
								if (searchOpen) closeSearch();
								else setSearchOpen(true);
							}}
						>
							<MorphIcon
								icon={searchOpen ? XIconData : SearchIconData}
								size={14}
								spring="snappy"
								reducedMotion="user"
								className="h-3.5 w-3.5"
							/>
						</button>
						<button
							type="button"
							className="gui-tab-action"
							title={t("general.expandCollapseAll")}
							aria-label={t("general.expandCollapseAll")}
							onClick={() => {
								const collapse =
									tab === "groups"
										? groupsAll === null
											? !hasCollapsedSubtrees()
											: groupsAll === true
										: collapsedProjects.length === 0 && !hasCollapsedSubtrees();
								if (tab === "groups") setGroupsAll(!collapse);
								else collapseAllProjects(collapse);
								setAllSubtreesCollapsed(collapse);
							}}
						>
							<MorphIcon
								icon={anyCollapsed ? ChevronsUpDownIconData : ChevronsDownUpIconData}
								size={14}
								spring="snappy"
								reducedMotion="user"
								className="h-3.5 w-3.5"
							/>
						</button>
						{tab === "groups" ? (
							<button
								type="button"
								className="gui-tab-action"
								title={t("settings.newGroup")}
								aria-label={t("settings.newGroup")}
								onClick={() =>
									setGroups(g => [
										...g,
										{
											name: t("settings.newGroup"),
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
								title={t("settings.viewSort")}
								aria-label={t("settings.viewSort")}
								aria-expanded={viewMenu}
								onClick={() => setViewMenu(v => !v)}
							>
								<Icon name="equalizer-2" className="h-3.5 w-3.5" />
							</button>
						)}
						<button
							type="button"
							className={`gui-tab-action${archivedView ? " gui-tab-action--active" : ""}`}
							title={t("settings.archive")}
							aria-label={t("settings.archive")}
							aria-pressed={archivedView}
							onClick={() => {
								setArchivedView(v => !v);
								setViewMenu(false);
							}}
						>
							<MorphIcon
								icon={archivedView ? ArchiveRestoreIconData : ArchiveIconData}
								size={14}
								spring="snappy"
								reducedMotion="user"
								className="h-3.5 w-3.5"
							/>
						</button>
					</div>
				</div>
				{/* View/sort menu (projects tab). Floating portal
				 * (not an inline block) so it overlays the tree like the other
				 * menus. */}
				{tab === "projects" && (
					<MenuPopup
						open={viewMenu}
						className="gui-view-menu"
						portal
						anchor={viewMenuAnchorRef.current}
						align="right"
						onOpenChange={setViewMenu}
					>
						<div className="px-2 py-1 text-[13px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
							{t("settings.view")}
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
							<span>{t("settings.byProject")}</span>
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
							<span>{t("settings.timeline")}</span>
							{projView === "timeline" && <Icon name="check" className="h-3 w-3 ml-auto" />}
						</button>
						<div className="mt-1 px-2 py-1 text-[13px] font-semibold uppercase tracking-wider text-[var(--color-text-faint)]">
							{t("settings.sortBy")}
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
							<span>{t("settings.updatedTime")}</span>
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
							<span>{t("settings.createdTime")}</span>
							{projSort === "created" && <Icon name="check" className="h-3 w-3 ml-auto" />}
						</button>
					</MenuPopup>
				)}
				{/* Sessions list — custom groups in groups tab; project/timeline in
				 * projects; archived sessions in the archive view. */}
				<div className="gui-sessions-tab mt-2 flex min-h-0 flex-1 flex-col overflow-hidden">
					<SessionSearchBar
						open={searchOpen}
						query={sessionQuery}
						matchCount={searchMatchCount}
						inputRef={searchInputRef}
						onQueryChange={setSessionQuery}
						onOpenChange={handleSearchOpenChange}
					/>
					<div className="flex items-center justify-end px-4 py-1.5">
						{archivedView && (
							<button
								type="button"
								className="rounded-md p-1 text-[var(--color-text-faint)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
								onClick={() => setArchivedView(false)}
								title={t("settings.back")}
								aria-label={t("settings.back")}
							>
								<Icon name="arrow-left-s" className="h-3.5 w-3.5" />
							</button>
						)}
					</div>
					{/* AI rename runs a model pass (seconds, up to the RPC cap). The
					 *  target row shows its own spinner; this strip stays as the
					 *  announced status (aria-live) and keeps the run visible when
					 *  that row is scrolled out of view or inside a closed group. */}
					{retitlingId !== null && (
						<div
							className="gui-group-label flex items-center gap-1.5 px-3 pb-1 pt-1 text-[var(--color-accent)]"
							role="status"
							aria-live="polite"
						>
							<Icon name="loader-4" className="h-3.5 w-3.5 flex-shrink-0 animate-spin" />
							<span className="min-w-0 truncate">
								{t("general.aiRenamingFor", { name: sessionLabelOf(retitlingId) })}
							</span>
						</div>
					)}
					<div className="gui-scroll-frame min-h-0 flex-1">
						<div
							ref={sessionListRef}
							/* Keyed by view so a groups↔projects (or archive) switch
							 * remounts the pane with the fade-in — the swap reads as a
							 * transition instead of an instant content replacement. */
							key={archivedView ? "archived" : tab}
							className="gui-sessions-list gui-tab-pane-in min-h-0 flex-1 overflow-y-auto px-1.5 pb-2"
							data-top-scroll="false"
							data-bottom-scroll="false"
							aria-busy={retitlingId !== null || undefined}
						>
							{archivedView ? (
								archived.length === 0 ? (
									<p className="px-2 py-4 text-[13px] text-[var(--color-text-faint)]">
										{t("transcript.noArchivedSessions")}
									</p>
								) : (
									archived.map(a => {
										const node = nodes.find(n => n.entry.id === a.sessionId);
										return (
											<div key={a.sessionId} className="gui-archive-row">
												<div className="min-w-0 flex-1">
													<div className="truncate text-[13px]">
														{node?.entry.label ?? t("transcript.untitledSession")}
													</div>
													<div className="flex items-center gap-1 text-[13px] text-[var(--color-text-faint)]">
														<Icon name="folder-3" className="h-3 w-3 flex-shrink-0" />
														<span className="min-w-0 flex-1 truncate" title={a.cwd || undefined}>
															{a.cwd
																? (archivedLabels.get(a.cwd) ?? pathBaseName(a.cwd))
																: t("transcript.noFolder")}
														</span>
														<span className="flex-shrink-0">
															{new Date(a.archivedAt).toLocaleString()}
														</span>
													</div>
												</div>
												<button
													type="button"
													className="gui-archive-act"
													title={t("settings.unarchive")}
													aria-label={t("settings.unarchive")}
													onClick={() => unarchiveSession(a.sessionId)}
												>
													<Icon name="restart" className="h-3.5 w-3.5" />
												</button>
												<button
													type="button"
													className="gui-archive-act gui-archive-act--danger"
													title={t("settings.delete")}
													aria-label={t("settings.delete")}
													onClick={() => void deleteArchived(a.sessionId)}
												>
													<Icon name="delete-bin" className="h-3.5 w-3.5" />
												</button>
											</div>
										);
									})
								)
							) : searchActive && searchMatchCount === 0 ? null : tab === "projects" ? (
								<>
									{/* Add-project button lives above BOTH view modes (the
									 * timeline default hid it before — the 项目 tab
									 * always offers 添加项目 / 远程连接). */}
									<div className="relative">
										<button
											type="button"
											className="gui-connect-add"
											ref={projMenuAnchorRef}
											onClick={() => setProjMenu(v => !v)}
										>
											<Icon name="add-circle" className="h-4 w-4" />
											<span>{t("settings.addProjectRemote")}</span>
										</button>
										<MenuPopup
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
													onAddProject?.();
												}}
											>
												<Icon name="folder-add" className="h-3.5 w-3.5" />
												<span>{t("settings.addProject")}</span>
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
												<span>{t("settings.remoteConnection")}</span>
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
												<span>{t("settings.importSessions")}</span>
											</button>
										</MenuPopup>
									</div>
									{projectsError && (
										<p className="gui-error mx-2" role="alert">
											{projectsError}
										</p>
									)}
									{projView === "timeline" ? (
										<>
											{pinnedNodes.length > 0 && (
												<div className="mb-1.5">
													<div className="gui-group-label px-2 pb-1 pt-2.5">{t("settings.pinned")}</div>
													<SessionList
														nodes={pinnedNodes}
														selectedId={selectedId}
														onSelect={onSelect}
														onContextMenu={openSessionCtx}
														pausedIds={pausedIds}
														workingIds={workingIds}
														statuses={statuses}
														manualTags={manualTags}
														emojis={sessionEmoji}
														onRenameSession={onRenameSession}
														searchQuery={sessionQuery}
														retitlingId={retitlingId}
													/>
												</div>
											)}
											{cronNodes.length > 0 && cronSection}
											<GroupedSessionList
												nodes={regularNodes}
												selectedId={selectedId}
												onSelect={onSelect}
												onContextMenu={openSessionCtx}
												unread={unread}
												pausedIds={pausedIds}
												workingIds={workingIds}
												statuses={statuses}
												manualTags={manualTags}
												emojis={sessionEmoji}
												onRenameSession={onRenameSession}
												searchQuery={sessionQuery}
												retitlingId={retitlingId}
											/>
										</>
									) : (
										(() => {
											// Project blocks: registry rows from `workspace.list`,
											// each a collapsible block. Sessions group by exact cwd;
											// a project without sessions still shows (empty state)
											// so a freshly picked 添加项目 appears immediately.
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
											// Issue #15: identity stays the full path; only the
											// LABEL widens when two folders share a basename
											// (`a/demo` vs `b/demo`). A managed project's own name
											// wins unless two projects share it.
											const labels = projectLabels(orderedProjects.map(project => project.root));
											const nameCounts = new Map<string, number>();
											for (const project of orderedProjects) {
												nameCounts.set(project.name, (nameCounts.get(project.name) ?? 0) + 1);
											}
											return (
												<>
													{pinnedNodes.length > 0 && (
														<div className="mb-1.5">
															<div className="gui-group-label px-2 pb-1 pt-2.5">
																{t("settings.pinned")}
															</div>
															<SessionList
																nodes={pinnedNodes}
																selectedId={selectedId}
																onSelect={onSelect}
																onContextMenu={openSessionCtx}
																pausedIds={pausedIds}
																workingIds={workingIds}
																statuses={statuses}
																manualTags={manualTags}
																emojis={sessionEmoji}
																onRenameSession={onRenameSession}
																searchQuery={sessionQuery}
																retitlingId={retitlingId}
															/>
														</div>
													)}
													{cronNodes.length > 0 && cronSection}
													{orderedProjects.map(project => {
														const path = project.root;
														const list = byCwd.get(path) ?? [];
														const isCollapsed = collapsedProjects.includes(path);
														const label =
															(nameCounts.get(project.name) ?? 0) > 1
																? (labels.get(path) ?? pathBaseName(path))
																: project.name;
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
																	setProjectOrder(() => {
																		const next = orderedProjects.map(project => project.root);
																		const fi = next.indexOf(from);
																		const ti = next.indexOf(path);
																		if (fi < 0 || ti < 0) return next;
																		const [moved] = next.splice(fi, 1);
																		next.splice(ti, 0, moved!);
																		return next;
																	});
																}}
															>
																<div
																	className={`gui-project-block${
																		projInsert?.path === path
																			? ` gui-drop-line${projInsert.edge === "after" ? " gui-drop-line--after" : ""}`
																			: ""
																	}`}
																>
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
																		onDragEnd={() => setProjInsert(null)}
																		/** Head-level insert positioning (M2.8): hovering the
																		 * head's top/bottom half shows the shared drop line and
																		 * drops insert there; the block body keeps swap-on-drop. */
																		onDragOver={e => {
																			if (!e.dataTransfer.types.includes("text/plain")) return;
																			e.preventDefault();
																			e.stopPropagation();
																			e.dataTransfer.dropEffect = "move";
																			const r = e.currentTarget.getBoundingClientRect();
																			setProjInsert({
																				path,
																				edge: e.clientY < r.top + r.height / 2 ? "before" : "after",
																			});
																		}}
																		onDragLeave={() =>
																			setProjInsert(cur => (cur?.path === path ? null : cur))
																		}
																		onDrop={e => {
																			e.preventDefault();
																			e.stopPropagation();
																			const data = e.dataTransfer.getData("text/plain");
																			const r = e.currentTarget.getBoundingClientRect();
																			const edge =
																				e.clientY < r.top + r.height / 2
																					? ("before" as const)
																					: ("after" as const);
																			setProjInsert(null);
																			if (!data.startsWith("project:")) return;
																			const from = data.slice(8);
																			if (from === path) return;
																			setProjectOrder(() => {
																				const next = orderedProjects
																					.map(project => project.root)
																					.filter(root => root !== from);
																				let ti = next.indexOf(path);
																				if (ti < 0)
																					return orderedProjects.map(project => project.root);
																				if (edge === "after") ti += 1;
																				next.splice(ti, 0, from);
																				return next;
																			});
																		}}
																		onClick={() => toggleProject(path)}
																		onContextMenu={e => {
																			// Project blocks carry the same right-click
																			// menu as group blocks (remove project lives here, not as
																			// a lone side button).
																			e.preventDefault();
																			setProjectCtx({
																				path,
																				x: e.clientX,
																				y: e.clientY,
																			});
																		}}
																	>
																		<Icon name="folder" className="h-3 w-3" />
																		<span className="min-w-0 flex-1 truncate">{label}</span>
																		{project.kind === "implicit" && (
																			<span
																				className="flex-shrink-0 text-[10px] text-[var(--color-text-faint)]"
																				title={t("settings.implicitProjectHint")}
																			>
																				{t("settings.implicitProject")}
																			</span>
																		)}
																		<span className="gui-project-count">{list.length}</span>
																		<Icon
																			name="arrow-down-s"
																			className={`gui-project-chevron${isCollapsed ? " gui-project-chevron--closed" : ""}`}
																		/>
																	</button>
																	<span className="gui-project-actions">
																		{project?.kind === "implicit" ? (
																			<button
																				type="button"
																				className="gui-project-action"
																				title={t("settings.promoteProject")}
																				aria-label={t("settings.promoteProject")}
																				disabled={!rpc}
																				onClick={e => {
																					e.stopPropagation();
																					promoteProject(path);
																				}}
																			>
																				<Icon name="folder-add" className="h-3 w-3" />
																			</button>
																		) : (
																			<button
																				type="button"
																				className="gui-project-action"
																				title={t("projectDialog.editTitle")}
																				aria-label={t("projectDialog.editTitle")}
																				disabled={!rpc}
																				onClick={e => {
																					e.stopPropagation();
																					openProjectEditor(path);
																				}}
																			>
																				<Icon name="pencil" className="h-3 w-3" />
																			</button>
																		)}
																		<button
																			type="button"
																			className="gui-project-action"
																			title={t("tools.more")}
																			aria-label={t("tools.more")}
																			aria-haspopup="menu"
																			onClick={e => {
																				e.stopPropagation();
																				const rect = e.currentTarget.getBoundingClientRect();
																				setProjectCtx({ path, x: rect.left, y: rect.bottom + 4 });
																			}}
																		>
																			<Icon name="more" className="h-3 w-3" />
																		</button>
																		<button
																			type="button"
																			className="gui-project-action gui-project-action--new"
																			title={t("settings.newSession")}
																			aria-label={t("settings.newSession")}
																			disabled={!onNewSessionInProject}
																			onClick={e => {
																				e.stopPropagation();
																				onNewSessionInProject?.(path);
																			}}
																		>
																			<Icon name="add" className="h-3 w-3" />
																		</button>
																	</span>
																</div>
																<ProjectCollapse collapsed={isCollapsed}>
																	{list.length === 0 ? (
																		<p className="gui-project-empty">{t("settings.noSessions")}</p>
																	) : (
																		<SessionList
																			nodes={list}
																			selectedId={selectedId}
																			onSelect={onSelect}
																			onContextMenu={openSessionCtx}
																			unread={unread}
																			pausedIds={pausedIds}
																			workingIds={workingIds}
																			statuses={statuses}
																			manualTags={manualTags}
																			emojis={sessionEmoji}
																			onRenameSession={onRenameSession}
																			searchQuery={sessionQuery}
																			retitlingId={retitlingId}
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
																<span className="min-w-0 flex-1 truncate">
																	{t("transcript.noFolder")}
																</span>
																<span className="text-[12px] text-[var(--color-text-faint)]">
																	{noFolder.length}
																</span>
															</div>
															<SessionList
																nodes={noFolder}
																selectedId={selectedId}
																onSelect={onSelect}
																onContextMenu={openSessionCtx}
																unread={unread}
																pausedIds={pausedIds}
																workingIds={workingIds}
																statuses={statuses}
																manualTags={manualTags}
																emojis={sessionEmoji}
																onRenameSession={onRenameSession}
																searchQuery={sessionQuery}
																retitlingId={retitlingId}
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
									{/* Pinned sessions show in the groups tab too, above custom groups. */}
									{pinnedNodes.length > 0 && (
										<div className="mb-1.5">
											<div className="gui-group-label px-2 pb-1 pt-2.5">{t("settings.pinned")}</div>
											<SessionList
												nodes={pinnedNodes}
												selectedId={selectedId}
												onSelect={onSelect}
												onContextMenu={openSessionCtx}
												pausedIds={pausedIds}
												workingIds={workingIds}
												statuses={statuses}
												manualTags={manualTags}
												emojis={sessionEmoji}
												onRenameSession={onRenameSession}
												searchQuery={sessionQuery}
												retitlingId={retitlingId}
											/>
										</div>
									)}
									{/* The groups tab lists sessions too — custom
									 * groups on top, then the time-grouped session tree. */}
									<CustomGroups
										groups={groups}
										allOverride={groupsAll}
										onOverrideClear={() => setGroupsAll(null)}
										// Pinned sessions leave their groups (mutually exclusive): the
										// pinned section above owns them while pinned.
										nodes={searchedNodes.filter(n => !pinned.includes(n.entry.id))}
										selectedId={selectedId}
										onSelect={onSelect}
										onSessionContextMenu={openSessionCtx}
										onAddGroup={() =>
											setGroups(g => [
												...g,
												{
													name: t("settings.newGroup"),
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
														: {
																...g,
																sessions: g.sessions.includes(id) ? g.sessions : [...g.sessions, id],
															},
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
										onRename={(i, name) =>
											setGroups(gs => gs.map((g, gi) => (gi === i ? { ...g, name } : g)))
										}
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
										emojis={sessionEmoji}
										onRenameSession={onRenameSession}
										searchQuery={sessionQuery}
										retitlingId={retitlingId}
									/>
									{cronNodes.length > 0 && cronSection}
									<GroupedSessionList
										nodes={regularNodes}
										selectedId={selectedId}
										onSelect={onSelect}
										onContextMenu={openSessionCtx}
										unread={unread}
										pausedIds={pausedIds}
										workingIds={workingIds}
										statuses={statuses}
										manualTags={manualTags}
										emojis={sessionEmoji}
										onRenameSession={onRenameSession}
										searchQuery={sessionQuery}
										retitlingId={retitlingId}
									/>
								</>
							)}
						</div>
						<ScrollEdgeBlur edge="top" />
						<ScrollEdgeBlur edge="end" />
					</div>
				</div>
				{gettingStarted}
				{/* User footer: instance info (connection state, latency, host
				 * switcher) on the left; settings/session actions on the right.
				 * `showFooter` lets a host move these entries into a permanent
				 * rail instead of losing them when this panel folds. */}
				{showFooter && (
					<div className="gui-sidebar-footer flex items-center justify-between gap-1.5 border-t border-[var(--border)] px-3 py-2">
						<InstanceButton
							rpc={rpc ?? null}
							connected={connected}
							daemonUrl={daemonUrl}
							hosts={hosts}
							onSwitchHost={onSwitchHost}
							onAddHost={onAddHost}
							onRemoveHost={onRemoveHost}
							onOpenSettings={onOpenSettings}
							onReconnect={onReconnect}
							onDisconnect={onDisconnect}
							onOpenWorkspace={onOpenWorkspace}
							onOpenManager={onOpenInstanceManager}
							onOpenDisclaimer={onOpenRemoteDisclaimer}
						/>
						<div className="flex items-center gap-1.5">
							<button
								type="button"
								className="rounded-md p-1 text-[var(--color-text-faint)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
								onClick={onOpenShortcuts}
								title={t("general.keyboardShortcuts")}
								aria-label={t("general.keyboardShortcuts")}
							>
								<Icon name="command" className="h-4 w-4" />
							</button>{" "}
							<button
								type="button"
								className="rounded-md p-1 text-[var(--color-text-faint)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
								onClick={onOpenSettings}
								title={t("settings.settings")}
								aria-label={t("settings.settings")}
							>
								<Icon name="settings-3" className="h-4 w-4" />
							</button>
							<button
								type="button"
								className="rounded-md p-1 text-[var(--color-text-faint)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
								onClick={onOpenCollab}
								title={t("settings.mobileRemoteControl")}
								aria-label={t("settings.mobileRemoteControl")}
							>
								<Icon name="smartphone" className="h-4 w-4" />
							</button>
						</div>
					</div>
				)}
			</div>
			{/* Session right-click menu: archive, copy id. */}
			<ContextMenu
				open={sessionCtx !== null}
				x={sessionCtx?.x ?? 0}
				y={sessionCtx?.y ?? 0}
				onClose={() => setSessionCtx(null)}
				items={
					sessionCtx
						? [
								{
									label: pinned.includes(sessionCtx.id) ? t("settings.unpinTask") : t("settings.pinTask"),
									icon: "pushpin",
									onSelect: () =>
										persistPinned(
											pinned.includes(sessionCtx.id)
												? pinned.filter(x => x !== sessionCtx.id)
												: [sessionCtx.id, ...pinned],
										),
								},
								{
									label: t("settings.setSessionEmoji"),
									icon: "emotion-happy",
									onSelect: () => {
										setEmojiDraft(sessionEmoji.get(sessionCtx.id) ?? "");
										setEmojiTarget(sessionCtx.id);
										setSessionCtx(null);
									},
								},
								{
									label: t("general.reloadSession"),
									icon: "refresh",
									disabled: !onReloadSession,
									onSelect: () => onReloadSession?.(sessionCtx.id),
								},
								{
									label: t("settings.renameTask"),
									icon: "pencil",
									onSelect: () => void renameSession(sessionCtx.id),
								},
								// AI rename (daemon session.retitle: title from the first
								// user message, same pipeline as auto-title). Gated on the
								// prop so hosts without it keep the old menu shape. The row
								// carries the busy state until the call settles, so cleanup
								// lives in `finally` — a host callback that throws
								// synchronously must not wedge `retitlingId`.
								...(onRetitleSession
									? [
											{
												label:
													retitlingId === sessionCtx.id ? t("general.aiRenaming") : t("general.aiRename"),
												icon: "ai-generate-2",
												disabled: retitlingId !== null,
												onSelect: () => {
													const id = sessionCtx.id;
													const run = onRetitleSession;
													setRetitlingId(id);
													void (async () => {
														try {
															const result = await run(id);
															if (!result.ok)
																pushActionToast({
																	kind: "error",
																	message: retitleFailureMessage(result.reason),
																});
														} catch {
															pushActionToast({
																kind: "error",
																message: retitleFailureMessage("failed"),
															});
														} finally {
															setRetitlingId(current => (current === id ? null : current));
														}
													})();
												},
											},
										]
									: []),
								{
									// Right-click: any session row (parent or
									// subagent) can be popped out into the mini chat
									// window; non-Electron hosts fall back to opening
									// it in place (handled by the app callback).
									label: t("general.openMiniChat"),
									icon: "chat-1",
									onSelect: () => onOpenMiniChat?.(sessionCtx.id),
								},
								{
									label: t("settings.archiveTask"),
									icon: "archive",
									// cwd rides along so the archive row can show the folder.
									// Archiving is a local list edit, so the undo is a
									// synchronous reverse — no confirm dialog, no RPC.
									onSelect: () => {
										archiveSession(sessionCtx.id, sessionMeta.get(sessionCtx.id)?.cwd);
										pushActionToast({
											kind: "success",
											message: t("general.sessionArchived"),
											dedupeKey: `session:archive:${sessionCtx.id}`,
											actionLabel: t("general.undo"),
											onAction: () => unarchiveSession(sessionCtx.id),
										});
									},
								},
								{
									label: unread?.has(sessionCtx.id) ? t("settings.markRead") : t("settings.markUnread"),
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
										{ tag: "complete", dot: "ok", label: t("settings.tagComplete") },
										{
											tag: "interrupted",
											dot: "warning",
											label: t("settings.tagInterrupted"),
										},
										{ tag: "error", dot: "danger", label: t("settings.tagError") },
										{ tag: "aborted", dot: "muted", label: t("settings.tagAborted") },
										{ tag: "pending", dot: "accent", label: t("settings.tagPending") },
									] as const
								).map(({ tag, dot, label }) => ({
									label: `#${label}`,
									icon: "circle" as const,
									color: dot,
									onSelect: () => setSessionTag(sessionCtx.id, tag),
								})),
								{
									label: t("settings.clearTag"),
									icon: "palette",
									disabled: !manualTags.has(sessionCtx.id),
									onSelect: () => setSessionTag(sessionCtx.id, null),
								},
								{ divider: true },
								{
									label: t("settings.copyPath"),
									icon: "folder",
									disabled: !sessionMeta.get(sessionCtx.id)?.cwd,
									onSelect: () => {
										const cwd = sessionMeta.get(sessionCtx.id)?.cwd;
										if (cwd) void navigator.clipboard?.writeText(cwd).catch(() => {});
									},
								},
								// 文件面板根目录：一个会话可挂多个工作目录，文件面板
								// 一次只浏览一个；这里选择的是「下次打开文件面板时用哪
								// 个根」，选择按 session id 隔离，切会话不会串。
								...(() => {
									if (!sessionDirs || !rpc) return [];
									const roots = sessionDirs.map(directory => directory.path);
									const cwd = sessionMeta.get(sessionCtx.id)?.cwd ?? roots[0] ?? "";
									if (!cwd) return [];
									const selected = resolveWorkspaceRoot(
										cwd,
										roots,
										fileRootSelection.get(rootSelectionKey(sessionCtx.id, cwd)),
									);
									return [
										{ divider: true },
										...(roots.length > 1
											? roots.map(path => ({
													label: pathBaseName(path),
													description: directoriesEqual(path, cwd) ? t("settings.primaryDirectory") : path,
													icon: directoriesEqual(path, selected) ? "check" : "folder",
													onSelect: () => {
														fileRootSelection.set(rootSelectionKey(sessionCtx.id, cwd), path);
														pushActionToast({
															kind: "success",
															message: t("general.fileRootSelected", { path }),
														});
													},
												}))
											: []),
										{
											label: t("settings.addWorkingDirectory"),
											icon: "folder-add",
											onSelect: () => void addWorkingDirectory(sessionCtx.id),
										},
										...(isRemoteMirrorCwd(cwd)
											? []
											: [
													{
														label: t("settings.addWorkingDirectoryRemember"),
														description: t("settings.addWorkingDirectoryRememberHint"),
														icon: "folder-add" as const,
														onSelect: () => void addWorkingDirectory(sessionCtx.id, true),
													},
												]),
										...sessionDirs
											.filter(directory => !directory.primary)
											.map(directory => ({
												label: `${t("settings.removeDirectory")}: ${pathBaseName(directory.path)}`,
												description: directory.path,
												icon: "delete-bin",
												danger: true,
												onSelect: () => void removeWorkingDirectory(sessionCtx.id, directory.path),
											})),
									];
								})(),
								{
									label: t("transcript.copySessionId"),
									icon: "clipboard",
									onSelect: () => {
										void navigator.clipboard?.writeText(sessionCtx.id).catch(() => {});
									},
								},
								{ divider: true },
								{
									label: openFolderLabel(),
									icon: "folder-open",
									disabled: !sessionMeta.get(sessionCtx.id)?.cwd,
									onSelect: () => openInFinder(sessionCtx.id),
								},
								// Export transcript (read-only session.snapshot RPC,
								// same Markdown builder as the top-bar menu). Gated on
								// the prop like delete.
								...(onExportSession
									? [
											{
												label: t("general.exportMarkdown"),
												icon: "download",
												onSelect: () => {
													const id = sessionCtx.id;
													void onExportSession(id, sessionLabelOf(id)).then(ok => {
														if (!ok)
															pushActionToast({ kind: "error", message: t("general.exportFailed") });
													});
												},
											},
										]
									: []),
								// Permanent delete (daemon session.delete + centralized
								// confirm in app.deleteSession, same as the top-bar menu).
								// Gated on the prop so hosts without deletion keep the
								// old menu shape.
								...(onDeleteSession
									? [
											{ divider: true },
											{
												label: t("general.deleteSession"),
												icon: "delete-bin",
												danger: true,
												onSelect: () => {
													void onDeleteSession(sessionCtx.id);
												},
											},
										]
									: []),
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
									label: t("transcript.renameGroup"),
									icon: "pencil",
									onSelect: () => renameGroup(groupCtx.index),
								},
								{ divider: true },
								...GROUP_COLORS.map(color => ({
									label: t("settings.groupColorWithColor", { color: color }),
									icon: "circle" as const,
									onSelect: () =>
										setGroups(gs => gs.map((g, i) => (i === groupCtx.index ? { ...g, color } : g))),
									color,
								})),
								{ divider: true },
								{
									label: t("transcript.deleteGroup"),
									icon: "delete-bin",
									danger: true,
									onSelect: () => setGroups(gs => gs.filter((_, i) => i !== groupCtx.index)),
								},
							]
						: []
				}
			/>
			{/* Project block right-click menu: same frosted-glass ContextMenu
			 * component as the group menu — open folder, copy path, rename,
			 * working directories, remove project. An implicit row (session
			 * history backfill) is read-only until it is promoted to managed. */}
			<ContextMenu
				open={projectCtx !== null}
				x={projectCtx?.x ?? 0}
				y={projectCtx?.y ?? 0}
				onClose={() => setProjectCtx(null)}
				items={(() => {
					if (!projectCtx) return [];
					const project = projectOf(projectCtx.path);
					const reveal = {
						label: openFolderLabel(),
						icon: "folder-open",
						onSelect: () => openFolder(projectCtx.path),
					};
					const copyPath = {
						label: t("settings.copyPath"),
						icon: "clipboard",
						onSelect: () => {
							void navigator.clipboard?.writeText(projectCtx.path).catch(() => {});
						},
					};
					if (!project || project.kind === "implicit") {
						return [
							reveal,
							copyPath,
							{ divider: true },
							{
								label: t("settings.promoteProject"),
								description: t("settings.promoteProjectHint"),
								icon: "folder-add",
								disabled: !rpc,
								onSelect: () => promoteProject(projectCtx.path),
							},
						];
					}
					return [
						reveal,
						copyPath,
						{ divider: true },
						{
							label: t("projectDialog.editTitle"),
							description: t("settings.manageDirectoriesHint"),
							icon: "pencil",
							disabled: !rpc,
							onSelect: () => {
								setProjectCtx(null);
								openProjectEditor(projectCtx.path);
							},
						},
						{ divider: true },
						{
							label: t("general.removeProject"),
							icon: "delete-bin",
							danger: true,
							disabled: !rpc,
							onSelect: () => removeProject(projectCtx.path),
						},
					];
				})()}
			/>
			{/* Session emoji: a compact palette plus a free-text field so a
			 * custom glyph is still possible. Stored locally like tags/pins. */}
			<DialogFrame
				open={emojiTarget !== null}
				onClose={() => setEmojiTarget(null)}
				label={t("settings.sessionEmoji")}
				className="gui-emoji-dialog"
			>
				<div className="flex flex-col gap-3">
					<div className="gui-new-project-field">
						<div className="gui-new-project-label">{t("settings.sessionEmoji")}</div>
						<input
							className="gui-input w-full"
							value={emojiDraft}
							maxLength={16}
							autoFocus
							placeholder="😀"
							onChange={event => setEmojiDraft(event.target.value)}
							onKeyDown={event => {
								if (event.key === "Enter" && emojiTarget) {
									setSessionEmoji(emojiTarget, emojiDraft);
									setEmojiTarget(null);
								}
							}}
						/>
						<p className="m-0 text-[11px] text-[var(--color-text-faint)]">{t("settings.sessionEmojiHint")}</p>
					</div>
					<div className="gui-emoji-grid">
						{SESSION_EMOJI_PALETTE.map(emoji => (
							<button
								key={emoji}
								type="button"
								className={`gui-emoji-chip${emojiDraft === emoji ? " gui-emoji-chip--active" : ""}`}
								onClick={() => setEmojiDraft(emoji)}
							>
								{emoji}
							</button>
						))}
					</div>
					<div className="flex items-center justify-between gap-2">
						<button
							type="button"
							className="gui-btn"
							onClick={() => {
								if (emojiTarget) setSessionEmoji(emojiTarget, null);
								setEmojiTarget(null);
							}}
						>
							{t("settings.clearEmoji")}
						</button>
						<div className="flex items-center gap-2">
							<button type="button" className="gui-btn" onClick={() => setEmojiTarget(null)}>
								{t("settings.cancel")}
							</button>
							<button
								type="button"
								className="gui-btn gui-btn-primary"
								onClick={() => {
									if (emojiTarget) setSessionEmoji(emojiTarget, emojiDraft);
									setEmojiTarget(null);
								}}
							>
								{t("general.save")}
							</button>
						</div>
					</div>
				</div>
			</DialogFrame>
			{/* One project modal for name + source folders. Create and edit share
			 * the same body so the sidebar, project header and file pane cannot
			 * drift into separate editing surfaces. */}
			<ProjectDialog
				open={projectDialog !== null}
				mode={projectDialog?.mode ?? "edit"}
				target={projectDialog?.target ?? null}
				rpc={rpc ?? null}
				onClose={() => setProjectDialog(null)}
				onSaved={applyProjectResult}
			/>
			{/* Session hover card — one instance for the whole sidebar; rows
			 *  report through the module bus (SessionHoverCard.tsx), the card
			 *  portals to document.body so the sidebar's glass/transform
			 *  ancestors can't hijack its fixed positioning. */}
			<SessionHoverCard meta={sessionMeta} modeCatalog={modeCatalog} />
		</aside>
	);
}
