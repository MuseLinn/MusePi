import { t, unarchiveSession, archiveSession as writeArchivedSession } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { pushActionToast } from "../lib/action-toast";
import {
	copyToClipboard,
	listOpenInApps,
	type OpenInApp,
	openExternalUrl,
	openMiniChat,
	openWith,
	projectName,
	shellPlatform,
} from "../lib/electron";
import { orbFromSession } from "../lib/pet";
import {
	type ProjectAction,
	readProjectActions,
	resolveProjectActionIcon,
	writeProjectActions,
} from "../lib/project-actions";
import { usePrompt } from "../lib/prompt-dialog";
import type { RpcClient } from "../lib/rpc";
import { buildSessionMarkdown, markdownFileName } from "../lib/session-markdown";
import type { GuiSessionStore } from "../lib/session-store";
import { useStore } from "../lib/use-store";
import { Icon } from "../vendor/oc-icons";
import { type SessionTabRow, SessionTabsStrip } from "./SessionTabsStrip";
import { StateIcon } from "./StateIcon";

/** Known open-in app ids → built-in oc-icon fallback (shown when the
 *  shell couldn't extract a real icon, e.g. WindowsApps aliases like
 *  wt.exe whose icon the shell won't resolve). */
const OPENIN_FALLBACK_ICON: Record<string, string> = {
	explorer: "folder",
	nautilus: "folder",
	dolphin: "folder",
	terminal: "terminal",
	"gnome-terminal": "terminal",
	konsole: "terminal",
	notepad: "file-text",
	vscode: "code",
	cursor: "code",
	zed: "code",
	intellij: "code",
	pycharm: "code",
	goland: "code",
	rider: "code",
	clion: "code",
	sublime: "code",
	kate: "code",
	bbedit: "code",
	gedit: "code",
	ghostty: "terminal",
	iterm: "terminal",
	warp: "terminal",
};

/** Localized open-in app label (fallback to the shell-provided English
 *  name when the key is missing — e.g. custom app ids). */
function openInLabel(app: { id: string; label: string }): string {
	const key = `open in ${app.id}` as unknown as Parameters<typeof t>[0];
	return t(key) === key ? app.label : t(key);
}

import { AgentAvatar } from "./AgentAvatar";
import { MenuPopup } from "./MenuPopup";
import { ProjectActionsDialog } from "./ProjectActionsDialog";

/** "mm:ss" hold time for the paused-state hint (matches the composer's
 *  pause banner formatting). */
function formatPauseElapsed(pausedAt: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - pausedAt) / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Window header — the container layer between the session sidebar and the
 * chat surface.
 * Full-width drag region; floating sidebar controls on the left (sidebar
 * toggle + project-actions capsule), the session title as a switcher
 * trigger in the middle, and the
 * top-right cluster (mini chat, open-in, more) on the right; the terminal
 * toggle lives in the right rail and instance info in the sidebar footer.
 * No divider line in the welcome state.
 */

