import { t } from "@musepi/collab-web";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { usePrompt } from "../lib/prompt-dialog";
import type { RpcClient } from "../lib/rpc";
import type { GuiSessionStore } from "../lib/session-store";
import { useStore } from "../lib/use-store";
import { Icon } from "../vendor/oc-icons";
import type { OrbState } from "../vendor/thinking-orbs";
import { AgentAvatar } from "./AgentAvatar";
import { Pop } from "./Pop";

/** "mm:ss" hold time for the paused-state hint (matches the composer's
 *  pause banner formatting). */
function formatPauseElapsed(pausedAt: number): string {
	const seconds = Math.max(0, Math.floor((Date.now() - pausedAt) / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Window header — the container layer between the session sidebar and the
 * chat surface (openchamber Header parity: Sidebar | Header > ChatSurface).
 * Full-width drag region; floating sidebar controls on the left (sidebar
 * toggle + project-actions capsule), the session title as a switcher
 * trigger (openchamber SessionSwitcherDropdown) in the middle, and the
 * top-right cluster (terminal, right panel, mini chat, open-in, instance
 * info, more) on the right. No divider line in the welcome state.
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
	rightPanelOpen,
	onToggleRightPanel,
	project,
	onOpenFolder,
	sessions,
	onSelectSession,
	onRenameSession,
	onOpenBoard,
	sessionLabel,
	remote,
	connected,
	daemonUrl,
	onReconnect,
	onRestartDaemon,
	onOpenCollab,
	onDeleteSession,
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
	rightPanelOpen: boolean;
	onToggleRightPanel(): void;
	project: string | null;
	onOpenFolder(): void;
	/** Recent sessions for the header switcher (openchamber
	 * SessionSwitcherDropdown), newest first. */
	sessions: { id: string; label: string; timestamp: number }[];
	onSelectSession(id: string): void;
	/** Persist a user-set session title (daemon session.rename). */
	onRenameSession(sessionId: string, title: string): void;
	/** Open the board/dashboard view (kimi-work parity). */
	onOpenBoard?(): void;
	/** Tree label of the active session — reflects renames. */
	sessionLabel?: string | null;
	/** Session cwd lives under the sshfs remote mount dir — show the
	 *  remote-workspace chip next to the title. */
	remote?: boolean;
	/** Daemon connection state (instance menu status dot). */
	connected: boolean;
	/** WebSocket endpoint URL of the connected daemon (instance menu host
	 *  row, openchamber DesktopHostSwitcher parity). */
	daemonUrl: string;
	/** Re-run the daemon boot/connect chain (instance menu 重新连接). */
	onReconnect(): void;
	/** Restart the daemon process itself (instance menu 重启 daemon) —
	 *  kills the detached listener and spawns fresh code, then reconnects. */
	onRestartDaemon(): void;
	/** Open the collab remote-control dialog (session 分享). */
	onOpenCollab(): void;
	/** Permanently delete a session (journal + index); the caller also
	 *  resets the UI when it was the active session. Returns success. */
	onDeleteSession(sessionId: string): Promise<boolean>;
}): ReactNode {
	const noopSubscribe = (): (() => void) => () => {};
	const snap = useStore(
		store ? store.subscribe.bind(store) : noopSubscribe,
		store ? store.getSnapshot.bind(store) : () => null,
	);
	const orb: OrbState = snap?.working ? (snap.streaming ? "composing" : "working") : "listening";
	const statusText = snap?.working ? (snap.streaming ? t("replying") : t("working")) : t("idle");
	// Traffic lights are macOS-only. Windows/Linux get a native
	// titleBarOverlay (top-right ~138px) so the right cluster needs
	// clearance; macOS keeps the 172px left clearance for the
	// red/yellow/green buttons; other platforms (web) reclaim both.
	const isWin = shellPlatform() === "win32";
	const isLinux = shellPlatform() === "linux";
	const hasOverlay = isWin || isLinux;
	const isMac = shellPlatform() === "darwin";
	const [ceiling, setCeiling] = useState<string | null>(null);
	const projectLabel = snap?.state?.cwd ? projectName(snap.state.cwd) : store ? t("session") : t("local");
	// Trigger refs for the portaled popups (global z-order above the chat
	// surface — the header itself is z-1 and would trap in-flow menus).
	const projBtnRef = useRef<HTMLButtonElement | null>(null);
	const switcherBtnRef = useRef<HTMLButtonElement | null>(null);
	const titleMenuBtnRef = useRef<HTMLButtonElement | null>(null);
	const openInBtnRef = useRef<HTMLButtonElement | null>(null);
	const instanceBtnRef = useRef<HTMLButtonElement | null>(null);
	const [openInOpen, setOpenInOpen] = useState(false);
	const [projOpen, setProjOpen] = useState(false);
	const [switcherOpen, setSwitcherOpen] = useState(false);
	const [titleMenuOpen, setTitleMenuOpen] = useState(false);
	const [instanceOpen, setInstanceOpen] = useState(false);
	const openInDir = store?.cwd ?? project ?? "";
	const [devRunning, setDevRunning] = useState(false);
	const [devStopping, setDevStopping] = useState(false);
	// First http(s) URL seen in terminal output while the dev server runs
	// (openchamber autoOpenUrl + preview button).
	const [devPreviewUrl, setDevPreviewUrl] = useState<string | null>(null);
	const [noDevFlash, setNoDevFlash] = useState(false);
	const noDevTimer = useRef<number | null>(null);

	// Open-in app list (openchamber OpenInAppButton parity): real app icons
	// from the Electron shell, persisted selection like openInAppsStore.
	const [openInApps, setOpenInApps] = useState<OpenInApp[]>([]);
	const [openInScanning, setOpenInScanning] = useState(false);
	const [openInAppId, setOpenInAppId] = useState<string | null>(() => {
		try {
			return localStorage.getItem("omp-gui-openin-app");
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
			localStorage.setItem("omp-gui-openin-app", app.id);
		} catch {
			// storage unavailable
		}
		if (openInDir) void openWith(app.appName, openInDir);
	};

	// Dev-server auto-discovery (openchamber detectDevServer parity): look
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
			.request<{ content: string | null }>("fs.read", { path: `${dir}/package.json` })
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
					// Package manager from lockfiles (openchamber detectPackageManager).
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
							.request<{ content: string | null }>("fs.read", { path: `${dir}/${lock}` })
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
			// (openchamber stopAction spinner parity).
			if (devStopping) return;
			setDevStopping(true);
			setTimeout(() => {
				window.dispatchEvent(new Event("omp-gui-terminal-stop"));
				setDevRunning(false);
				setDevStopping(false);
				setDevPreviewUrl(null);
			}, 400);
			return;
		}
		if (!terminalOpen) onToggleTerminal();
		setTimeout(() => {
			window.dispatchEvent(new CustomEvent("omp-gui-terminal-cmd", { detail: devCommand }));
		}, 900);
		setDevRunning(true);
		setDevPreviewUrl(null);
	}, [devCommand, devRunning, devStopping, terminalOpen, onToggleTerminal]);

	// While the dev server runs, watch the dock terminal output for the
	// first http(s) URL (openchamber projectActionTerminal autoOpenUrl):
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
	useEffect(() => {
		if (!store) return;
		let cancelled = false;
		void rpc
			.request<{ ceiling?: string }>("session.thinkingInfo", { sessionId: store.sessionId })
			.then(info => {
				if (!cancelled) setCeiling(info.ceiling ?? null);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [rpc, store]);

	// Instance info (openchamber DesktopServicesMenu / DesktopHostSwitcher):
	// real version + round-trip latency from system.meta, refreshed whenever
	// the menu opens or the refresh button is hit.
	const [daemonVersion, setDaemonVersion] = useState<string | null>(null);
	const [daemonLatency, setDaemonLatency] = useState<number | null>(null);
	const [metaLoading, setMetaLoading] = useState(false);
	const refreshMeta = useCallback((): void => {
		if (!rpc) return;
		setMetaLoading(true);
		const t0 = performance.now();
		void rpc
			.request<{ version?: string }>("system.meta")
			.then(meta => {
				setDaemonVersion(meta?.version ?? null);
				setDaemonLatency(Math.max(0, Math.round(performance.now() - t0)));
			})
			.catch(() => {
				setDaemonLatency(null);
			})
			.finally(() => setMetaLoading(false));
	}, [rpc]);
	useEffect(() => {
		if (instanceOpen) refreshMeta();
	}, [instanceOpen, refreshMeta]);

	const sessionTitle = ((): string => {
		if (!store) return t("MusePi");
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
		return snap?.state?.cwd?.split("/").pop() ?? t("session");
	})();
	// A renamed title comes from the session tree, not the message stream.
	const title = sessionLabel?.trim() ? sessionLabel : sessionTitle;

	const { prompt } = usePrompt();
	const renameActiveSession = (): void => {
		if (!store) return;
		const current = title;
		void prompt({ title: t("rename session"), defaultValue: current }).then(next => {
			if (!next || next === current) return;
			onRenameSession(store.sessionId, next);
		});
	};

	/** Export the active session transcript as a downloadable Markdown file
	 *  (openchamber exportMarkdown parity; client-side from the store). */
	const exportSessionMarkdown = (): void => {
		if (!store) return;
		const snap = store.getSnapshot();
		const textOf = (content: unknown): string =>
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content.map(b => (b as { text?: string }).text ?? "").join("\n")
					: "";
		const lines: string[] = [`# ${title}`, ""];
		for (const e of snap.entries) {
			if (e.type !== "message") continue;
			const role = e.message?.role;
			if (role !== "user" && role !== "assistant") continue;
			const body = textOf(e.message?.content).trim();
			if (!body) continue;
			lines.push(`## ${role === "user" ? t("user") : t("assistant")}`, "", body, "");
		}
		const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = `${
			title
				.replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 40) || "session"
		}.md`;
		a.click();
		URL.revokeObjectURL(a.href);
	};

	/** Archive the active session (openchamber bulkActions.archive parity):
	 *  same localStorage archive the sidebar reads, broadcast so the
	 *  sidebar's in-memory list follows without a reload. */
	const archiveActiveSession = (): void => {
		if (!store) return;
		let archived: { sessionId: string; archivedAt: number; cwd?: string }[] = [];
		try {
			archived = JSON.parse(localStorage.getItem("omp-gui-archived") ?? "[]") as typeof archived;
		} catch {
			// fresh archive
		}
		if (!archived.some(a => a.sessionId === store.sessionId)) {
			archived.push({ sessionId: store.sessionId, archivedAt: Date.now(), cwd: store.cwd ?? undefined });
		}
		try {
			localStorage.setItem("omp-gui-archived", JSON.stringify(archived));
		} catch {
			// storage unavailable
		}
		window.dispatchEvent(new CustomEvent("omp-gui-sessions-archived"));
		onNewSession();
	};

	/** Delete the active session — the confirm dialog lives in deleteSession
	 *  (settings 会话 toggle omp-gui-confirm-delete), so the header must not
	 *  double-prompt. */
	const deleteActiveSession = (): void => {
		if (!store) return;
		void onDeleteSession(store.sessionId);
	};

	// Outside click / Escape closes every open header popup (base-ui
	// DropdownMenu semantics). Clicking a trigger closes the OTHER menus and
	// lets its own onClick toggle (single-open); clicks inside a popup are
	// left to the item handlers.
	const anyMenuOpen = projOpen || switcherOpen || titleMenuOpen || openInOpen || instanceOpen;
	useEffect(() => {
		if (!anyMenuOpen) return;
		const closeAll = (except?: string): void => {
			if (except !== "proj") setProjOpen(false);
			if (except !== "switcher") setSwitcherOpen(false);
			if (except !== "titleMenu") setTitleMenuOpen(false);
			if (except !== "openIn") setOpenInOpen(false);
			if (except !== "instance") setInstanceOpen(false);
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
				...(sideCollapsed ? { paddingLeft: isMac ? 172 : 16 } : {}),
				...(hasOverlay ? { paddingRight: 150 } : {}),
			}}
		>
			{/* TitlebarLeftControls (openchamber): a fixed, HORIZONTAL overlay
			 * cluster — a CHILD of the drag header so Electron honors
			 * no-drag reliably. Sidebar toggle + the project-actions capsule
			 * (auto-discover dev server / stop while running), exactly like
			 * openchamber's toggle + ProjectActionsButton. */}
			<div className="gui-float-controls gui-float-controls--overlay">
				<button
					type="button"
					className="gui-sidebar-toggle"
					title={sideCollapsed ? t("open sidebar") : t("close sidebar")}
					aria-label={sideCollapsed ? t("open sidebar") : t("close sidebar")}
					onClick={onToggleSidebar}
				>
					<Icon name={sideCollapsed ? "layout-right" : "layout-left"} className="h-4 w-4" />
				</button>
				<div className="gui-openin-capsule">
					<button
						type="button"
						data-header-trigger="proj-main"
						className={`gui-openin-main${devRunning ? " gui-openin-main--running" : ""}`}
						title={
							devRunning || devStopping
								? t("stop dev server")
								: devCommand
									? t("run dev server")
									: t("auto discover")
						}
						aria-label={
							devRunning || devStopping
								? t("stop dev server")
								: devCommand
									? t("run dev server")
									: t("auto discover")
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
					{/* Preview button (openchamber showSelectedPreviewButton): appears
					 * once the dev server printed its URL; click re-opens it. */}
					{devRunning && devPreviewUrl && (
						<button
							type="button"
							data-header-trigger="proj-preview"
							className="gui-openin-more"
							title={t("open preview")}
							aria-label={t("open preview")}
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
						title={t("project actions")}
						aria-label={t("project actions")}
						onClick={() => setProjOpen(v => !v)}
					>
						<Icon name="arrow-down-s" className="h-3 w-3" />
					</button>
					{noDevFlash && (
						<div className="gui-openin-menu gui-header-no-dev" role="status">
							{t("no dev script")}
						</div>
					)}
					<Pop open={projOpen} className="gui-openin-menu" portal anchor={projBtnRef.current} align="right" onOpenChange={setProjOpen}>
						<button
							type="button"
							className="gui-view-opt"
							onClick={() => {
								setProjOpen(false);
								onOpenSettings();
							}}
						>
							<Icon name="add" className="h-3.5 w-3.5" />
							<span>{t("add new action")}</span>
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
							<span>{t("auto discover")}</span>
							{!devCommand && (
								<span className="ml-auto pl-3 text-[11px] text-[var(--color-text-faint)]">
									{t("no dev script")}
								</span>
							)}
						</button>
					</Pop>
				</div>
			</div>
			<div className="flex min-w-0 flex-1 items-center gap-0.5">
				{/* Session title = switcher trigger (openchamber
				 * SessionSwitcherDropdown parity): clicking opens 新建会话 +
				 * recent sessions. Essential when the sidebar is collapsed. */}
				<div className="gui-header-title">
					<button
						type="button"
						ref={switcherBtnRef}
						data-header-trigger="switcher"
						className="gui-header-title-btn"
						title={t("recent sessions")}
						aria-label={t("recent sessions")}
						onClick={() => setSwitcherOpen(v => !v)}
					>
						<span className="gui-header-title-row">
							{store && <AgentAvatar state={orb} size={20} />}
							<span className="min-w-0 truncate text-[14px] font-medium text-[var(--color-text)]" title={title}>
								{title}
							</span>
							{remote && (
								<span className="gui-remote-chip" title={t("remote workspace")}>
									<Icon name="server" className="h-3 w-3" />
									{t("remote")}
								</span>
							)}
							{ceiling && (
								<span className="hidden text-[12px] text-[var(--color-text-faint)] md:inline">
									{t("thinking")} · {ceiling}
								</span>
							)}
						</span>
						<span
							className="max-w-full truncate text-[10.5px] text-[var(--color-text-faint)]"
							title={store ? projectLabel : project ? projectName(project) : t("local")}
						>
							{store ? projectLabel : project ? projectName(project) : t("local")}
						</span>
					</button>
					<Pop open={switcherOpen} className="gui-header-title-menu" portal anchor={switcherBtnRef.current} onOpenChange={setSwitcherOpen}>
						<button
							type="button"
							className="gui-header-session-row"
							onClick={() => {
								setSwitcherOpen(false);
								onNewSession();
							}}
						>
							<Icon name="chat-new" className="h-4 w-4 text-[var(--color-text-faint)]" />
							<span className="truncate text-[13px] text-[var(--color-text)]">{t("new session")}</span>
						</button>
						<div className="my-1 border-t border-[var(--border)]" />
						{sessions.length === 0 ? (
							<div className="px-3 py-4 text-center text-[12px] text-[var(--color-text-faint)]">
								{t("select a session")}
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
										<Icon name={active ? "chat-thread" : "chat-1"} className="h-3.5 w-3.5 flex-shrink-0" />
										<span className="min-w-0 flex-1 truncate">{s.label.trim() || t("untitled session")}</span>
										{active && <Icon name="check" className="h-3 w-3 flex-shrink-0" />}
										<span className="flex-shrink-0 text-[11px] text-[var(--color-text-faint)]">
											{fmtSessionTime(s.timestamp)}
										</span>
									</button>
								);
							})
						)}
					</Pop>
				</div>
				{/* Session-title menu (openchamber session … button): horizontal
				 * ellipsis; rename / copy id / share / export / worktree /
				 * archive / delete. */}
				{store && (
					<div className="relative">
						<button
							type="button"
							ref={titleMenuBtnRef}
							data-header-trigger="titleMenu"
							className="gui-tool-btn h-6 w-6"
							title={t("more")}
							aria-label={t("more")}
							onClick={() => setTitleMenuOpen(v => !v)}
						>
							<Icon name="more" className="h-3.5 w-3.5" />
						</button>
						<Pop open={titleMenuOpen} className="gui-overlay-menu" portal anchor={titleMenuBtnRef.current} onOpenChange={setTitleMenuOpen}>
							<button
								type="button"
								className="gui-view-opt"
								onClick={() => {
									setTitleMenuOpen(false);
									renameActiveSession();
								}}
							>
								<Icon name="pencil" className="h-3.5 w-3.5" />
								<span>{t("rename session")}</span>
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
								<span>{t("copy session id")}</span>
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
								<span>{t("share")}</span>
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
								<span>{t("export markdown")}</span>
							</button>
							<button type="button" className="gui-view-opt" disabled title={t("worktree unavailable")}>
								<Icon name="folder-shared" className="h-3.5 w-3.5" />
								<span>{t("move to new worktree")}</span>
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
								<span>{t("archive")}</span>
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
								<span>{t("delete session")}</span>
							</button>
						</Pop>
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
						className={`gui-pause-btn${paused ? " gui-pause-btn--active" : ""}`}
						title={
							pauseDisabled
								? t("select a session to pause it")
								: paused
									? pausedAt
										? `${t("resume all agents")} · ${formatPauseElapsed(pausedAt)}`
										: t("resume all agents")
									: t("pause all agents")
						}
						aria-label={
							pauseDisabled
								? t("select a session to pause it")
								: paused
									? t("resume all agents")
									: t("pause all agents")
						}
						aria-pressed={paused === true}
						disabled={pauseDisabled === true}
						onClick={() => onTogglePause()}
					>
						<Icon name={paused ? "play" : "pause"} className="h-3.5 w-3.5" />
					</button>
				)}
				{onToggleGlobalPause && (
					<button
						type="button"
						data-header-trigger="global-pause"
						className={`gui-pause-btn gui-global-pause-btn${globalPaused ? " gui-pause-btn--active" : ""}`}
						title={globalPaused ? t("resume all sessions") : t("pause all sessions")}
						aria-label={globalPaused ? t("resume all sessions") : t("pause all sessions")}
						aria-pressed={globalPaused === true}
						onClick={() => onToggleGlobalPause()}
					>
						<Icon name={globalPaused ? "play" : "stop"} className="h-3.5 w-3.5" />
					</button>
				)}
				<button
					type="button"
					className={`gui-tool-btn h-7 w-7${terminalOpen ? " gui-tool-btn--active" : ""}`}
					title={t("toggle terminal")}
					aria-label={t("toggle terminal")}
					onClick={onToggleTerminal}
				>
					<Icon name="terminal-box" className="h-4 w-4" />
				</button>
				{onOpenBoard && (
					<button
						type="button"
						className="gui-tool-btn h-7 w-7"
						title={t("board")}
						aria-label={t("board")}
						onClick={onOpenBoard}
					>
						<Icon name="layout-column" className="h-4 w-4" />
					</button>
				)}
				{store && (
					<button
						type="button"
						className={`gui-tool-btn h-7 w-7${rightPanelOpen ? " gui-tool-btn--active" : ""}`}
						title={t("toggle panel")}
						aria-label={t("toggle panel")}
						onClick={onToggleRightPanel}
					>
						<Icon name="equalizer-2" className="h-4 w-4" />
					</button>
				)}
				{/* Mini chat (openchamber picture-in-picture). */}
				<button
					type="button"
					className="gui-tool-btn h-7 w-7"
					title={t("mini chat")}
					aria-label={t("mini chat")}
					onClick={() => void openMiniChat()}
				>
					<Icon name="apps-2-ai" className="h-4 w-4" />
				</button>
				{/* Open-in capsule (openchamber OpenInAppButton): the selected
				 * app's icon with a dropdown of every installed app. */}
				{openInDir && (
					<div className="gui-openin-capsule">
						<button
							type="button"
							data-header-trigger="openIn-main"
							className={`gui-openin-main${openInScanning ? " gui-openin-main--scanning" : ""}`}
							title={t("open actions")}
							aria-label={t("open actions")}
							onClick={() => {
								if (selectedOpenInApp) void openWith(selectedOpenInApp.appName, openInDir);
							}}
						>
							<span className="gui-openin-app-icon">
								{selectedOpenInApp?.iconDataUrl ? (
									<img src={selectedOpenInApp.iconDataUrl} alt="" draggable={false} />
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
							title={t("open actions")}
							aria-label={t("open actions")}
							onClick={() => setOpenInOpen(v => !v)}
						>
							<Icon name="arrow-down-s" className="h-3 w-3" />
						</button>
						<Pop open={openInOpen} className="gui-openin-menu" portal anchor={openInBtnRef.current} align="right" onOpenChange={setOpenInOpen}>
							<button
								type="button"
								className="gui-view-opt"
								onClick={() => {
									setOpenInOpen(false);
									void copyToClipboard(openInDir);
								}}
							>
								<Icon name="file-copy" className="h-3.5 w-3.5" />
								<span>{t("copy path")}</span>
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
											) : (
												(app.label.trim().slice(0, 1).toUpperCase() ?? "?")
											)}
										</span>
										<span>{app.label}</span>
										{active && <Icon name="check" className="ml-auto h-3 w-3" />}
									</button>
								);
							})}
							{openInApps.length === 0 && (
								<div className="px-3 py-2 text-[12px] text-[var(--color-text-faint)]">{t("no apps")}</div>
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
								<span>{t("refresh apps")}</span>
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
								<span>{t("open folder")}</span>
							</button>
						</Pop>
					</div>
				)}
				{/* Instance info (openchamber DesktopServicesMenu): real daemon
				 * state (system.meta version, connection status) plus actions. */}
				<button
					type="button"
					data-header-trigger="instance"
					ref={instanceBtnRef}
					className="gui-instance-btn"
					title={t("instance info")}
					aria-label={t("instance info")}
					onClick={() => setInstanceOpen(v => !v)}
				>
					<Icon name="stack" className="h-4 w-4" />
					<span>{t("local")}</span>
					<Icon name="arrow-down-s" className="h-3 w-3 opacity-60" />
				</button>
				<Pop open={instanceOpen} className="gui-instance-menu" portal anchor={instanceBtnRef.current} align="right" onOpenChange={setInstanceOpen}>
					{/* Current-instance header row (openchamber DesktopHostSwitcher):
					 * local daemon + manual re-probe. */}
					<div className="flex items-center gap-2 px-2 py-1.5">
						<span className="flex h-6 w-6 items-center justify-center rounded-md bg-[var(--color-surface-sunken)]">
							<Icon name="stack" className="h-3.5 w-3.5" />
						</span>
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-1.5 text-[12.5px] font-medium">
								{t("local daemon")}
								{connected && (
									<span className="rounded-full bg-[var(--color-success)]/15 px-1.5 text-[10px] font-semibold text-[var(--color-success)]">
										current
									</span>
								)}
							</div>
							<div className="truncate text-[11px] text-[var(--color-text-faint)]">
								{connected
									? daemonLatency !== null
										? t("connected · {ms} ms", { ms: String(daemonLatency) })
										: t("connected")
									: t("disconnected")}
							</div>
						</div>
						<button
							type="button"
							className="gui-view-opt !w-auto px-1.5"
							aria-label={t("refresh")}
							title={t("refresh")}
							onClick={refreshMeta}
						>
							<Icon
								name={metaLoading ? "loader-4" : "refresh"}
								className={`h-3.5 w-3.5${metaLoading ? " animate-spin" : ""}`}
							/>
						</button>
					</div>
					{/* Host row (openchamber host list): the single local host with
					 * status dot + version + endpoint URL. */}
					<div className="mx-2 mb-1 flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--color-surface-sunken)]">
						<span
							className={`h-2 w-2 shrink-0 rounded-full ${connected ? "bg-[var(--color-success)]" : "bg-[var(--color-danger)]"}`}
						/>
						<div className="min-w-0 flex-1">
							<div className="truncate text-[12.5px]">{t("local")}</div>
							<div className="truncate font-mono text-[10.5px] text-[var(--color-text-faint)]">{daemonUrl}</div>
						</div>
						<span className="shrink-0 text-[10.5px] text-[var(--color-text-faint)]">{daemonVersion ?? "—"}</span>
					</div>
					<div className="my-1 border-t border-[var(--border)]" />
					<button
						type="button"
						className="gui-view-opt"
						onClick={() => {
							setInstanceOpen(false);
							onOpenSettings();
						}}
					>
						<Icon name="settings-3" className="h-3.5 w-3.5" />
						<span>{t("settings")}</span>
					</button>
					<button
						type="button"
						className="gui-view-opt"
						onClick={() => {
							setInstanceOpen(false);
							onReconnect();
						}}
					>
						<Icon name="restart" className="h-3.5 w-3.5" />
						<span>{t("reconnect")}</span>
					</button>
					<button
						type="button"
						className="gui-view-opt"
						title={t("restart daemon description")}
						onClick={() => {
							setInstanceOpen(false);
							onRestartDaemon();
						}}
					>
						<Icon name="refresh" className="h-3.5 w-3.5" />
						<span>{t("restart daemon")}</span>
					</button>
					<div className="my-1 border-t border-[var(--border)]" />
					<button
						type="button"
						className="gui-view-opt"
						onClick={() => {
							setInstanceOpen(false);
							// Electron: closing the only window quits the app.
							window.close();
						}}
					>
						<Icon name="close" className="h-3.5 w-3.5" />
						<span>{t("quit app")}</span>
					</button>
				</Pop>
			</div>
			{/* statusText mirrors the orb state for screen readers. */}
			<span className="sr-only">{statusText}</span>
		</header>
	);
}