export function GuiHeader({
	store,
	rpc,
	sideCollapsed,
	onToggleSidebar,
	paused,
	pausedAt,
	onTogglePause,
	pauseDisabled,
	globalPaused,
	onToggleGlobalPause,
	onNewSession,
	onOpenSettings,
	terminalOpen,
	onToggleTerminal,
	project,
	onOpenFolder,
	sessions,
	onSelectSession,
	onRenameSession,
	sessionLabel,
	remote,
	onOpenCollab,
	onDeleteSession,
	tabs,
	previewTabId,
	onSelectTab,
	onKeepOpenTab,
	onCloseTab,
	onCloseOtherTabs,
	onArchiveTab,
	onExportSession,
	onOpenMiniChat,
	onReorderTabs,
}: {
	store: GuiSessionStore | null;
	rpc: RpcClient;
	/** Sidebar collapsed: pad the header left so the title clears the
	 * traffic lights (window-anchored, like TitlebarLeftControls). */
	sideCollapsed: boolean;
	onToggleSidebar(): void;
	/** Per-session agent freeze (TUI `/pause` parity): engaged state + epoch
	 *  ms when the freeze began (drives the live hold timer). */
	paused?: boolean;
	pausedAt?: number | null;
	onTogglePause?(): void;
	/** No session open (welcome scene): nothing to freeze — button disabled. */
	pauseDisabled?: boolean;
	/** Process-global freeze (daemon-wide, fullscreen overlay): engaged state. */
	globalPaused?: boolean;
	onToggleGlobalPause?(): void;
	onNewSession(): void;
	onOpenSettings(): void;
	terminalOpen: boolean;
	onToggleTerminal(): void;
	project: string | null;
	onOpenFolder(): void;
	/** Recent sessions for the header switcher, newest first. */
	sessions: { id: string; label: string; timestamp: number }[];
	onSelectSession(id: string): void;
	/** Persist a user-set session title (daemon session.rename). */
	onRenameSession(sessionId: string, title: string): void;
	/** Tree label of the active session — reflects renames. */
	sessionLabel?: string | null;
	/** Session cwd lives under the sshfs remote mount dir — show the
	 *  remote-workspace chip next to the title. */
	remote?: boolean;
	/** Open the collab remote-control dialog (session 分享). */
	onOpenCollab(): void;
	/** Permanently delete a session (journal + index); the caller also
	 *  resets the UI when it was the active session. Returns success. */
	onDeleteSession(sessionId: string): Promise<boolean>;
	/** Header tab strip rows (multi-session tabs); empty/undefined renders the
	 *  single-session title only. Closing a tab never deletes the session. */
	tabs?: SessionTabRow[];
	previewTabId?: string | null;
	onSelectTab?(id: string): void;
	onKeepOpenTab?(id: string): void;
	onCloseTab?(id: string): void;
	/** Close every tab except this one and activate it. */
	onCloseOtherTabs?(id: string): void;
	/** Archive the tab's session (local archive list + undo toast). */
	onArchiveTab?(id: string): void;
	onExportSession?(sessionId: string, title: string): Promise<boolean>;
	onOpenMiniChat?(sessionId: string): void;
	onReorderTabs?(activeId: string, overId: string): void;
}): ReactNode {
	const noopSubscribe = (): (() => void) => () => {};
	const snap = useStore(
		store ? store.subscribe.bind(store) : noopSubscribe,
		store ? store.getSnapshot.bind(store) : () => null,
	);
	const orb = orbFromSession(snap);
	const statusText = snap?.working
		? snap.streaming
			? t("settings.replying")
			: t("settings.working")
		: t("settings.idle");
	// Traffic lights are macOS-only. Windows/Linux get a native
	// titleBarOverlay (top-right ~138px) so the right cluster needs
	// clearance; macOS keeps the 172px left clearance for the
	// red/yellow/green buttons; other platforms (web) reclaim both.
	const isWin = shellPlatform() === "win32";
	const isLinux = shellPlatform() === "linux";
	const hasOverlay = isWin || isLinux;
	const [ceiling, setCeiling] = useState<string | null>(null);
	const projectLabel = snap?.state?.cwd
		? projectName(snap.state.cwd)
		: store
			? t("settings.session2")
			: t("general.local");
	// Trigger refs for the portaled popups (global z-order above the chat
	// surface — the header itself is z-1 and would trap in-flow menus).
	const projBtnRef = useRef<HTMLButtonElement | null>(null);
	const switcherBtnRef = useRef<HTMLButtonElement | null>(null);
	const titleMenuBtnRef = useRef<HTMLButtonElement | null>(null);
	const openInBtnRef = useRef<HTMLButtonElement | null>(null);
	// §5t titlebar avoidance: the fixed float cluster publishes its measured
	// width as --gui-float-controls-width; the collapsed-sidebar spacer carves
	// exactly that much.
	const floatRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const el = floatRef.current;
		if (!el) return;
		const publish = () => {
			document.documentElement.style.setProperty("--gui-float-controls-width", `${el.offsetWidth}px`);
		};
		publish();
		const ro = new ResizeObserver(publish);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const [openInOpen, setOpenInOpen] = useState(false);
	const [projOpen, setProjOpen] = useState(false);
	const [switcherOpen, setSwitcherOpen] = useState(false);
	const [titleMenuOpen, setTitleMenuOpen] = useState(false);
	const openInDir = store?.cwd ?? project ?? "";
	const [devRunning, setDevRunning] = useState(false);
	const [devStopping, setDevStopping] = useState(false);
	// First http(s) URL seen in terminal output while the dev server runs
	// (with a preview button).
	const [devPreviewUrl, setDevPreviewUrl] = useState<string | null>(null);
	const [noDevFlash, setNoDevFlash] = useState(false);
	const noDevTimer = useRef<number | null>(null);

	// Open-in app list: real app icons
	// from the Electron shell, persisted selection like openInAppsStore.
	const [openInApps, setOpenInApps] = useState<OpenInApp[]>([]);
	const [openInScanning, setOpenInScanning] = useState(false);
	const [openInAppId, setOpenInAppId] = useState<string | null>(() => {
		try {
			return localStorage.getItem("musepi-gui-openin-app");
		} catch {
			return null;
		}
	});
	const loadOpenInApps = useCallback((): void => {
		setOpenInScanning(true);
		void listOpenInApps()
			.then(apps => {
				setOpenInApps(apps);
				setOpenInScanning(false);
			})
			.catch(() => setOpenInScanning(false));
	}, []);
	useEffect(() => {
		loadOpenInApps();
	}, [loadOpenInApps]);
	const selectedOpenInApp = openInApps.find(a => a.id === openInAppId) ?? openInApps[0] ?? null;
	const selectOpenInApp = (app: OpenInApp): void => {
		setOpenInAppId(app.id);
		setOpenInOpen(false);
		try {
			localStorage.setItem("musepi-gui-openin-app", app.id);
		} catch {
			// storage unavailable
		}
		if (openInDir) void openWith(app.appName, openInDir);
	};

	// Dev-server auto-discovery: look
	// for a dev/start/preview/serve/develop script and the package manager
	// from lockfiles, so the header button runs the right command.
	const DEV_SCRIPT_RE = /^(dev|start|preview|serve|develop)(:.*)?$/i;
	const [devCommand, setDevCommand] = useState<string | null>(null);
	// Manual re-detection (clicking auto-discover with no script yet).
	const [detectNonce, setDetectNonce] = useState(0);
	useEffect(() => {
		// detectNonce is only ever a re-run trigger (the detection itself is
		// stateless): the explicit read keeps the dependency meaningful.
		void detectNonce;
		const dir = store?.cwd ?? project;
		if (!dir || !rpc) {
			setDevCommand(null);
			return;
		}
		let cancelled = false;
		void rpc
			.request<{ content: string | null }>("fs.read", {
				path: `${dir}/package.json`,
			})
			.then(async res => {
				if (cancelled) return;
				try {
					const pkg = res?.content ? (JSON.parse(res.content) as { scripts?: Record<string, string> }) : null;
					const scripts = pkg?.scripts ?? {};
					const script = Object.keys(scripts).find(k => DEV_SCRIPT_RE.test(k));
					if (!script) {
						setDevCommand(null);
						return;
					}
					// Package manager from lockfiles.
					const locks: [string, string, string][] = [
						["pnpm-lock.yaml", "pnpm", "pnpm"],
						["yarn.lock", "yarn", "yarn"],
						["bun.lock", "bun", "bun run --shell=bun"],
						["bun.lockb", "bun", "bun run --shell=bun"],
						["package-lock.json", "npm", "npm run"],
					];
					let pm = "npm run";
					for (const [lock, , cmd] of locks) {
						const has = await rpc
							.request<{ content: string | null }>("fs.read", {
								path: `${dir}/${lock}`,
							})
							.then(r => r?.content !== null)
							.catch(() => false);
						if (has) {
							pm = cmd;
							break;
						}
					}
					setDevCommand(`${pm} ${script}`);
				} catch {
					setDevCommand(null);
				}
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [rpc, store, project, detectNonce]);
	const runDevServer = useCallback((): void => {
		if (!devCommand) {
			// Auto-discover with no script yet: re-scan (the user may have
			// just created package.json) and flash a hint when there is none.
			setDetectNonce(n => n + 1);
			if (noDevTimer.current) window.clearTimeout(noDevTimer.current);
			setNoDevFlash(true);
			noDevTimer.current = window.setTimeout(() => setNoDevFlash(false), 1800);
			return;
		}
		if (devRunning || devStopping) {
			// Stop: brief loader, then Ctrl+C into the active dock tab
			// (spinner while it runs).
			if (devStopping) return;
			setDevStopping(true);
			setTimeout(() => {
				window.dispatchEvent(new Event("musepi-gui-terminal-stop"));
				setDevRunning(false);
				setDevStopping(false);
				setDevPreviewUrl(null);
			}, 400);
			return;
		}
		if (!terminalOpen) onToggleTerminal();
		setTimeout(() => {
			window.dispatchEvent(new CustomEvent("musepi-gui-terminal-cmd", { detail: devCommand }));
		}, 900);
		setDevRunning(true);
		setDevPreviewUrl(null);
	}, [devCommand, devRunning, devStopping, terminalOpen, onToggleTerminal]);

	// While the dev server runs, watch the dock terminal output for the
	// first http(s) URL:
	// auto-open it once and keep it available on the preview button.
	const urlOpenedRef = useRef(false);
	useEffect(() => {
		if (!devRunning) {
			urlOpenedRef.current = false;
			return;
		}
		urlOpenedRef.current = false;
		const URL_RE = /https?:\/\/[^\s<>"'`)\]}]+/g;
		const onEvent = (event: { kind: string; payload?: unknown }): void => {
			if (event.kind !== "terminal-output") return;
			const data = (event.payload as { data?: string } | null)?.data;
			if (!data) return;
			const match = data.match(URL_RE);
			if (!match) return;
			const url = match[0]!;
			setDevPreviewUrl(url);
			if (!urlOpenedRef.current) {
				urlOpenedRef.current = true;
				void openExternalUrl(url);
			}
		};
		return rpc.addEventListener(onEvent);
	}, [devRunning, rpc]);

	// Per-project custom actions:
	// listed above the auto-discover entry in the project-actions menu and
	// executed in the bottom terminal dock through the same
	// musepi-gui-terminal-cmd broadcast the dev server uses. Persisted in
	// localStorage keyed by cwd (terminal-tabs precedent).
	const actionDir = store?.cwd ?? project ?? "";
	const [projectActions, setProjectActions] = useState<ProjectAction[]>([]);
	const [actionsEditorOpen, setActionsEditorOpen] = useState(false);
	useEffect(() => {
		setProjectActions(actionDir ? readProjectActions(actionDir) : []);
	}, [actionDir]);
	const persistProjectActions = (next: ProjectAction[]): void => {
		setProjectActions(next);
		if (actionDir) writeProjectActions(actionDir, next);
	};
	const runProjectAction = (action: ProjectAction): void => {
		// Same execution path as the dev server: open the dock, then type
		// the command into the active tab once the pty is up.
		if (!terminalOpen) onToggleTerminal();
		setTimeout(() => {
			window.dispatchEvent(new CustomEvent("musepi-gui-terminal-cmd", { detail: action.command }));
		}, 900);
	};
	useEffect(() => {
		if (!store) return;
		let cancelled = false;
		void rpc
			.request<{ ceiling?: string }>("session.thinkingInfo", {
				sessionId: store.sessionId,
			})
			.then(info => {
				if (!cancelled) setCeiling(info.ceiling ?? null);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [rpc, store]);

	// ── Header chips (§3.1 A2): context-window usage + git branch ──────
	// Read-only summaries of existing daemon RPCs. The ctx chip shares
	// the Composer's value-compare discipline so a poll tick that changed
	// nothing costs no re-render.
	const [ctxChip, setCtxChip] = useState<{
		tokens: number;
		contextWindow: number;
		percent: number;
	} | null>(null);
	useEffect(() => {
		if (!store) return;
		let cancelled = false;
		const load = (): void => {
			void rpc
				.request<{
					tokens: number;
					contextWindow: number;
					percent: number;
				} | null>("session.contextUsage", {
					sessionId: store.sessionId,
				})
				.then(usage => {
					if (cancelled || !usage) return;
					setCtxChip(prev =>
						prev &&
						prev.tokens === usage.tokens &&
						prev.percent === usage.percent &&
						prev.contextWindow === usage.contextWindow
							? prev
							: usage,
					);
				})
				.catch(() => {});
		};
		load();
		// Poll only while the agent works (Composer parity): idle sessions
		// don't move, and a quiet header shouldn't spam the daemon.
		if (!snap?.working) return;
		const id = window.setInterval(load, 5000);
		return () => {
			cancelled = true;
			window.clearInterval(id);
		};
	}, [rpc, store, snap?.working]);

	// Git branch chip: read-only display (branch switching lives in the
	// transcript StatusCards); 15s cadence matches the RightRail counters.
	const [gitBranch, setGitBranch] = useState<string | null>(null);
	useEffect(() => {
		const cwd = store?.cwd ?? null;
		setGitBranch(null);
		if (!cwd) return;
		let cancelled = false;
		const load = (): void => {
			void rpc
				.request<{ branch?: string | null; error?: string }>("git.status", {
					cwd,
				})
				.then(res => {
					if (cancelled) return;
					setGitBranch(res && !res.error ? (res.branch ?? null) : null);
				})
				.catch(() => {});
		};
		load();
		const id = window.setInterval(load, 15_000);
		return () => {
			cancelled = true;
			window.clearInterval(id);
		};
	}, [rpc, store?.cwd]);

	const sessionTitle = ((): string => {
		if (!store) return t("settings.musepi");
		const first = snap?.entries.find(
			e => e.type === "message" && (e as { message?: { role?: string } }).message?.role === "user",
		);
		if (first) {
			// OMP wire content may be a string or a block array (text/toolCall).
			const content = (first as { message?: { content?: unknown } }).message?.content;
			const text =
				typeof content === "string"
					? content.trim()
					: Array.isArray(content)
						? content
								.map(b => (b as { text?: string }).text ?? "")
								.join(" ")
								.trim()
						: "";
			if (text) return text.slice(0, 40);
		}
		return snap?.state?.cwd?.split("/").pop() ?? t("settings.session2");
	})();
	// A renamed title comes from the session tree, not the message stream.
	const title = sessionLabel?.trim() ? sessionLabel : sessionTitle;

	const { prompt } = usePrompt();
	const renameSessionById = (sessionId: string, current: string): void => {
		void prompt({ title: t("settings.renameSession"), defaultValue: current }).then(next => {
			if (!next || next === current) return;
			onRenameSession(sessionId, next);
		});
	};
	const renameActiveSession = (): void => {
		if (store) renameSessionById(store.sessionId, title);
	};

	/** Export the active session transcript as a downloadable Markdown file
	 *  (client-side from the store). */
	const exportSessionMarkdown = (): void => {
		if (!store) return;
		const snap = store.getSnapshot();
		// Selection rule (advisor cards, hook notices, collab/skill prompts, and
		// the model-facing-XML trap) lives in lib/session-markdown.ts.
		const markdown = buildSessionMarkdown(title, snap.entries, {
			user: t("general.user"),
			assistant: t("general.assistant"),
			advisor: t("general.advisor"),
		});
		const blob = new Blob([markdown], { type: "text/markdown" });
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = `${markdownFileName(title)}.md`;
		a.click();
		URL.revokeObjectURL(a.href);
	};

	/** Archive the active session:
	 *  the shared session-archive store the sidebar reads, so the sidebar and
	 *  the guest/mobile shell follow without a reload (2026-09-15: this used to
	 *  write `musepi-gui-archived` directly while the guest shell wrote its own
	 *  key, leaving the two clients with unrelated archives). */
	const archiveActiveSession = (): void => {
		if (!store) return;
		const archivedId = store.sessionId;
		writeArchivedSession(archivedId, store.cwd ?? undefined);
		// Archiving immediately leaves the session — the least recoverable-
		// feeling path in the app, since the row vanishes from under the
		// cursor and the conversation switches. Every archive offers an undo;
		// the archive is a local list edit, so the reverse is free (no daemon
		// round trip, no confirm dialog).
		pushActionToast({
			kind: "success",
			message: t("general.sessionArchived"),
			actionLabel: t("general.undo"),
			onAction: () => unarchiveSession(archivedId),
		});
		onNewSession();
	};

	/** Delete the active session — the confirm dialog lives in deleteSession
	 *  (settings 会话 toggle musepi-gui-confirm-delete), so the header must not
	 *  double-prompt. */
	const deleteActiveSession = (): void => {
		if (!store) return;
		void onDeleteSession(store.sessionId);
	};

	const toast = (text: string, kind?: "info" | "success" | "error"): void => {
		window.dispatchEvent(new CustomEvent("musepi-gui-toast", { detail: { message: text, kind } }));
	};

	/** Move this session into a fresh isolated git worktree . Two existing pieces do the work: the
	 *  `worktree.create` RPC builds the tree under `~/.musepi/wt`
	 *  (`worktree.base` aware), and the `/move` slash command re-roots the live
	 *  session — `SessionManager.moveSession` plus its settings/plugin reloads,
	 *  so nothing about the cwd change is re-implemented here.
	 *
	 *  A killed/streaming session cannot move: `/move` refuses while streaming
	 *  and the handler reports it, which the toast surfaces. */
	const moveToNewWorktree = async (sessionId = store?.sessionId, cwd = store?.cwd): Promise<void> => {
		if (!rpc || !sessionId || !cwd) return;
		const suggested = `musepi/session-${Date.now().toString(36)}`;
		const branch = await prompt({
			title: t("general.moveNewWorktree"),
			defaultValue: suggested,
			placeholder: t("general.branchName"),
		});
		if (!branch) return;
		const created = await rpc
			.request<{ path?: string; error?: string }>("worktree.create", {
				cwd,
				branch,
			})
			.catch((err: unknown): { path?: string; error?: string } => ({
				error: err instanceof Error ? err.message : String(err),
			}));
		if (!created?.path) {
			toast(created?.error || t("general.worktreeFailed"));
			return;
		}
		const moved = await rpc
			.request<{ consumed?: boolean; reason?: string }>("session.slashCommand", {
				sessionId,
				text: `/move ${created.path}`,
			})
			.catch(() => null);
		if (!moved?.consumed) {
			toast(t("general.worktreeFailed"));
			return;
		}
		toast(t("general.movedWorktree"), "success");
	};

	// Outside click / Escape closes every open header popup (base-ui
	// DropdownMenu semantics). Clicking a trigger closes the OTHER menus and
	// lets its own onClick toggle (single-open); clicks inside a popup are
	// left to the item handlers.
	const anyMenuOpen = projOpen || switcherOpen || titleMenuOpen || openInOpen;
	useEffect(() => {
		if (!anyMenuOpen) return;
		const closeAll = (except?: string): void => {
			if (except !== "proj") setProjOpen(false);
			if (except !== "switcher") setSwitcherOpen(false);
			if (except !== "titleMenu") setTitleMenuOpen(false);
			if (except !== "openIn") setOpenInOpen(false);
		};
		const onDoc = (e: MouseEvent): void => {
			const path = e.composedPath();
			if (path.some(el => el instanceof HTMLElement && el.hasAttribute("data-header-menu"))) return;
			const trigger = path.find(
				(el): el is HTMLElement => el instanceof HTMLElement && el.hasAttribute("data-header-trigger"),
			);
			closeAll(trigger?.getAttribute("data-header-trigger") ?? undefined);
		};
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") closeAll();
		};
		document.addEventListener("mousedown", onDoc);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDoc);
			document.removeEventListener("keydown", onKey);
		};
	}, [anyMenuOpen]);

	const fmtSessionTime = (ts: number): string => {
		const d = new Date(ts);
		if (Number.isNaN(d.getTime())) return "";
		const now = new Date();
		return d.toDateString() === now.toDateString()
			? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
			: d.toLocaleDateString([], { month: "short", day: "numeric" });
	};

	return (
		<header
			className={`gui-header flex h-12 flex-shrink-0 items-center gap-2 px-4${
				store ? " gui-header--session" : " gui-header--welcome"
			}`}
			style={{
				// Right carve only: native titleBarOverlay hit area (win/linux).
				// Left clearance is the .gui-header-spacer's job (§5t) — never
				// an inline paddingLeft guess.
				...(hasOverlay ? { paddingRight: 150 } : {}),
			}}
		>
			{/* TitlebarLeftControls: a fixed, HORIZONTAL overlay
			 * cluster — a CHILD of the drag header so Electron honors
			 * no-drag reliably. Sidebar toggle + the project-actions capsule
			 * (auto-discover dev server / stop while running), the toggle and the actions capsule both work from here. */}
			<div className="gui-float-controls gui-float-controls--overlay" ref={floatRef}>
				<button
					type="button"
					className="gui-sidebar-toggle"
					title={sideCollapsed ? t("transcript.openSidebar") : t("transcript.closeSidebar")}
					aria-label={sideCollapsed ? t("transcript.openSidebar") : t("transcript.closeSidebar")}
					onClick={onToggleSidebar}
				>
					<StateIcon on={sideCollapsed} pair={["layout-right", "layout-left"]} className="h-4 w-4" />
				</button>
				<div className="gui-openin-capsule">
					<button
						type="button"
						data-header-trigger="proj-main"
						className={`gui-openin-main${devRunning ? " gui-openin-main--running" : ""}`}
						title={
							devRunning || devStopping
								? t("general.stopDevServer")
								: devCommand
									? t("general.runDevServer")
									: t("general.autoDiscover")
						}
						aria-label={
							devRunning || devStopping
								? t("general.stopDevServer")
								: devCommand
									? t("general.runDevServer")
									: t("general.autoDiscover")
						}
						onClick={runDevServer}
					>
						{devRunning || devStopping ? (
							devStopping ? (
								<Icon name="loader-4" className="h-3.5 w-3.5 animate-spin text-[var(--color-warning)]" />
							) : (
								<Icon name="stop" className="h-3.5 w-3.5" />
							)
						) : (
							<Icon name="scan-2" className="h-3.5 w-3.5" />
						)}
					</button>
					{/* Preview button: appears
					 * once the dev server printed its URL; click re-opens it. */}
					{devRunning && devPreviewUrl && (
						<button
							type="button"
							data-header-trigger="proj-preview"
							className="gui-openin-more"
							title={t("general.openPreview")}
							aria-label={t("general.openPreview")}
							onClick={() => void openExternalUrl(devPreviewUrl)}
						>
							<Icon name="global" className="h-3.5 w-3.5" />
						</button>
					)}
					<button
						type="button"
						ref={projBtnRef}
						data-header-trigger="proj"
						className="gui-openin-more"
						title={t("general.projectActions")}
						aria-label={t("general.projectActions")}
						onClick={() => setProjOpen(v => !v)}
					>
						<Icon name="arrow-down-s" className="h-3 w-3" />
					</button>
					{noDevFlash && (
						<div className="gui-openin-menu gui-header-no-dev" role="status">
							{t("general.noDevScript")}
						</div>
					)}
					<MenuPopup
						open={projOpen}
						className="gui-openin-menu"
						portal
						anchor={projBtnRef.current}
						align="right"
						onOpenChange={setProjOpen}
					>
						{/* Custom actions: run
						 * in the dock terminal like the dev server. */}
						{projectActions.map(action => (
							<button
								key={action.id}
								type="button"
								className="gui-view-opt"
								onClick={() => {
									setProjOpen(false);
									runProjectAction(action);
								}}
							>
								<Icon name={resolveProjectActionIcon(action.icon)} className="h-3.5 w-3.5" />
								<span>{action.name}</span>
							</button>
						))}
						{projectActions.length > 0 && <div className="my-1 border-t border-[var(--border)]" />}
						<button
							type="button"
							className="gui-view-opt"
							onClick={() => {
								setProjOpen(false);
								setActionsEditorOpen(true);
							}}
						>
							<Icon name="add" className="h-3.5 w-3.5" />
							<span>{t("general.addNewAction")}</span>
						</button>
						<div className="my-1 border-t border-[var(--border)]" />
						<button
							type="button"
							className="gui-view-opt"
							onClick={() => {
								setProjOpen(false);
								runDevServer();
							}}
						>
							{devRunning || devStopping ? (
								devStopping ? (
									<Icon name="loader-4" className="h-3.5 w-3.5 animate-spin text-[var(--color-warning)]" />
								) : (
									<Icon name="stop" className="h-3.5 w-3.5 text-[var(--color-warning)]" />
								)
							) : (
								<Icon name="scan-2" className="h-3.5 w-3.5" />
							)}
							<span>{t("general.autoDiscover")}</span>
							{!devCommand && (
								<span className="ml-auto pl-3 text-[11px] text-[var(--color-text-faint)]">
									{t("general.noDevScript")}
								</span>
							)}
						</button>
					</MenuPopup>
				</div>
			</div>
			{/* §5t collapsed-sidebar carve spacer: reserves the float
			 * cluster's measured width so the session-title pill never
			 * slides underneath it (drag strip carved out). */}
			<div className="gui-header-spacer" data-collapsed={sideCollapsed ? "true" : undefined} aria-hidden="true" />
			<div className="flex min-w-0 flex-1 items-center gap-0.5">
				{/* Session title = switcher trigger: clicking opens 新建会话 +
				 * recent sessions. Essential when the sidebar is collapsed. */}
				{tabs && tabs.length > 0 ? (
					<>
						<button
							type="button"
							ref={switcherBtnRef}
							data-header-trigger="switcher"
							className="gui-tool-btn h-6 w-6 flex-shrink-0"
							title={t("general.recentSessions")}
							aria-label={t("general.recentSessions")}
							onClick={() => setSwitcherOpen(v => !v)}
						>
							<Icon name="chat-thread" className="h-3.5 w-3.5" />
						</button>
						<SessionTabsStrip
							tabs={tabs}
							activeId={store?.sessionId ?? null}
							previewTabId={previewTabId ?? null}
							onSelect={onSelectTab ?? (() => {})}
							onKeepOpen={onKeepOpenTab ?? (() => {})}
							onRename={id => renameSessionById(id, tabs.find(tab => tab.id === id)?.label ?? "")}
							onCopyId={id => void copyToClipboard(id)}
							onExport={id => {
								const label = tabs.find(tab => tab.id === id)?.label ?? t("transcript.untitledSession");
								void onExportSession?.(id, label).then(ok => {
									if (!ok) toast(t("general.exportFailed"), "error");
								});
							}}
							onOpenMiniChat={id => onOpenMiniChat?.(id)}
							onMoveToWorktree={id => void moveToNewWorktree(id, tabs.find(tab => tab.id === id)?.cwd)}
							onArchive={onArchiveTab ?? (() => {})}
							onDelete={id => void onDeleteSession(id)}
							onClose={onCloseTab ?? (() => {})}
							onCloseOthers={onCloseOtherTabs ?? (() => {})}
							onReorder={onReorderTabs ?? (() => {})}
						/>
					</>
				) : (
					<div className="gui-header-title">
						<button
							type="button"
							ref={switcherBtnRef}
							data-header-trigger="switcher"
							className="gui-header-title-btn"
							title={t("general.recentSessions")}
							aria-label={t("general.recentSessions")}
							onClick={() => setSwitcherOpen(v => !v)}
						>
							<span className="gui-header-title-row">
								{store && <AgentAvatar state={orb} size={20} />}
								<span
									className="min-w-0 truncate text-[14px] font-medium text-[var(--color-text)]"
									title={title}
								>
									{title}
								</span>
								{remote && (
									<span className="gui-remote-chip" title={t("settings.remoteWorkspace")}>
										<Icon name="server" className="h-3 w-3" />
										{t("settings.remote2")}
									</span>
								)}
								{ceiling && (
									<span className="hidden text-[12px] text-[var(--color-text-faint)] md:inline">
										{t("settings.thinking2")} · {ceiling}
									</span>
								)}
							</span>
							<span className="gui-header-subrow">
								{gitBranch && (
									<span className="gui-header-chip" title={`${t("general.gitBranch")} · ${gitBranch}`}>
										<Icon name="git-branch" className="h-2.5 w-2.5" />
										{gitBranch}
									</span>
								)}
								<span
									className="min-w-0 truncate text-[10.5px] text-[var(--color-text-faint)]"
									title={store ? projectLabel : project ? projectName(project) : t("general.local")}
								>
									{store ? projectLabel : project ? projectName(project) : t("general.local")}
								</span>
								{ctxChip && (
									<span className="gui-header-chip" title={t("general.contextUsage")}>
										{t("ctx percent", { percent: Math.round(ctxChip.percent) })}
									</span>
								)}
							</span>
						</button>
					</div>
				)}
				<MenuPopup
					open={switcherOpen}
					className="gui-header-title-menu"
					portal
					anchor={switcherBtnRef.current}
					onOpenChange={setSwitcherOpen}
				>
					<button
						type="button"
						className="gui-header-session-row"
						onClick={() => {
							setSwitcherOpen(false);
							onNewSession();
						}}
					>
						<Icon name="chat-new" className="h-4 w-4 text-[var(--color-text-faint)]" />
						<span className="truncate text-[13px] text-[var(--color-text)]">{t("settings.newSession")}</span>
					</button>
					<div className="my-1 border-t border-[var(--border)]" />
					{sessions.length === 0 ? (
						<div className="px-3 py-4 text-center text-[12px] text-[var(--color-text-faint)]">
							{t("settings.selectSession")}
						</div>
					) : (
						sessions.map(s => {
							const active = store?.sessionId === s.id;
							return (
								<button
									key={s.id}
									type="button"
									className={`gui-header-session-row${active ? " gui-header-session-row--active" : ""}`}
									title={s.id}
									onClick={() => {
										setSwitcherOpen(false);
										onSelectSession(s.id);
									}}
								>
									<StateIcon
										on={active}
										pair={["chat-thread", "chat-1"]}
										className="h-3.5 w-3.5 flex-shrink-0"
									/>
									<span className="min-w-0 flex-1 truncate">
										{s.label.trim() || t("transcript.untitledSession")}
									</span>
									{active && <Icon name="check" className="h-3 w-3 flex-shrink-0" />}
									<span className="flex-shrink-0 text-[11px] text-[var(--color-text-faint)]">
										{fmtSessionTime(s.timestamp)}
									</span>
								</button>
							);
						})
					)}
				</MenuPopup>
				{/* Session-title menu: horizontal
				 * ellipsis; rename / copy id / share / export / worktree /
				 * archive / delete. */}
				{store && (
					<div className="relative">
						<button
							type="button"
							ref={titleMenuBtnRef}
							data-header-trigger="titleMenu"
							className="gui-tool-btn h-6 w-6"
							title={t("tools.more")}
							aria-label={t("tools.more")}
							onClick={() => setTitleMenuOpen(v => !v)}
						>
							<Icon name="more" className="h-3.5 w-3.5" />
						</button>
						<MenuPopup
							open={titleMenuOpen}
							className="gui-overlay-menu"
							portal
							anchor={titleMenuBtnRef.current}
							onOpenChange={setTitleMenuOpen}
						>
							<button
								type="button"
								className="gui-view-opt"
								onClick={() => {
									setTitleMenuOpen(false);
									renameActiveSession();
								}}
							>
								<Icon name="pencil" className="h-3.5 w-3.5" />
								<span>{t("settings.renameSession")}</span>
							</button>
							<button
								type="button"
								className="gui-view-opt"
								onClick={() => {
									setTitleMenuOpen(false);
									if (store) void copyToClipboard(store.sessionId);
								}}
							>
								<Icon name="clipboard" className="h-3.5 w-3.5" />
								<span>{t("transcript.copySessionId")}</span>
							</button>
							<button
								type="button"
								className="gui-view-opt"
								onClick={() => {
									setTitleMenuOpen(false);
									onOpenCollab();
								}}
							>
								<Icon name="share-2" className="h-3.5 w-3.5" />
								<span>{t("general.share")}</span>
							</button>
							<button
								type="button"
								className="gui-view-opt"
								onClick={() => {
									setTitleMenuOpen(false);
									exportSessionMarkdown();
								}}
							>
								<Icon name="download" className="h-3.5 w-3.5" />
								<span>{t("general.exportMarkdown")}</span>
							</button>
							<button
								type="button"
								className="gui-view-opt"
								onClick={() => {
									setTitleMenuOpen(false);
									void moveToNewWorktree();
								}}
							>
								<Icon name="folder-shared" className="h-3.5 w-3.5" />
								<span>{t("general.moveNewWorktree")}</span>
							</button>
							<div className="my-1 border-t border-[var(--border)]" />
							<button
								type="button"
								className="gui-view-opt"
								onClick={() => {
									setTitleMenuOpen(false);
									archiveActiveSession();
								}}
							>
								<Icon name="inbox-archive" className="h-3.5 w-3.5" />
								<span>{t("settings.archive")}</span>
							</button>
							<button
								type="button"
								className="gui-view-opt gui-view-opt--danger"
								onClick={() => {
									setTitleMenuOpen(false);
									deleteActiveSession();
								}}
							>
								<Icon name="delete-bin" className="h-3.5 w-3.5" />
								<span>{t("general.deleteSession")}</span>
							</button>
						</MenuPopup>
					</div>
				)}
			</div>
			<div className="ml-auto flex shrink-0 items-center gap-1">
				{/* Pause controls (per-session then global), left of the
				 * terminal toggle — kept out of the left titlebar overlay so
				 * they never collide with the session-title button. */}
				{onTogglePause && (
					<button
						type="button"
						data-header-trigger="pause"
						className={`gui-pause-btn gui-tool-btn--p2${paused ? " gui-pause-btn--active" : ""}`}
						title={
							pauseDisabled
								? t("tools.selectSessionPause")
								: paused
									? pausedAt
										? `${t("tools.resumeAllAgents")} · ${formatPauseElapsed(pausedAt)}`
										: t("tools.resumeAllAgents")
									: t("tools.pauseAllAgents")
						}
						aria-label={
							pauseDisabled
								? t("tools.selectSessionPause")
								: paused
									? t("tools.resumeAllAgents")
									: t("tools.pauseAllAgents")
						}
						aria-pressed={paused === true}
						disabled={pauseDisabled === true}
						onClick={() => onTogglePause()}
					>
						<StateIcon on={paused} pair={["play", "pause"]} className="h-3.5 w-3.5" />
					</button>
				)}
				{onToggleGlobalPause && (
					<button
						type="button"
						data-header-trigger="global-pause"
						className={`gui-pause-btn gui-global-pause-btn gui-tool-btn--p2${globalPaused ? " gui-pause-btn--active" : ""}`}
						title={globalPaused ? t("tools.resumeAllSessions") : t("tools.pauseAllSessions")}
						aria-label={globalPaused ? t("tools.resumeAllSessions") : t("tools.pauseAllSessions")}
						aria-pressed={globalPaused === true}
						onClick={() => onToggleGlobalPause()}
					>
						<StateIcon on={globalPaused} pair={["play", "stop"]} className="h-3.5 w-3.5" />
					</button>
				)}
				{/* Mini chat (picture-in-picture). */}
				<button
					type="button"
					className="gui-tool-btn gui-tool-btn--p2 h-7 w-7"
					title={t("general.miniChat")}
					aria-label={t("general.miniChat")}
					onClick={() => void openMiniChat()}
				>
					<Icon name="apps-2-ai" className="h-4 w-4" />
				</button>
				{/* Open-in capsule: the selected
				 * app's icon with a dropdown of every installed app. */}
				{openInDir && (
					<div className="gui-openin-capsule">
						<button
							type="button"
							data-header-trigger="openIn-main"
							className={`gui-openin-main${openInScanning ? " gui-openin-main--scanning" : ""}`}
							title={
								selectedOpenInApp
									? t("settings.openWithWithApp", {
											app: openInLabel(selectedOpenInApp),
										})
									: t("general.openActions")
							}
							aria-label={
								selectedOpenInApp
									? t("settings.openWithWithApp", {
											app: openInLabel(selectedOpenInApp),
										})
									: t("general.openActions")
							}
							onClick={() => {
								if (selectedOpenInApp) void openWith(selectedOpenInApp.appName, openInDir);
							}}
						>
							<span className="gui-openin-app-icon">
								{selectedOpenInApp?.iconDataUrl ? (
									<img src={selectedOpenInApp.iconDataUrl} alt="" draggable={false} />
								) : selectedOpenInApp && OPENIN_FALLBACK_ICON[selectedOpenInApp.id] ? (
									<Icon name={OPENIN_FALLBACK_ICON[selectedOpenInApp.id] as never} className="h-4 w-4" />
								) : (
									(selectedOpenInApp?.label.trim().slice(0, 1).toUpperCase() ?? "?")
								)}
							</span>
						</button>
						<button
							type="button"
							ref={openInBtnRef}
							data-header-trigger="openIn"
							className="gui-openin-more"
							title={t("settings.chooseOpenApp")}
							aria-label={t("settings.chooseOpenApp")}
							onClick={() => setOpenInOpen(v => !v)}
						>
							<Icon name="arrow-down-s" className="h-3 w-3" />
						</button>
						<MenuPopup
							open={openInOpen}
							className="gui-openin-menu"
							portal
							anchor={openInBtnRef.current}
							align="right"
							onOpenChange={setOpenInOpen}
						>
							<button
								type="button"
								className="gui-view-opt"
								onClick={() => {
									setOpenInOpen(false);
									void copyToClipboard(openInDir);
								}}
							>
								<Icon name="file-copy" className="h-3.5 w-3.5" />
								<span>{t("settings.copyPath")}</span>
							</button>
							<div className="my-1 border-t border-[var(--border)]" />
							{openInApps.map(app => {
								const active = selectedOpenInApp?.id === app.id;
								return (
									<button
										key={app.id}
										type="button"
										className={`gui-view-opt${active ? " gui-view-opt--active" : ""}`}
										onClick={() => selectOpenInApp(app)}
									>
										<span className="gui-openin-app-icon">
											{app.iconDataUrl ? (
												<img src={app.iconDataUrl} alt="" draggable={false} />
											) : OPENIN_FALLBACK_ICON[app.id] ? (
												<Icon name={OPENIN_FALLBACK_ICON[app.id] as never} className="h-4 w-4" />
											) : (
												(app.label.trim().slice(0, 1).toUpperCase() ?? "?")
											)}
										</span>
										<span>{openInLabel(app)}</span>
										{active && <Icon name="check" className="ml-auto h-3 w-3" />}
									</button>
								);
							})}
							{openInApps.length === 0 && (
								<div className="px-3 py-2 text-[12px] text-[var(--color-text-faint)]">
									{t("general.noApps")}
								</div>
							)}
							<button
								type="button"
								className="gui-view-opt"
								onClick={() => {
									setOpenInOpen(false);
									loadOpenInApps();
								}}
							>
								<Icon name="refresh" className="h-3.5 w-3.5" />
								<span>{t("general.refreshApps")}</span>
							</button>
							<div className="my-1 border-t border-[var(--border)]" />
							<button
								type="button"
								className="gui-view-opt"
								onClick={() => {
									setOpenInOpen(false);
									onOpenFolder();
								}}
							>
								<Icon name="folder-open" className="h-3.5 w-3.5" />
								<span>{t("settings.openFolder")}</span>
							</button>
						</MenuPopup>
					</div>
				)}
			</div>
			{/* statusText mirrors the orb state for screen readers. */}
			<span className="sr-only">{statusText}</span>
			{/* Custom-actions editor ("添加新操作"): always mounted, driven by
			 * `open` so the DialogFrame exit animation plays. */}
			<ProjectActionsDialog
				open={actionsEditorOpen}
				onClose={() => setActionsEditorOpen(false)}
				actions={projectActions}
				onChange={persistProjectActions}
			/>
		</header>
	);
}
