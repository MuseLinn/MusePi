import { getLocaleSnapshot, LanguageToggle, setLocale, subscribeLocale, ThemeToggle, t } from "@musepi/collab-web";
import type { ReactNode } from "react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AccentToggle } from "./components/AccentToggle";
import { BlurText } from "./components/BlurText";
import { BoardPage } from "./components/BoardPage";
import { ChatView } from "./components/ChatView";
import { CollabDialog } from "./components/CollabDialog";
import { CommandPalette } from "./components/CommandPalette";
import { ConnectDialog } from "./components/ConnectDialog";
import { GlobalPauseOverlay } from "./components/GlobalPauseOverlay";
import { GuiHeader } from "./components/GuiHeader";
import { AnnouncementOverlay } from "./components/AnnouncementOverlay";
import { OnboardingOverlay } from "./components/OnboardingOverlay";
import type { ReminderRow } from "./components/RemindersPanel";
import { ScheduledTasksPage } from "./components/ScheduledTasksPage";
import { SessionSidebar } from "./components/SessionSidebar";
import type { GuiTreeNode } from "./components/SessionTree";
import { SettingsView } from "./components/SettingsView";
import { ShinyText } from "./components/ShinyText";
import type { ThinkingLevel } from "./components/ThinkingSelector";
import { THINKING_LEVELS } from "./components/thinking-selector-shared";
import { applyAppearancePrefs } from "./lib/appearance";
import { pickDirectory, restartDaemon } from "./lib/electron";
import { applyGlassLevel, applyGlassMaterial, readGlassLevel } from "./lib/glass";
import { dispatchNotification } from "./lib/notify";
import { moodFromState, petEnabled, petMode, petScale } from "./lib/pet";
import { PromptProvider, useConfirm } from "./lib/prompt-dialog";
import { RpcClient, type StreamEvent } from "./lib/rpc";
import { cleanupAction, cleanupCandidates, cleanupDays, cleanupEnabled, runCleanupOnce } from "./lib/session-cleanup";
import { clearRoundDurations, dispatchPetActivity, GuiSessionStore, type PetBubbleKind } from "./lib/session-store";
import { captureSelectionText } from "./lib/selection-capture";
import { sfxFor } from "./lib/sfx";
import logoUrl from "./vendor/logo.png";
import { Icon } from "./vendor/oc-icons";
import "./styles/gui.css";

const DEFAULT_URL = "ws://127.0.0.1:8300";

/** Transient RPC-error banner: how long a failure stays visible before
 *  auto-dismissing. Reconnect and the next successful session op clear it
 *  sooner. Long enough to read, short enough that a stale failure never
 *  sticks — the daemon usually recovers without a reconnect (the old
 *  behavior left the red bar until a full reload). */
const ERROR_BANNER_MS = 8_000;

/** RPC failure → banner text. "Unknown session" is the common stale-tree
 *  case (a deleted/unresumable row) — the raw message is just a UUID, so
 *  surface a plain hint instead of id noise. */
const fmtError = (op: string, err: unknown): string => {
	const msg = err instanceof Error ? err.message : String(err);
	return /Unknown session/.test(msg) ? `${op}: ${t("session unavailable")}` : `${op}: ${msg}`;
};

/** Electron shell environment (has electronAPI daemon bridge). */
function isElectron(): boolean {
	return typeof window !== "undefined" && "electronAPI" in window;
}

/** Discover a running daemon's port (Electron shell only). */
async function probeDaemonPort(): Promise<number | null> {
	if (!isElectron()) return null;
	try {
		const { electronAPI } = window as unknown as { electronAPI: { probeDaemonPort(): Promise<number | null> } };
		const port = await electronAPI.probeDaemonPort();
		return typeof port === "number" && port > 0 ? port : null;
	} catch {
		return null;
	}
}

/** Launch `musepi serve --port` from the Electron shell. */
async function startDaemonViaShell(port: number): Promise<number> {
	const { electronAPI } = window as unknown as { electronAPI: { startDaemon(port: number): Promise<number> } };
	return await electronAPI.startDaemon(port);
}

/** Split a modelRoles value (`provider/id:level`) into the bare selector +
 * thinking level. "off"/known-level suffixes parse; no suffix → level null.
 * Returns undefined when the value is absent. */
function splitRoleValue(value: string | undefined): { model: string; level: string | null } | undefined {
	if (!value) return undefined;
	const colon = value.lastIndexOf(":");
	const suffix = colon > 0 ? value.slice(colon + 1) : "";
	if (suffix === "off" || (THINKING_LEVELS as readonly string[]).includes(suffix)) {
		return { model: value.slice(0, colon), level: suffix };
	}
	return { model: value, level: null };
}

/** session.list row fields the GUI tracks per session (metadata for the
 *  archive/sidebar + real-time working/unread status for reminders). */
interface SessionMetaRow {
	cwd?: string;
	model?: string;
	paused?: boolean;
	/** Live session with a running agent turn (kimi 进行中 parity). */
	working?: boolean;
	/** Session currently held by the daemon (subscribed or streaming). */
	live?: boolean;
	messageCount?: number;
	title?: string;
	timestamp?: string;
}

/** Collect every session id in a session tree (drift check for the poll:
 *  the sidebar tree must show exactly the sessions session.list knows). */
function collectTreeIds(nodes: GuiTreeNode[], out: Set<string>): void {
	for (const n of nodes) {
		out.add(n.entry.id);
		if (n.children.length > 0) collectTreeIds(n.children, out);
	}
}

function AppInner(): ReactNode {
	// Re-render the whole tree when the locale flips (i18n toggle parity —
	// t() reads the module-level locale, so without a subscription the
	// strings would only update on the next unrelated render).
	const [, bumpLocale] = useReducer(x => x + 1, 0);
	useEffect(() => subscribeLocale(() => bumpLocale()), []);

	// Apply persisted custom appearance (font scale / glass / bg tint) and
	// effect toggles (motion level / inline images / sound).
	useEffect(() => {
		try {
			const fs = localStorage.getItem("omp-gui-font-scale");
			if (fs) document.documentElement.style.setProperty("--gui-font-scale", `${fs}px`);
			// Glass transparency (slider value = transparency %) — migrates the
			// v1 scrim-coefficient pref once, then applies scrim + adaptive text.
			applyGlassLevel(readGlassLevel());
			// Window-transparency toggle OFF → opaque panes (overrides the slider).
			const glassEnabled = localStorage.getItem("omp-gui-glass-enabled") !== "0";
			if (!glassEnabled) {
				document.documentElement.style.setProperty("--gui-glass-overlay", "100%");
				document.documentElement.classList.remove("gui-glass-adaptive");
			}
			// Desktop shell: mirror the toggle + theme onto the native window
			// material (light scheme → bright vibrancy, dark → under-window).
			applyGlassMaterial(glassEnabled);
			const motion = localStorage.getItem("omp-gui-motion");
			if (motion === "off") document.documentElement.classList.add("gui-motion-off");
			else document.documentElement.classList.remove("gui-motion-off");
			if (localStorage.getItem("omp-gui-images") === "0") document.documentElement.classList.add("gui-no-images");
			else document.documentElement.classList.remove("gui-no-images");
			// Chat display prefs (settings → 聊天): applied as root classes so the
			// shared transcript CSS can hide/keep rows without prop drilling.
			const chat = (key: string, cls: string): void => {
				document.documentElement.classList.toggle(cls, localStorage.getItem(key) === "0");
			};
			chat("omp-gui-chat-time", "gui-chat-hide-time");
			chat("omp-gui-chat-rowactions", "gui-chat-hide-row-actions");
			chat("omp-gui-chat-codehl", "gui-chat-plain-code");
			chat("omp-gui-chat-thinking", "gui-chat-hide-thinking");
			chat("omp-gui-chat-caret", "gui-chat-no-caret");
			// gui-chat-no-smooth is NOT mapped here: 平滑流式 is controlled
			// solely by the daemon display.smoothStreaming setting (外观 →
			// 显示) since the chat tab merged into 外观 (2026-08-12). ChatView
			// syncs the class from settings.get, so the old localStorage key
			// must not re-apply a stale value at startup.
			// Output style preset (settings → 聊天 → 输出风格): the same key
			// the segmented picker writes, mirrored onto <html> at startup so
			// the choice survives relaunches.
			const outputStyle = localStorage.getItem("omp-gui-chat-output-style");
			document.documentElement.dataset.outputStyle =
				outputStyle === "kimi" || outputStyle === "zcode" ? outputStyle : "default";
			// Typing effect preset (settings → 聊天 → 逐字动效): NOT applied
			// here — effect classes now live on the streaming block's own
			// .tr-md root (Markdown.tsx reads the key per render), so finished
			// and historic messages always render plain text.
			// Code appearance prefs (settings → 外观 → 代码设置): root classes
			// for line numbers / long-line wrap; themes + size re-apply below.
			document.documentElement.classList.toggle(
				"gui-code-lines",
				localStorage.getItem("omp-gui-code-lines") !== "0",
			);
			document.documentElement.classList.toggle("gui-code-wrap", localStorage.getItem("omp-gui-code-wrap") === "1");
			// Font picks (--font-ui / --font-mono) + spacing density (--gui-density):
			// re-apply at startup so choices survive relaunches.
			applyAppearancePrefs();
			// Keep-awake (settings 常规 → 保持电脑运行): re-assert on launch —
			// the main process holds the powerSaveBlocker assertion only
			// while told to (cross-platform; no-op safe on any platform).
			if (localStorage.getItem("omp-gui-keep-awake") === "1") {
				void (
					window as unknown as { electronAPI?: { setKeepAwake?(v: boolean): Promise<unknown> } }
				).electronAPI?.setKeepAwake?.(true);
			}
		} catch {
			// storage unavailable
		}
	}, []);
	// The native window material follows the UI theme (light scheme = bright
	// vibrancy, dark = under-window): re-mirror whenever the theme module
	// flips the scheme knob on <html>. The pet window gets the scheme too —
	// it has no tokens.css and file:// storage events don't fire cross-
	// window, so the resolved data-theme is pushed over the pet bridge.
	useEffect(() => {
		const root = document.documentElement;
		const { electronAPI } = window as unknown as {
			electronAPI?: { petActivity?(payload: unknown): Promise<unknown> };
		};
		const observer = new MutationObserver(() => {
			applyGlassMaterial(localStorage.getItem("omp-gui-glass-enabled") !== "0");
			void electronAPI?.petActivity?.({
				theme: root.dataset.theme === "light" ? "light" : "dark",
			});
		});
		observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
		return () => observer.disconnect();
	}, []);
	const [url, setUrl] = useState<string>(() => {
		// Last successful connection wins (connect() persists it): a daemon on
		// a non-default port keeps working across app restarts.
		try {
			return localStorage.getItem("omp-gui-url") ?? DEFAULT_URL;
		} catch {
			return DEFAULT_URL;
		}
	});
	const [rpc, setRpc] = useState<RpcClient | null>(null);
	const [status, setStatus] = useState<"idle" | "connecting" | "open" | "closed">("idle");
	const [error, setError] = useState<string | null>(null);
	// Error banner sound (effects prefs → error): play once per error.
	const prevError = useRef<string | null>(null);
	useEffect(() => {
		if (error && error !== prevError.current) sfxFor("error");
		prevError.current = error;
	}, [error]);
	// Transient banner: auto-dismiss after a while so a failure that the
	// daemon recovered from never sticks until reload. A newer error resets
	// the timer; the manual × and successful session ops clear it sooner.
	const errorTimerRef = useRef<Timer | null>(null);
	useEffect(() => {
		if (!error) return;
		const id = setTimeout(() => setError(null), ERROR_BANNER_MS);
		errorTimerRef.current = id;
		return () => {
			clearTimeout(id);
		};
	}, [error]);
	const [tree, setTree] = useState<GuiTreeNode[]>([]);
	// Sessions with an undismissed completion (pet badge + persistent
	// bubble + sidebar 未读 marker + welcome reminders panel) — cleared
	// when the user opens the session. Seeded from localStorage, grown by
	// pet completions and the cursor-based derivation (message-count
	// growth past the last read count, kimi 实时提醒 parity).
	const [unreadSessions, setUnreadSessions] = useState<Set<string>>(() => {
		try {
			return new Set(JSON.parse(localStorage.getItem("omp-gui-unread") ?? "[]") as string[]);
		} catch {
			return new Set();
		}
	});
	const unreadSessionsRef = useRef<Set<string>>(new Set());
	unreadSessionsRef.current = unreadSessions;
	// Persist the unread set so the sidebar/reminders agree across
	// relaunches (single source, owned here).
	useEffect(() => {
		try {
			localStorage.setItem("omp-gui-unread", JSON.stringify([...unreadSessions]));
		} catch {
			// storage unavailable
		}
	}, [unreadSessions]);
	const treeRef = useRef<GuiTreeNode[]>([]);
	treeRef.current = tree;
	// refreshSessions 并发守卫: 多个 refresh 同时进行时(发送/删除/打开/标题事件
	// 交错), 只接受最新一轮的结果 — 否则慢的旧请求后完成会覆盖新状态 (已删会话
	// 残留在树里, 点击报 Unknown session)。
	const treeRefreshSeqRef = useRef(0);
	const metaRefreshSeqRef = useRef(0);
	/** session.list metadata keyed by id — folder display in the archive
	 *  view (ZCode), pause chips, and the real-time working/unread status
	 *  the sidebar + reminders panel derive from (kimi parity). */
	const [sessionMeta, setSessionMeta] = useState<Map<string, SessionMetaRow>>(new Map());
	const sessionMetaRef = useRef<Map<string, SessionMetaRow>>(new Map());
	sessionMetaRef.current = sessionMeta;
	// Per-session "last seen message count" — the source of truth for the
	// cursor-based unread derivation: a session whose count grew past the
	// last count the user had it open at is unread. Persisted so sessions
	// that completed while the app was closed still surface as reminders.
	const readCountRef = useRef<Map<string, number>>(new Map());
	const readCountLoadedRef = useRef(false);
	const readSeededRef = useRef(false);
	if (!readCountLoadedRef.current) {
		readCountLoadedRef.current = true;
		try {
			const raw = localStorage.getItem("omp-gui-read-count");
			if (raw) readCountRef.current = new Map(JSON.parse(raw) as [string, number][]);
			readSeededRef.current = localStorage.getItem("omp-gui-read-count-seeded") === "1";
		} catch {
			// storage unavailable
		}
	}
	const [selectedId, setSelectedId] = useState<string | null>(null);
	/** Process-global freeze (TUI `/pause` parity, daemon-wide): every session's
	 *  agents park until released. Drives the fullscreen frosted-glass overlay.
	 *  Orthogonal to per-session pauseInfo — releasing the global pause never
	 *  clears a session's own pause, and vice versa. */
	const [globalPause, setGlobalPause] = useState<{ paused: boolean; pausedAt: number | null }>({
		paused: false,
		pausedAt: null,
	});
	/** Selected session's freeze state (TUI `/pause` parity, per-session:
	 *  the daemon gates each session independently, so pausing one never
	 *  freezes the others). Synced via session.pauseStatus on open + the
	 *  session stream's pause-state envelopes. */
	const [pauseInfo, setPauseInfo] = useState<{ sessionId: string | null; paused: boolean; pausedAt: number | null }>({
		sessionId: null,
		paused: false,
		pausedAt: null,
	});
	const [store, setStore] = useState<GuiSessionStore | null>(null);
	const [connectError, setConnectError] = useState<string | null>(null);
	const [booting, setBooting] = useState(true);
	// Session-open loading overlay (React-Bits-style skeleton): armed by
	// openSession with a 150ms flicker threshold, cleared when the store
	// lands (or the open fails). MUST sit above the booting/connect early
	// returns below — a hook after them is skipped by the splash/connect
	// renders and throws "Rendered more hooks than during the previous
	// render" on the splash → full-app transition (Rules of Hooks).
	const [sessionLoading, setSessionLoading] = useState(false);
	const sessionLoadingTimerRef = useRef<Timer | null>(null);
	// Panel collapse (ZCode-style): side rail and context panel fold to thin
	// strips with a reopen button.
	const [sideCollapsed, setSideCollapsed] = useState(() => localStorage.getItem("omp-gui-side") === "0");
	const [sideWidth, setSideWidth] = useState<number>(() => Number(localStorage.getItem("omp-gui-side-w") ?? 256));
	const startResize = (which: "side" | "right", startX: number, startW: number, min: number, max: number): void => {
		const onMove = (e: MouseEvent): void => {
			const w = Math.min(max, Math.max(min, startW + (e.clientX - startX) * (which === "side" ? 1 : -1)));
			if (which === "side") {
				setSideWidth(w);
				localStorage.setItem("omp-gui-side-w", String(w));
			}
		};
		const onUp = (): void => {
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
			document.body.classList.remove("gui-resizing");
		};
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
		document.body.classList.add("gui-resizing");
	};
	const [rightCollapsed, setRightCollapsed] = useState(() => localStorage.getItem("omp-gui-right") === "0");
	const [project, setProject] = useState<string | null>(() => {
		try {
			return localStorage.getItem("omp-gui-project");
		} catch {
			return null;
		}
	});
	const [connectOpen, setConnectOpen] = useState(false);
	const [collabOpen, setCollabOpen] = useState(false);
	// daimon-canvas jump from chat: board id to open after the view swap.
	const [boardJumpId, setBoardJumpId] = useState<string | null>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [boardOpen, setBoardOpen] = useState(false);
	const [scheduledOpen, setScheduledOpen] = useState(false);
	// Cron-run notifications: poll cron.list while the app is up; a run that
	// finishes fires the standard completion/error notification + pet bubble,
	// and the sidebar 定时任务 button glows for a while (visible without any
	// notification permission).
	const [cronGlow, setCronGlow] = useState(false);
	const cronNotifiedRef = useRef<Set<string>>(new Set());
	const cronGlowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		const poll = (): void => {
			void rpc
				.request<{ runs?: { id: string; taskId: string; status: string; startedAt: number; error?: string }[] }>(
					"cron.list",
					{},
				)
				.then(res => {
					if (!alive) return;
					for (const run of res?.runs ?? []) {
						if (run.status === "running" || cronNotifiedRef.current.has(run.id)) continue;
						cronNotifiedRef.current.add(run.id);
						const taskName = run.taskId ?? t("scheduled tasks");
						if (run.status === "error") {
							dispatchNotification("error", {
								lastMessage: `${taskName}${run.error ? ` · ${run.error}` : ""}`,
							});
							dispatchPetActivity("error", `${taskName}${run.error ? ` · ${run.error}` : ""}`);
						} else {
							dispatchNotification("completion", {
								agentName: taskName,
								modelName: t("scheduled tasks"),
								lastMessage: taskName,
							});
							dispatchPetActivity("completed", `${t("scheduled tasks completed")}: ${taskName}`);
						}
						// Glow the sidebar 定时任务 button for 20s.
						setCronGlow(true);
						if (cronGlowTimerRef.current) clearTimeout(cronGlowTimerRef.current);
						cronGlowTimerRef.current = setTimeout(() => alive && setCronGlow(false), 20_000);
					}
				})
				.catch(() => {});
		};
		poll();
		const timer = setInterval(poll, 20_000);
		return () => {
			alive = false;
			clearInterval(timer);
			if (cronGlowTimerRef.current) clearTimeout(cronGlowTimerRef.current);
		};
	}, [rpc]);
	// Board / scheduled / chat surface swap with the same blur transition
	// as the board home ↔ collection swap (150ms leave blur, 300ms enter).
	const [leavingView, setLeavingView] = useState<"board" | "scheduled" | "chat" | null>(null);
	const swapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const viewSwapRef = useRef((_to: "board" | "scheduled" | "chat"): void => {});
	useEffect(() => {
		const onOpenBoard = (e: Event) => {
			const id = (e as CustomEvent<{ id?: string }>).detail?.id;
			if (!id) return;
			setBoardJumpId(id);
			viewSwapRef.current("board");
		};
		window.addEventListener("omp-open-board", onOpenBoard);
		return () => window.removeEventListener("omp-open-board", onOpenBoard);
	}, []);
	viewSwapRef.current = (to: "board" | "scheduled" | "chat"): void => {
		const from = boardOpen ? "board" : scheduledOpen ? "scheduled" : "chat";
		// A same-target call must still clear any stale leave state — a
		// leftover leavingView keeps the leave frame mounted at opacity 0
		// (forwards fill) and the surface appears blank.
		if (from === to) {
			setLeavingView(null);
			if (swapTimerRef.current) {
				clearTimeout(swapTimerRef.current);
				swapTimerRef.current = null;
			}
			return;
		}
		if (to !== "chat") setSettingsOpen(false);
		setLeavingView(from);
		if (swapTimerRef.current) clearTimeout(swapTimerRef.current);
		swapTimerRef.current = setTimeout(() => {
			setLeavingView(null);
			setBoardOpen(to === "board");
			setScheduledOpen(to === "scheduled");
		}, 150);
	};
	// Section the settings pane lands on (sidebar 技能 entry preselects).
	const [settingsSection, setSettingsSection] = useState<"skills" | undefined>(undefined);
	// Settings open/close rides the same blur transition as the board /
	// scheduled / chat swaps: the outgoing surface blurs out (150ms), then
	// the settings view (or the workspace) enters with its 300ms blur-in.
	const [leavingSettings, setLeavingSettings] = useState(false);
	const settingsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const openSettings = useCallback((): void => {
		if (settingsOpen) return;
		// Blur the current surface out first (leavingView keeps it mounted).
		setLeavingView(boardOpen ? "board" : scheduledOpen ? "scheduled" : "chat");
		clearTimeout(settingsTimerRef.current ?? undefined);
		settingsTimerRef.current = setTimeout(() => {
			settingsTimerRef.current = null;
			setLeavingView(null);
			setSettingsOpen(true);
		}, 150);
	}, [boardOpen, scheduledOpen, settingsOpen]);
	const closeSettings = useCallback((): void => {
		if (!settingsOpen || leavingSettings) return;
		setLeavingSettings(true);
		clearTimeout(settingsTimerRef.current ?? undefined);
		settingsTimerRef.current = setTimeout(() => {
			settingsTimerRef.current = null;
			setLeavingSettings(false);
			setSettingsOpen(false);
		}, 150);
	}, [settingsOpen, leavingSettings]);
	// Command palette (⌘K / sidebar 搜索): quick actions + session search.
	const [paletteOpen, setPaletteOpen] = useState(false);
	// Bottom integrated terminal drawer (ZCode style) — independent of the
	// right-pane terminal tool.
	const [bottomTerminal, setBottomTerminal] = useState(false);
	// Focus mode (openchamber): the composer expands to fill the surface.
	const [focusMode, setFocusMode] = useState(false);
	// Mini chat window (Electron mini-chat-open → ?mini=1): a chat-only
	// surface — no sidebar, header, or settings.
	const isMini = typeof location !== "undefined" && new URLSearchParams(location.search).get("mini") === "1";
	// Recent-sessions menu (visible while the sidebar is collapsed).
	// Run the project dev server in the bottom terminal dock.
	const [providerEvent, setProviderEvent] = useState<StreamEvent | null>(null);
	/** Model chosen in the welcome composer — applied to the new session and
	 *  reflected in the in-chat selector (preset). */
	const [presetModelId, setPresetModelId] = useState<string | null>(null);
	/** Boot snapshot of the session thinking default (modelRoles.default suffix,
	 *  else settings.defaultThinkingLevel incl. auto) — replaces the old
	 *  localStorage mirror so the schema keys stay the single source. */
	const [presetThinkingLevel, setPresetThinkingLevel] = useState<ThinkingLevel | null | undefined>(undefined);
	const bootRef = useRef(false);
	const rpcRef = useRef<RpcClient | null>(null);
	const storeRef = useRef<GuiSessionStore | null>(null);
	// Latest active-session tree label — read by the pet state pusher
	// (effect closure) without re-subscribing the effect per render.
	const activeLabelRef = useRef<string | null>(null);
	// Delete-confirmation dialog (settings 会话 toggle omp-gui-confirm-delete).
	const { confirm } = useConfirm();
	// Reconnect restoration: the open session id + re-open callback, kept in
	// refs so onStatus (wired before openSession exists) can reach them.
	const selectedIdRef = useRef<string | null>(null);
	const openSessionRef = useRef<(sessionId: string) => Promise<void>>(async () => {});

	// Keep refs for event handlers that must not re-subscribe per render.
	rpcRef.current = rpc;
	storeRef.current = store;

	// ── Connect to the daemon ──────────────────────────────────────────────
	/** Persist the per-session read cursors (best-effort; storage can be
	 *  unavailable in sandboxed contexts). */
	const persistReadCount = useCallback((): void => {
		try {
			localStorage.setItem("omp-gui-read-count", JSON.stringify([...readCountRef.current]));
		} catch {
			// storage unavailable
		}
	}, []);
	/** Cursor-based unread derivation (kimi 实时提醒 parity): a session is
	 *  unread once its message count grows past the last count the user had
	 *  it open at. Seeded on first sight so pre-existing sessions never
	 *  retroactively unread — only activity AFTER this feature exists marks
	 *  unread. The selected session is kept read while the user watches it. */
	const applyReadStatus = useCallback(
		(rows: ReadonlyArray<{ id: string; messageCount?: number }>): void => {
			if (!readSeededRef.current) {
				readCountRef.current = new Map(rows.map(r => [r.id, r.messageCount ?? 0]));
				readSeededRef.current = true;
				try {
					localStorage.setItem("omp-gui-read-count-seeded", "1");
				} catch {
					// storage unavailable
				}
				persistReadCount();
				return;
			}
			const selected = selectedIdRef.current;
			const seen = new Set<string>();
			const grew: string[] = [];
			for (const r of rows) {
				seen.add(r.id);
				const count = r.messageCount ?? 0;
				const prev = readCountRef.current.get(r.id) ?? 0;
				if (count <= prev) continue;
				readCountRef.current.set(r.id, count);
				if (r.id !== selected) grew.push(r.id);
			}
			// Prune read-cursors of deleted sessions.
			for (const id of [...readCountRef.current.keys()]) {
				if (!seen.has(id)) readCountRef.current.delete(id);
			}
			if (grew.length > 0) {
				persistReadCount();
				setUnreadSessions(prev => {
					if (grew.every(id => prev.has(id))) return prev;
					const next = new Set(prev);
					for (const id of grew) next.add(id);
					return next;
				});
			}
		},
		[persistReadCount],
	);
	/** 一键已读 (reminders panel + pet badge): every session is read up to
	 *  its current message count; the unread set clears. Also dismisses the
	 *  pet's completion/error bubbles for those sessions — the badge and
	 *  the bubbles track the same signal, so clearing one must clear both
	 *  (read 闭环), or the bubbles linger after 全部已读. */
	const markAllRead = useCallback((): void => {
		for (const [id, meta] of sessionMetaRef.current) {
			if (typeof meta.messageCount === "number") readCountRef.current.set(id, meta.messageCount);
		}
		persistReadCount();
		const ids = [...unreadSessionsRef.current];
		if (ids.length === 0) return;
		try {
			const api = (window as unknown as { electronAPI?: { petActivity?(p: unknown): Promise<unknown> } })
				.electronAPI;
			if (petEnabled() && petMode() === "desktop") {
				void api?.petActivity?.({ dismissSessions: ids });
			}
		} catch {
			// pet bridge unavailable — bubbles just stay until dismissed
		}
		setUnreadSessions(new Set());
	}, [persistReadCount]);
	/** Sidebar context-menu toggle (标记为已读/未读) — manual override that
	 *  survives until the session is opened or marked read. */
	const toggleUnread = useCallback((sessionId: string): void => {
		setUnreadSessions(prev => {
			const next = new Set(prev);
			if (next.has(sessionId)) next.delete(sessionId);
			else next.add(sessionId);
			return next;
		});
	}, []);

	const refreshSessions = useCallback(
		async (client: RpcClient): Promise<void> => {
			// Session tree (OMP /tree) — non-fatal on daemons without it.
			const tSeq = ++treeRefreshSeqRef.current;
			try {
				const nodes = await client.request<GuiTreeNode[]>("session.tree");
				if (tSeq !== treeRefreshSeqRef.current) return;
				setTree(nodes ?? []);
			} catch {
				if (tSeq !== treeRefreshSeqRef.current) return;
				setTree([]);
			}
			// Metadata (cwd/model/status per session) — powers the archive
			// folder column, pause chips, and the working/unread derivation.
			const mSeq = ++metaRefreshSeqRef.current;
			try {
				const rows = await client.request<Array<SessionMetaRow & { id: string }>>("session.list");
				const list = rows ?? [];
				if (mSeq !== metaRefreshSeqRef.current) return;
				setSessionMeta(
					new Map(
						list.map(r => [
							r.id,
							{
								cwd: r.cwd,
								model: r.model,
								paused: r.paused === true,
								working: r.working === true,
								live: r.live === true,
								messageCount: r.messageCount ?? 0,
								title: r.title,
								timestamp: r.timestamp,
							},
						]),
					),
				);
				applyReadStatus(list);
			} catch {
				if (mSeq !== metaRefreshSeqRef.current) return;
				setSessionMeta(new Map());
			}
		},
		[applyReadStatus],
	);
	// Real-time session status (kimi 实时提醒 parity): poll session.list so
	// the sidebar's 进行中 dot and the welcome reminders panel track sessions
	// working in the background (streaming turns, cron runs), and the
	// cursor-based unread derivation catches message growth the pet bubbles
	// never see (sessions completed while the app was closed). One light RPC
	// per 5s; sessionMeta only merges when a tracked field actually changed.
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		let lastKey = "";
		const poll = (): void => {
			void rpc
				.request<Array<SessionMetaRow & { id: string }>>("session.list")
				.then(rows => {
					if (!alive) return;
					const list = rows ?? [];
					const key = JSON.stringify(
						list.map(r => [r.id, r.working === true, r.live === true, r.messageCount ?? 0, r.paused === true]),
					);
					if (key === lastKey) return;
					lastKey = key;
					setSessionMeta(prev => {
						const next = new Map(prev);
						for (const r of list) {
							const row = next.get(r.id) ?? {};
							next.set(r.id, {
								...row,
								working: r.working === true,
								live: r.live === true,
								messageCount: r.messageCount ?? 0,
								paused: r.paused === true,
								title: r.title ?? row.title,
								timestamp: r.timestamp ?? row.timestamp,
								cwd: r.cwd ?? row.cwd,
							});
						}
						return next;
					});
					applyReadStatus(list);
					// Tree sync: session.list is the freshest source of which
					// sessions exist. If its id set drifts from the sidebar
					// tree's (a session created or deleted outside this window,
					// or a refresh raced), refresh the tree so it never shows
					// stale rows the user can click into an error.
					const ids = new Set<string>();
					for (const r of list) ids.add(r.id);
					const treeIds = new Set<string>();
					collectTreeIds(treeRef.current, treeIds);
					let drift = ids.size !== treeIds.size;
					if (!drift) {
						for (const id of ids) {
							if (!treeIds.has(id)) {
								drift = true;
								break;
							}
						}
					}
					if (drift) void refreshSessions(rpc);
				})
				.catch(() => {});
		};
		poll();
		const timer = setInterval(poll, 5_000);
		return () => {
			alive = false;
			clearInterval(timer);
		};
	}, [rpc, applyReadStatus, refreshSessions]);

	const connect = useCallback(
		async (targetUrl: string): Promise<boolean> => {
			setError(null);
			setConnectError(null);
			setStatus("connecting");
			const client = new RpcClient(targetUrl);
			rpcRef.current = client;
			client.onStatus = phase => {
				if (phase === "closed") setStatus("closed");
				else if (phase === "connecting") setStatus("connecting");
				else if (phase === "open") {
					setStatus("open");
					// Reconnect (daemon restart / machine sleep): clear the stale
					// error bar, refresh the session tree, and re-open the session
					// that was showing (openchamber parity — the UI comes back to
					// the live session instead of a dead snapshot).
					setError(null);
					void refreshSessions(client);
					const active = selectedIdRef.current;
					if (active) void openSessionRef.current?.(active);
				}
			};
			// Route subscription envelopes to the active session store; provider
			// auth/prompt envelopes surface through the settings dialog instead.
			client.onEvent = (event: StreamEvent) => {
				if (event.kind === "global-pause-state") {
					const payload = event.payload as { paused?: boolean; pausedAt?: number | null };
					setGlobalPause({ paused: payload.paused === true, pausedAt: payload.pausedAt ?? null });
					return;
				}
				if (event.kind === "pause-state") {
					// Envelopes only arrive for the subscribed (selected)
					// session, so the state belongs to it.
					const payload = event.payload as { paused?: boolean; pausedAt?: number | null };
					setPauseInfo({
						sessionId: selectedIdRef.current,
						paused: payload.paused === true,
						pausedAt: payload.pausedAt ?? null,
					});
					// Keep the sidebar badge live for the selected row.
					setSessionMeta(prev => {
						const id = selectedIdRef.current;
						if (!id) return prev;
						const next = new Map(prev);
						const row = next.get(id) ?? {};
						next.set(id, { ...row, paused: payload.paused === true });
						return next;
					});
					return;
				}
				if (event.kind.startsWith("provider-")) {
					setProviderEvent(event);
					return;
				}
				// Auto-generated session title landed (async after the first user
				// message — TUI parity): the session-tree label changed, so the
				// sidebar/header must refresh to show it.
				if (event.kind === "title") {
					void refreshSessions(client);
					return;
				}
				// Desktop notifications (kimi-code/openchamber parity): the
				// agent turn completing and approval requests. Gated by the
				// notifications setting (omp-gui-notify).
				const payload = event.payload as
					| { type?: string; message?: { role?: string; content?: unknown } }
					| undefined;
				if (event.kind === "approval-request") {
					storeRef.current?.apply(event);
					return;
				}
				if (payload?.type === "turn_end") {
					storeRef.current?.apply(event);
					return;
				}
				storeRef.current?.apply(event);
			};
			try {
				await client.connect();
			} catch (err) {
				setStatus("idle");
				const message = err instanceof Error ? err.message : String(err);
				setConnectError(message);
				// Re-throw so auto-connect callers can distinguish success from
				// failure and try the next candidate.
				throw new Error(message);
			}
			client.run();
			setRpc(client);
			localStorage.setItem("omp-gui-url", targetUrl);
			// Fetch the session list; errors (unknown method) are non-fatal on
			// older daemons — surface but keep the connection.
			try {
				const meta = await client.request<{ version: string; engine: string }>("system.meta");
				void meta;
			} catch (err) {
				setError(fmtError("system.meta", err));
			}
			await refreshSessions(client);
			// Subscribe to the process-global freeze state (daemon-wide
			// pause overlay; also returns the current value on boot).
			try {
				const st = await client.request<{ paused: boolean; pausedAt: number | null }>("daemon.pauseStatus");
				if (st) setGlobalPause({ paused: st.paused === true, pausedAt: st.pausedAt ?? null });
			} catch {
				// older daemon without the RPC — global pause stays hidden
			}
			// Per-session freeze state syncs on session open (openSession →
			// session.pauseStatus), so the header/banner render correctly for
			// the selected session; nothing global to fetch here.
			// Welcome-composer preselect = the TUI default model (modelRoles.default),
			// so the GUI agrees with the TUI /model panel on new sessions. Same
			// call also pulls the daemon interface language (settings.locale) and
			// the thinking default — both are config.yml-backed single sources
			// (F1/F2 audit fixes, 2026-08-11); the renderer mirrors them locally.
			try {
				const res = await client.request<{
					modelRoles?: Record<string, string>;
					"settings.locale"?: string;
					defaultThinkingLevel?: string;
				}>("settings.get", {
					keys: ["modelRoles", "settings.locale", "defaultThinkingLevel"],
				});
				const dflt = res?.defaultThinkingLevel;
				const dfltLevel =
					dflt === "auto" || (THINKING_LEVELS as readonly string[]).includes(dflt ?? "")
						? (dflt as ThinkingLevel)
						: undefined;
				if (res?.modelRoles?.default) {
					const role = splitRoleValue(res.modelRoles.default);
					// Bare selector for the model preselect; the thinking suffix
					// feeds the thinking preselect (null → inherit → falls back
					// to the configured defaultThinkingLevel; "off" → off).
					if (role) {
						setPresetModelId(role.model);
						setPresetThinkingLevel(
							role.level === null ? dfltLevel : role.level === "off" ? null : (role.level as ThinkingLevel),
						);
					} else {
						setPresetModelId(res.modelRoles.default);
					}
				} else {
					setPresetThinkingLevel(dfltLevel);
				}
				const locale = res?.["settings.locale"];
				if (locale === "zh-CN" || locale === "en-US") setLocale(locale);
			} catch {
				// settings RPC unavailable (older daemon) — localStorage fallback stands
			}
			return true;
		},
		[refreshSessions],
	);

	// ── Boot: like opencode's desktop — the shell owns the daemon lifecycle.
	// LoadingSplash shows while we try the default URL, then (Electron) probe
	// for a running daemon, then spawn one via daemon-start. Only if all that
	// fails does the error page (with manual entry as advanced option) appear.
	const boot = useCallback(async (): Promise<void> => {
		setBooting(true);
		setConnectError(null);
		// Splash hold: the entrance animation (logo settle 620ms + wordmark
		// blur-in ~330ms ≈ 950ms) should always be seen, and a COLD start
		// (daemon spawned just now) needs extra cover while the daemon
		// prewarms the lazy SDK module graph. A WARM start (daemon already
		// running — the default URL or a probed port connects in ~300ms)
		// only holds for the animation itself, so relaunches feel instant
		// instead of a fixed 2s stare (2026-08-11 fixed hold).
		const t0 = performance.now();
		let coldStart = false;
		// The daemon prewarms the lazy SDK module graph in the background
		// (startDaemon). Hold the splash until it reports ready so the FIRST
		// session.create / session.resume — right after the daemon was
		// spawned — never pays the ~4s import cost. Non-fatal: an older
		// daemon without the RPC (or a failed prewarm) just proceeds and the
		// first session op pays the cost as before.
		const waitForPrewarm = async (): Promise<void> => {
			const client = rpcRef.current;
			if (!client) return;
			const deadline = Date.now() + 8_000;
			for (;;) {
				try {
					const st = await client.request<{ ready?: boolean }>("system.prewarmStatus");
					if (st?.ready === true) return;
				} catch {
					return; // older daemon without the RPC — nothing to wait for
				}
				if (Date.now() >= deadline) return;
				await new Promise(resolve => setTimeout(resolve, 300));
			}
		};
		const tryUrl = async (u: string): Promise<boolean> => {
			try {
				await connect(u);
				await waitForPrewarm();
				return true;
			} catch {
				return false;
			}
		};
		try {
			if ((await tryUrl(url)) === true) return;
			// Electron shell: discover a running daemon, else spawn one.
			if (isElectron()) {
				const port = await probeDaemonPort();
				if (port && (await tryUrl(`ws://127.0.0.1:${port}`)) === true) return;
				try {
					coldStart = true;
					const spawned = await startDaemonViaShell(8300);
					if (await tryUrl(`ws://127.0.0.1:${spawned}`)) return;
					// The spawn returned a port but the first WebSocket handshake
					// raced the listener; retry once before giving up.
					await new Promise(resolve => setTimeout(resolve, 400));
					if (await tryUrl(`ws://127.0.0.1:${spawned}`)) return;
				} catch (err) {
					setConnectError(err instanceof Error ? err.message : String(err));
				}
			}
		} finally {
			const holdMs = coldStart ? 2000 : 1100;
			const elapsed = performance.now() - t0;
			if (elapsed < holdMs) {
				const { promise, resolve } = Promise.withResolvers<void>();
				setTimeout(resolve, holdMs - elapsed);
				await promise;
			}
			setBooting(false);
		}
	}, [connect, url]);

	useEffect(() => {
		if (bootRef.current) return;
		bootRef.current = true;
		void boot();
	}, [boot]);

	const disconnect = useCallback((): void => {
		storeRef.current?.dispose();
		storeRef.current = null;
		setStore(null);
		setSelectedId(null);
		selectedIdRef.current = null;
		setPauseInfo({ sessionId: null, paused: false, pausedAt: null });
		rpcRef.current?.close();
		rpcRef.current = null;
		setRpc(null);
		setStatus("idle");
	}, []);

	// ── Session selection → subscribe ──────────────────────────────────────
	const openSession = useCallback(
		async (sessionId: string): Promise<void> => {
			// Session switch sound (page flip) — only when another session was open.
			if (storeRef.current) sfxFor("switch");
			const client = rpcRef.current;
			if (!client) return;
			// A new user action supersedes any stale failure banner — if this
			// open fails too, the error below re-surfaces it.
			setError(null);
			// Entering a session leaves the board/scheduled view — but ONLY
			// after the session data is ready: swapping first would render the
			// chat frame (welcome or the previous session) until the new store
			// arrives, flashing an empty intermediate. The swap happens right
			// before the new store mounts, so the blur transition lands
			// directly on the session view.
			// Keep the CURRENT store mounted while the next session loads — a
			// null intermediate flips ChatView to the welcome scene (empty→chat
			// animation) on every session switch. Only on failure do we fall
			// back to the welcome state.
			const previous = storeRef.current;
			// Cursor-based read markers: the session being left was read up to
			// its current count at the moment of the switch (otherwise the poll
			// would mark it unread with a ≤5s-stale cursor); the incoming
			// session is read by definition.
			const metaNow = sessionMetaRef.current;
			const prevId = selectedIdRef.current;
			if (prevId && prevId !== sessionId) {
				const prevCount = metaNow.get(prevId)?.messageCount;
				if (typeof prevCount === "number") readCountRef.current.set(prevId, prevCount);
			}
			const openCount = metaNow.get(sessionId)?.messageCount;
			if (typeof openCount === "number") readCountRef.current.set(sessionId, openCount);
			persistReadCount();
			setSelectedId(sessionId);
			selectedIdRef.current = sessionId;
			// Session-open loading overlay (React-Bits-style skeleton): history
			// sessions are reactivated on demand and the RPC can take seconds on
			// a cold open — show the skeleton only when the wait actually
			// exceeds the flicker threshold, clear it when the store lands.
			if (sessionLoadingTimerRef.current !== null) clearTimeout(sessionLoadingTimerRef.current);
			sessionLoadingTimerRef.current = setTimeout(() => setSessionLoading(true), 150);
			setUnreadSessions(prev => {
				if (!prev.has(sessionId)) return prev;
				const next = new Set(prev);
				next.delete(sessionId);
				// Opening the session marks its notifications read — tell the
				// bubble window to dismiss that session's completion/error
				// bubbles (they persist until read; this is the read 闭环).
				try {
					const api = (window as unknown as { electronAPI?: { petActivity?(p: unknown): Promise<unknown> } })
						.electronAPI;
					if (petEnabled() && petMode() === "desktop") {
						void api?.petActivity?.({ dismissSessions: [sessionId] });
					}
				} catch {
					// pet bridge unavailable — bubbles just stay until dismissed
				}
				return next;
			});
			// The previous session's pause state must never leak into the new one.
			setPauseInfo({ sessionId, paused: false, pausedAt: null });
			try {
				// Live sessions subscribe (streaming); history sessions resume
				// (snapshot-only, no live stream). Both return the same snapshot
				// shape, so one store path serves both.
				let initial: { entries: unknown[]; state?: unknown; cursor: number; header?: { cwd?: string } } | null =
					null;
				try {
					const res = await client.request<{
						stream: string | null;
						initial: { entries: unknown[]; state?: unknown; cursor: number; header?: { cwd?: string } };
					}>("session.subscribe", { sessionId });
					initial = res.initial;
				} catch {
					// Unknown session (history) — fall back to resume.
					const res = await client.request<{
						snapshot: { entries: unknown[]; state?: unknown; cursor: number; header?: { cwd?: string } };
					}>("session.resume", { sessionId });
					initial = res.snapshot;
				}
				const cwd =
					typeof (initial as { header?: { cwd?: unknown } } | null)?.header?.cwd === "string"
						? (initial as { header: { cwd: string } }).header.cwd
						: "";
				// Preselect the session's current model (live: state.model; history:
				// the persisted header.model choice) so the composer selector shows
				// what the session actually uses instead of the welcome default.
				const header = (initial as { header?: { model?: string; title?: string } } | null)?.header;
				const state = (initial as { state?: { model?: { id?: string; provider?: string } } } | null)?.state;
				const sessionModel =
					header?.model ?? (state?.model?.id ? `${state.model.provider}/${state.model.id}` : null);
				if (sessionModel) setPresetModelId(sessionModel);
				previous?.dispose();
				const next = new GuiSessionStore(
					sessionId,
					{
						entries: (initial?.entries ?? []) as never,
						state: initial?.state as never,
						cursor: initial?.cursor ?? 0,
						roundDurations: (initial as { roundDurations?: [number, number][] } | null)?.roundDurations,
					},
					cwd,
				);
				storeRef.current = next;
				setStore(next);
				// View swap deferred to here: the chat frame renders with the
				// new session content already mounted (no welcome flash).
				viewSwapRef.current("chat");
				// Cold-open skeleton cleared the moment the store mounts.
				if (sessionLoadingTimerRef.current !== null) {
					clearTimeout(sessionLoadingTimerRef.current);
					sessionLoadingTimerRef.current = null;
				}
				setSessionLoading(false);
				// its pause-state envelopes via the live stream).
				try {
					const st = await client.request<{ paused: boolean; pausedAt: number | null }>("session.pauseStatus", {
						sessionId,
					});
					if (st) {
						setPauseInfo({ sessionId, paused: st.paused === true, pausedAt: st.pausedAt ?? null });
						setSessionMeta(prev => {
							const row = prev.get(sessionId) ?? {};
							const next = new Map(prev);
							next.set(sessionId, { ...row, paused: st.paused === true });
							return next;
						});
					}
				} catch {
					// older daemon without pause RPC — header button stays hidden
				}
			} catch (err) {
				// Load failed: dispose the stale store and return to welcome.
				if (sessionLoadingTimerRef.current !== null) {
					clearTimeout(sessionLoadingTimerRef.current);
					sessionLoadingTimerRef.current = null;
				}
				setSessionLoading(false);
				previous?.dispose();
				storeRef.current = null;
				setStore(null);
				setSelectedId(null);
				selectedIdRef.current = null;
				// Still leave the board on failure — the error shows in chat.
				viewSwapRef.current("chat");
				// The failing session may have been deleted while the tree was
				// stale — refresh so its row disappears instead of erroring on
				// every click (the 5s poll would catch it eventually; this is
				// immediate).
				void refreshSessions(client);
				setError(fmtError("session.open", err));
			}
		},
		[persistReadCount, refreshSessions],
	);
	openSessionRef.current = openSession;

	const togglePause = useCallback(async (): Promise<void> => {
		const client = rpcRef.current;
		const sessionId = selectedIdRef.current;
		if (!client || !sessionId) return;
		setError(null);
		try {
			if (pauseInfo.paused && pauseInfo.sessionId === sessionId) {
				const res = await client.request<{ duration: number | null; paused: boolean }>("session.pauseRelease", {
					sessionId,
				});
				if (res) setPauseInfo({ sessionId, paused: res.paused === true, pausedAt: null });
			} else {
				const res = await client.request<{ paused: boolean; pausedAt: number | null }>("session.pause", {
					sessionId,
				});
				if (res) setPauseInfo({ sessionId, paused: res.paused === true, pausedAt: res.pausedAt ?? null });
			}
		} catch (err) {
			setError(fmtError("pause", err));
		}
	}, [pauseInfo.paused, pauseInfo.sessionId]);

	const toggleGlobalPause = useCallback(async (): Promise<void> => {
		const client = rpcRef.current;
		if (!client) return;
		setError(null);
		try {
			if (globalPause.paused) {
				const res = await client.request<{ duration: number | null; paused: boolean }>("daemon.pauseRelease");
				if (res) setGlobalPause({ paused: res.paused === true, pausedAt: null });
			} else {
				const res = await client.request<{ paused: boolean; pausedAt: number | null }>("daemon.pause");
				if (res) setGlobalPause({ paused: res.paused === true, pausedAt: res.pausedAt ?? null });
			}
		} catch (err) {
			setError(fmtError("global pause", err));
		}
	}, [globalPause.paused]);

	// Auto session cleanup (Settings → 会话 → 自动清理): runs in the app
	// shell so it survives the settings panel closing — hourly check, at
	// most one run per 24h (cooldown parity), only while the pref is on.
	useEffect(() => {
		if (!rpc || !cleanupEnabled()) return;
		let lastRun = 0;
		const tick = (): void => {
			if (!cleanupEnabled()) return;
			if (Date.now() - lastRun < 86_400_000) return;
			lastRun = Date.now();
			void (async () => {
				const ids = await cleanupCandidates(rpc, cleanupDays(), selectedIdRef.current);
				if (ids.length > 0) await runCleanupOnce(rpc, ids, cleanupAction());
			})();
		};
		const id = setInterval(tick, 3_600_000);
		return () => clearInterval(id);
	}, [rpc]);

	const createSession = useCallback(
		async (opts?: {
			thinkingLevel?: string | null;
			modelId?: string | null;
			cwd?: string | null;
			planMode?: boolean;
			goalMode?: string | null;
		}): Promise<string | null> => {
			const client = rpcRef.current;
			if (!client) return null;
			setError(null);
			try {
				// The ZCode project picker chooses the workspace folder — it
				// becomes the session cwd so 按项目 groups by it.}
				const res = await client.request<{ sessionId: string }>("session.create", {
					...(opts?.cwd ? { cwd: opts.cwd } : {}),
					// Settings → 会话 → 自动生成会话标题: off keeps the session
					// title generic instead of falling back to the first message.
					autoTitle: localStorage.getItem("omp-gui-autotitle") !== "0",
				});
				// Carry the welcome-composer choices onto the new session.
				if (opts?.thinkingLevel) {
					await client
						.request("session.setThinkingLevel", {
							sessionId: res.sessionId,
							thinkingLevel: opts.thinkingLevel,
						})
						.catch(() => {});
				}
				if (opts?.modelId) {
					setPresetModelId(opts.modelId);
					await client
						.request("session.setModel", { sessionId: res.sessionId, model: { id: opts.modelId } })
						.catch(() => {});
				}
				// Welcome plan/goal: apply the mode right after creation so
				// the new session opens in that mode (chip in the status row).
				if (opts?.planMode === true) {
					await client.request("session.setPlan", { sessionId: res.sessionId }).catch(() => {});
				}
				if (opts?.goalMode) {
					await client
						.request("session.setGoal", { sessionId: res.sessionId, objective: opts.goalMode })
						.catch(() => {});
				}
				await refreshSessions(client);
				await openSession(res.sessionId);
				return res.sessionId;
			} catch (err) {
				setError(fmtError("session.create", err));
				return null;
			}
		},
		[openSession, refreshSessions],
	);

	/** New task = empty composer awaiting the first prompt (TUI-like): the
	 *  session is only created when the message is sent. */
	const startNewTask = useCallback((): void => {
		viewSwapRef.current("chat");
		storeRef.current?.dispose();
		storeRef.current = null;
		setStore(null);
		setSelectedId(null);
		selectedIdRef.current = null;
	}, []);

	/** Remote workspace (ConnectDialog step 3): open a session rooted at the
	 *  mounted remote directory. The mount path is an ordinary local path, so
	 *  the session + tools work on it unchanged. */
	const handleOpenRemoteWorkspace = useCallback(
		(cwd: string): void => {
			setConnectOpen(false);
			void createSession({ cwd });
		},
		[createSession],
	);

	const sendPrompt = useCallback(
		async (
			text: string,
			images?: { type: "image"; data: string; mimeType: string }[],
			sessionId?: string,
			deliverAs?: "prompt" | "steer" | "followUp",
		): Promise<void> => {
			const client = rpcRef.current;
			const id = sessionId ?? selectedId;
			if (!client || !id) return;
			setError(null);
			try {
				// Refresh the tree/metadata right after the daemon ACCEPTS the
				// message — a first message creates the session, and the sidebar
				// must show it immediately (the awaited RPC blocks until the
				// whole turn completes, so hook the refresh to the send ack
				// instead of after the await, or the row appears only later).
				const p = client.request("session.send", {
					sessionId: id,
					text,
					...(deliverAs ? { deliverAs } : {}),
					...(images && images.length > 0 ? { images } : {}),
				});
				p.then(() => refreshSessions(client)).catch(() => {});
				await p;
			} catch (err) {
				setError(fmtError("session.send", err));
			}
		},
		[selectedId, refreshSessions],
	);

	const stop = useCallback(async (): Promise<void> => {
		const client = rpcRef.current;
		const id = selectedId;
		if (!client || !id) return;
		sfxFor("stop");
		setError(null);
		try {
			await client.request("session.abort", { sessionId: id });
		} catch (err) {
			setError(fmtError("session.abort", err));
		}
	}, [selectedId]);

	// Welcome-page submission shared by the mini and main views: create the
	// session, then either send the prompt or — when the text is a slash
	// command (TUI parity) — execute it headlessly on the fresh session.
	// Command output surfaces via the pet bubble + desktop notification
	// (the in-session composer note is the Composer's job).
	const submitNewSession = useCallback(
		async (
			text: string,
			opts?: {
				thinkingLevel?: ThinkingLevel | null;
				modelId?: string | null;
				images?: { type: "image"; data: string; mimeType: string }[];
				planMode?: boolean;
				goalMode?: boolean;
			},
		): Promise<void> => {
			const isSlash = text.startsWith("/") && !text.startsWith("//");
			const bangBody = text.startsWith("!") ? (text.startsWith("!!") ? text.slice(2) : text.slice(1)).trim() : "";
			const isBang = text.startsWith("!") && bangBody.length > 0;
			const client = rpcRef.current;
			const id = await createSession({
				thinkingLevel: opts?.thinkingLevel ?? undefined,
				modelId: opts?.modelId ?? undefined,
				cwd: project,
				planMode: opts?.planMode === true,
				// Slash/bash commands never become goals (the command runs instead).
				goalMode: opts?.goalMode === true && !isSlash && !isBang ? text : null,
			});
			if (!id) return;
			if (isBang) {
				// "!cmd" / "!!cmd" (TUI parity): run the shell command on the
				// fresh session; the daemon appends the result to its
				// transcript and model context (!! excludes it).
				if (!client) return;
				void client
					.request<{
						exitCode: number | null;
						cancelled: boolean;
						totalLines: number;
						outputTruncated: boolean;
						output: string;
					}>("session.bashCommand", { sessionId: id, command: text })
					.then(res => {
						if (!res) return;
						if (res.cancelled) {
							dispatchPetActivity("error", t("bash command cancelled"));
							return;
						}
						const summary = t("bash exited with code {code} ({lines} lines)", {
							code: res.exitCode === null ? "?" : String(res.exitCode),
							lines: String(res.totalLines),
						});
						dispatchPetActivity(res.exitCode === 0 ? "completed" : "error", summary);
						dispatchNotification("completion", { lastMessage: summary });
					})
					.catch(() => dispatchPetActivity("error", t("bash command failed")));
				return;
			}
			if (isSlash) {
				if (!client) return;
				void client
					.request<{ consumed: boolean; reason?: string; prompt?: string; outputs?: string[] }>(
						"session.slashCommand",
						{ sessionId: id, text },
					)
					.then(res => {
						if (!res?.consumed) {
							const msg =
								res?.reason === "tui-only"
									? t("this command only works in the terminal")
									: res?.reason === "skill-not-found"
										? t("skill not found")
										: t("unknown slash command");
							dispatchPetActivity("error", msg);
							return;
						}
						const out = (res.outputs ?? []).filter(Boolean).join("\n");
						if (out) {
							dispatchPetActivity("completed", out.slice(0, 200));
							dispatchNotification("completion", { lastMessage: out.slice(0, 140) });
						}
						if (res.prompt) void sendPrompt(res.prompt, undefined, id);
					})
					.catch(() => {});
				return;
			}
			await sendPrompt(text, opts?.images, id);
		},
		[createSession, project, sendPrompt],
	);

	/** Persist a user-set session title (daemon session.rename), then
	 *  refresh the tree so the new label lands everywhere at once. */
	const renameSession = useCallback(
		(sessionId: string, title: string): void => {
			const client = rpcRef.current;
			if (!client) return;
			void client
				.request("session.rename", { sessionId, title })
				.then(() => refreshSessions(client))
				.catch(() => {});
		},
		[refreshSessions],
	);

	const decideApproval = useCallback(
		async (requestId: string, approved: boolean): Promise<void> => {
			const client = rpcRef.current;
			const id = selectedId;
			const current = storeRef.current;
			if (!client || !id || !current) return;
			setError(null);
			try {
				await client.request(approved ? "tool.approve" : "tool.deny", { sessionId: id, requestId });
				current.dismissApproval(requestId);
			} catch (err) {
				setError(fmtError(approved ? "tool.approve" : "tool.deny", err));
			}
		},
		[selectedId],
	);

	/** Permanently delete a session (journal + index) and refresh the tree;
	 *  resets the UI when the deleted session was the active one. The
	 *  confirm dialog honors the settings toggle (omp-gui-confirm-delete). */
	const deleteSession = useCallback(
		async (sessionId: string): Promise<boolean> => {
			const client = rpcRef.current;
			if (!client) return false;
			try {
				if (localStorage.getItem("omp-gui-confirm-delete") !== "0") {
					const ok = await confirm(t("confirm delete session"));
					if (!ok) return false;
				}
				await client.request("session.delete", { sessionId });
				// Drop the deleted session's frozen round totals.
				clearRoundDurations(sessionId);
				// Refresh the tree/metadata views (delete may affect nesting).
				await refreshSessions(client);
				if (storeRef.current?.sessionId === sessionId) {
					storeRef.current?.dispose();
					storeRef.current = null;
					setStore(null);
					setSelectedId(null);
				}
				return true;
			} catch {
				return false;
			}
		},
		[confirm, refreshSessions],
	);

	// ── Agent companion pet bridge (伙伴): forward the live session mood
	// and activity bubbles to the floating pet window over Electron IPC.
	// Pref changes (settings page dispatches omp-pet-changed) show/hide the
	// window; the pet window asks for a fresh snapshot when it appears. ──
	useEffect(() => {
		const electronAPI = (
			window as unknown as {
				electronAPI?: {
					petActivity?(payload: unknown): Promise<unknown>;
					setPetVisible?(visible: boolean): Promise<unknown>;
					onPetStateRequest?(cb: () => void): () => void;
					onPetOpenSession?(cb: (sessionId: string) => void): () => void;
					onTrayOpenSession?(cb: (sessionId: string) => void): () => void;
					onTrayNewSession?(cb: () => void): () => void;
					onPetGetSessionContent?(cb: (sessionId: string) => void): () => void;
					petSessionContent?(payload: unknown): Promise<unknown>;
					onPetCommand?(
						cb: (cmd: {
							type: string;
							text?: string;
							sessionId?: string;
							requestId?: string;
							approved?: boolean;
						}) => void,
					): () => void;
					computerGlow?(on: boolean): Promise<unknown>;
					glowTarget?(input: unknown): Promise<unknown>;
				};
			}
		).electronAPI;
		if (!electronAPI?.petActivity) return;
		let lastMood: string | null = null;
		let lastStatePush = 0;
		const textOf = (content: unknown): string =>
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content.map(b => (b as { text?: string }).text ?? "").join("\n")
					: "";
		const pushState = (force = false): void => {
			if (!petEnabled() || petMode() !== "desktop") return;
			const snap = store?.getSnapshot();
			if (!snap) return;
			const now = Date.now();
			if (!force && now - lastStatePush < 1_000) return;
			lastStatePush = now;
			// Latest active tool + last assistant text (≤80 chars) — the
			// pet panel's "what is the agent doing" summary.
			const tools = [...snap.activeTools.values()];
			const toolName = tools.length > 0 ? tools[tools.length - 1].toolName : null;
			let lastMessage: string | null = null;
			for (let i = snap.entries.length - 1; i >= 0; i--) {
				const e = snap.entries[i];
				if (e.type === "message" && e.message?.role === "assistant") {
					const body = textOf(e.message.content).trim();
					if (body) {
						lastMessage = body.length > 80 ? `${body.slice(0, 80)}…` : body;
						break;
					}
				}
			}
			void electronAPI.petActivity?.({
				state: {
					working: snap.working,
					streaming: snap.streaming,
					toolName,
					lastMessage,
					sessionTitle: activeLabelRef.current,
				},
				// The pet window cannot read this window's localStorage —
				// carry the locale so its panel strings match the UI, and the
				// resolved scheme so its chrome follows light/dark.
				locale: getLocaleSnapshot(),
				theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
			});
		};
		const pushMood = (): void => {
			if (!petEnabled() || petMode() !== "desktop") return;
			const snap = store?.getSnapshot();
			if (!snap) return;
			const mood = moodFromState({
				working: snap.working,
				streaming: snap.streaming,
				hasApprovals: snap.approvals.length > 0,
			});
			if (mood !== lastMood) {
				lastMood = mood;
				void electronAPI.petActivity?.({ mood });
			}
		};
		let unsub: (() => void) | null = null;
		// Computer-use glow latch — the subscribe callback runs on every
		// snapshot; only push the IPC when the computer tool's running
		// state actually flips (the activeTools map changes per tool frame).
		let glowOn = false;
		// computer.glow setting (default on) — cached here; the settings
		// page dispatches "omp-glow-setting" after toggling to force a
		// re-read on the next snapshot.
		let glowEnabled = true;
		let glowFetched = false;
		// Last computer input event forwarded to the glow overlay (the
		// subscribe callback fires on every snapshot; dedupe by content).
		let lastGlowInput: string | null = null;
		const onGlowSetting = (): void => {
			glowFetched = false;
		};
		window.addEventListener("omp-glow-setting", onGlowSetting);
		const attach = (): void => {
			unsub?.();
			if (store) {
				unsub = store.subscribe(() => {
					pushMood();
					pushState();
					const snap = store?.getSnapshot();
					const tools = [...(snap?.activeTools?.values() ?? [])];
					const hasComputer = tools.some(t => t.toolName === "computer");
					// Fetch the glow setting once the rpc is up; keep the
					// latch from showing the overlay when it's disabled.
					if (!glowFetched) {
						const r = rpcRef.current;
						if (r) {
							glowFetched = true;
							void r
								.request<Record<string, unknown>>("settings.get", { keys: ["computer.glow"] })
								.then(v => {
									glowEnabled = v?.["computer.glow"] !== false;
								})
								.catch(() => {});
						}
					}
					if (glowEnabled && hasComputer !== glowOn) {
						glowOn = hasComputer;
						void electronAPI.computerGlow?.(hasComputer);
					} else if (!glowEnabled && glowOn) {
						glowOn = false;
						void electronAPI.computerGlow?.(false);
					}
					// Computer input events arrive as tool updates carrying
					// only details.inputEvents — forward each new one to the
					// glow overlay so it highlights the operation target.
					const latest = tools.findLast(t => t.toolName === "computer")?.partialResult as
						| { details?: { inputEvents?: unknown[] } }
						| undefined;
					const input = latest?.details?.inputEvents?.[0];
					if (input) {
						const key = JSON.stringify(input);
						if (key !== lastGlowInput) {
							lastGlowInput = key;
							void electronAPI.glowTarget?.(input);
						}
					}
				});
			}
		};
		attach();
		const onBubble = (e: Event): void => {
			if (!petEnabled() || petMode() !== "desktop") return;
			const detail = (
				e as CustomEvent<{ kind: PetBubbleKind; text: string; requestId?: string; sessionId?: string }>
			).detail;
			// Completion notifications keep the pet bubble + badge until the
			// user opens that session (or dismisses the bubble). The session
			// the user is actively reading is never "unread" (kimi parity —
			// the cursor-based derivation keeps its read cursor current).
			if (
				(detail.kind === "completed" || detail.kind === "error") &&
				detail.sessionId &&
				detail.sessionId !== selectedIdRef.current
			) {
				setUnreadSessions(prev => {
					if (prev.has(detail.sessionId!)) return prev;
					const next = new Set(prev);
					next.add(detail.sessionId!);
					return next;
				});
			}
			void electronAPI.petActivity?.({
				bubble: {
					kind: detail.kind,
					text: detail.text,
					requestId: detail.requestId,
					// Carry the session so the bubble click can open it
					// directly (and the bubble window can dismiss it as read).
					sessionId: detail.sessionId,
				},
				unreadCount: unreadSessionsRef.current.size,
			});
			// Question bubbles carry the approval requestId — surface the
			// approval card in the pet panel too.
			if (detail.kind === "question" && detail.requestId) {
				void electronAPI.petActivity?.({ approval: { requestId: detail.requestId, tool: detail.text } });
			}
		};
		const onPetChanged = (): void => {
			const want = petEnabled() && petMode() === "desktop";
			void electronAPI.setPetVisible?.(want);
			if (!want) {
				lastMood = null;
			} else {
				pushMood();
				pushState(true);
				// Size slider changes live in the pet window too (the pet
				// window cannot hear localStorage writes from this window).
				void electronAPI.petActivity?.({ scale: petScale() });
			}
		};
		// Recent-session list for the pet panel: derive from the tree (top 6
		// by timestamp) and push on tree change + a light 15s poll.
		const pushRecent = (): void => {
			if (!petEnabled() || petMode() !== "desktop") return;
			const walk = (nodes: GuiTreeNode[]): { id: string; label: string; timestamp: number }[] => {
				const rows: { id: string; label: string; timestamp: number }[] = [];
				for (const n of nodes) {
					rows.push({
						id: n.entry.id,
						label: n.entry.label ?? n.label ?? "",
						timestamp: new Date(n.entry.timestamp).getTime(),
					});
					rows.push(...walk(n.children));
				}
				return rows;
			};
			const rows = walk(treeRef.current)
				.sort((a, b) => b.timestamp - a.timestamp)
				.slice(0, 6);
			void electronAPI.petActivity?.({ recentSessions: rows, unreadCount: unreadSessionsRef.current.size });
		};
		pushRecent();
		const recentTimer = setInterval(pushRecent, 15_000);
		// Pet panel "recent session" click → open it here.
		const unsubPetOpen = electronAPI.onPetOpenSession?.(sessionId => {
			if (typeof sessionId !== "string") return;
			void openSessionRef.current(sessionId);
		});
		// Menu-bar tray (openchamber parity): session row → open it; the
		// "New Session" item → create one (same path as the welcome button).
		const unsubTrayOpen = electronAPI.onTrayOpenSession?.(sessionId => {
			if (typeof sessionId !== "string") return;
			void openSessionRef.current(sessionId);
		});
		const unsubTrayNew = electronAPI.onTrayNewSession?.(() => {
			void createSession();
		});
		window.addEventListener("omp-pet-activity", onBubble);
		window.addEventListener("omp-pet-changed", onPetChanged);
		const unsubReq = electronAPI.onPetStateRequest?.(() => {
			lastMood = null; // force a resend
			lastStatePush = 0;
			pushMood();
			pushState(true);
		});
		// Pet-panel commands: quick reply → the active session (same
		// steer/followUp semantics as the composer); with no active session
		// the reply creates one, exactly like the welcome composer's first
		// message. Approval decision → tool.approve/tool.deny.
		const unsubCmd = electronAPI.onPetCommand?.(cmd => {
			if (cmd.type === "reply" && typeof cmd.text === "string" && cmd.text.trim()) {
				const text = cmd.text;
				if (storeRef.current) {
					void sendPrompt(text, undefined, cmd.sessionId ?? selectedIdRef.current ?? undefined);
				} else {
					void createSession().then(id => {
						if (id) void sendPrompt(text, undefined, id);
					});
				}
			} else if (cmd.type === "approve" && cmd.requestId) {
				void decideApproval(cmd.requestId, cmd.approved === true);
			} else if (cmd.type === "mark-read" && typeof cmd.sessionId === "string") {
				// Pet bubble ×: the user acknowledged that notification —
				// clear the session's unread badge and advance its read
				// cursor so the next poll does not immediately re-mark it
				// (new activity on the session would, correctly, re-add).
				const id = cmd.sessionId;
				const meta = sessionMetaRef.current.get(id);
				if (meta && typeof meta.messageCount === "number") readCountRef.current.set(id, meta.messageCount);
				persistReadCount();
				setUnreadSessions(prev => {
					if (!prev.has(id)) return prev;
					const next = new Set(prev);
					next.delete(id);
					return next;
				});
			} else if (cmd.type === "mark-all-read") {
				// Pet badge click: clear every unread session (badge + the
				// pet's completion/error bubbles in one action).
				markAllRead();
			}
		});
		// Pet panel "recent session" click → return that session's transcript
		// (text-only) so the panel can show it in place. Data comes from the
		// same session.subscribe/resume snapshot the ChatView uses; the main
		// window itself does NOT switch sessions for this.
		const unsubGetContent = electronAPI.onPetGetSessionContent?.(sessionId => {
			if (typeof sessionId !== "string") return;
			void (async () => {
				const client = rpcRef.current;
				if (!client) return;
				let initial: { entries: unknown[] } | null = null;
				try {
					const res = await client.request<{ stream: string | null; initial: { entries: unknown[] } }>(
						"session.subscribe",
						{ sessionId },
					);
					initial = res.initial;
				} catch {
					try {
						const res = await client.request<{ snapshot: { entries: unknown[] } }>("session.resume", {
							sessionId,
						});
						initial = res.snapshot;
					} catch {
						return;
					}
				}
				const messages: Array<{ role: string; text: string }> = [];
				for (const e of initial?.entries ?? []) {
					const entry = e as { type?: string; message?: { role?: string; content?: unknown } };
					if (entry.type !== "message" || !entry.message) continue;
					const role = entry.message.role;
					if (role !== "user" && role !== "assistant") continue;
					const text = textOf(entry.message.content).trim();
					if (text) messages.push({ role, text: text.length > 600 ? `${text.slice(0, 600)}…` : text });
				}
				void electronAPI.petSessionContent?.({
					sessionId,
					messages: messages.slice(-60),
					loaded: true,
				});
			})();
		});
		onPetChanged(); // initial visibility sync
		return () => {
			unsub?.();
			unsubReq?.();
			unsubCmd?.();
			unsubGetContent?.();
			unsubPetOpen?.();
			unsubTrayOpen?.();
			unsubTrayNew?.();
			clearInterval(recentTimer);
			window.removeEventListener("omp-pet-activity", onBubble);
			window.removeEventListener("omp-pet-changed", onPetChanged);
			window.removeEventListener("omp-glow-setting", onGlowSetting);
		};
	}, [store, sendPrompt, decideApproval, createSession, markAllRead, persistReadCount]);

	// ── Window shortcuts (settings → 快捷键 reference). ──────────────────
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (!e.metaKey && !e.ctrlKey) {
				if (e.key === "Escape") {
					// openchamber: Escape leaves focus mode first.
					if (focusMode) setFocusMode(false);
					else void stop();
				}
				return;
			}
			const mod = e.metaKey || e.ctrlKey;
			const k = e.key.toLowerCase();
			if (mod && e.shiftKey && k === "l") {
				// openchamber selection→ask: pop the ask popover for the
				// current non-composer selection (interpret/explain it in a
				// throwaway turn, never touching the transcript).
				e.preventDefault();
				const text = captureSelectionText();
				if (text) {
					const sel = window.getSelection();
					const rect = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).getBoundingClientRect() : null;
					window.dispatchEvent(
						new CustomEvent("omp-gui-ask", {
							detail: {
								text,
								x: rect ? rect.left + rect.width / 2 : window.innerWidth / 2,
								y: rect ? rect.top : window.innerHeight / 2,
							},
						}),
					);
				}
			} else if (mod && k === "l") {
				// openchamber Cursor-style Cmd+L: quote the current
				// selection into the composer — the SAME quote-card style
				// as the toolbar 引用 button (append-only, stacked cards).
				// With no selection, focus the composer instead.
				e.preventDefault();
				const text = captureSelectionText();
				if (text) {
					window.dispatchEvent(new CustomEvent("omp-gui-quote-append", { detail: { text } }));
				} else {
					(document.querySelector('[data-chat-input="true"] textarea') as HTMLTextAreaElement | null)?.focus();
				}
			} else if (mod && k === "k") {
				e.preventDefault();
				setPaletteOpen(v => !v);
			} else if (mod && k === "o") {
				e.preventDefault();
				void pickDirectory().then(dir => {
					if (dir) {
						setProject(dir);
						localStorage.setItem("omp-gui-project", dir);
						// Sidebar projects tab contract: surface the picked folder.
						window.dispatchEvent(new CustomEvent("omp-gui-project-added", { detail: dir }));
					}
				});
			} else if (mod && k === "b") {
				e.preventDefault();
				setSideCollapsed(v => {
					localStorage.setItem("omp-gui-side", v ? "1" : "0");
					return !v;
				});
			} else if (mod && k === "j") {
				e.preventDefault();
				setBottomTerminal(v => !v);
			} else if (mod && k === "n") {
				e.preventDefault();
				startNewTask();
			} else if (mod && k === ",") {
				e.preventDefault();
				openSettings();
			} else if (mod && e.shiftKey && k === "e") {
				// openchamber ⌘⇧E: focus mode (composer fills the surface).
				e.preventDefault();
				setFocusMode(v => !v);
			} else if (mod && !e.shiftKey && k === "e") {
				e.preventDefault();
				setRightCollapsed(v => {
					localStorage.setItem("omp-gui-right", v ? "1" : "0");
					return !v;
				});
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [startNewTask, stop, focusMode]);

	// ── Boot / error page (opencode-style: splash while starting, error
	// only when the local daemon can't be reached at all) ───────────────
	// Splash gates on `booting` ALONE — not `!rpc && booting`: rpc connects
	// in ~150ms on a warm daemon and would unmount the splash mid-hold,
	// defeating MIN_SPLASH_MS (2026-08-11).
	if (booting) {
		return (
			<div className="gui-shell">
				<div className="gui-splash">
					{/* Launch splash (reactbits parity): logo settles with a
					 * glow bloom, then keeps a slow pulse; the wordmark
					 * blurs in char-by-char and a shine band sweeps the
					 * tagline. gui-motion-off kills all of it (static). */}
					<div className="gui-splash-inner">
						<img src={logoUrl} alt="MusePi" className="gui-splash-logo" draggable={false} />
						<BlurText text="MusePi" className="gui-splash-wordmark" stepMs={55} />
						<ShinyText
							text={t("your desktop coding agent")}
							className="gui-splash-tagline"
							speed={3.4}
							shineColor="var(--color-accent)"
						/>
					</div>
				</div>
			</div>
		);
	}
	if (!rpc) {
		return (
			<div className="gui-shell">
				<div className="gui-connect-wrap">
					<div className="gui-brand">
						<span className="gui-brand-mark">π</span> MusePi
					</div>
					<p className="gui-connect-sub">{t("cannot reach the local daemon")}</p>
					<button
						className="gui-btn gui-btn-primary"
						type="button"
						disabled={status === "connecting"}
						onClick={() => void boot()}
					>
						{t("retry")}
					</button>
					{status === "connecting" && <p className="gui-note">{t("connecting…")}</p>}
					{connectError && <p className="gui-error">{connectError}</p>}
					{error && <p className="gui-error">{error}</p>}
					<details className="gui-connect-advanced">
						<summary>{t("manual connection")}</summary>
						<form
							className="gui-connect-form"
							onSubmit={e => {
								e.preventDefault();
								void connect(url.trim()).catch(() => {
									// error already surfaced via connectError
								});
							}}
						>
							<input
								className="gui-input"
								type="text"
								value={url}
								onChange={e => setUrl(e.target.value)}
								placeholder="ws://127.0.0.1:8300"
								spellCheck={false}
								autoComplete="off"
							/>
							<button className="gui-btn" type="submit" disabled={status === "connecting"}>
								{t("Connect")}
							</button>
						</form>
					</details>
				</div>
				<div className="gui-connect-toggles">
					<ThemeToggle />
					<AccentToggle />
					<LanguageToggle />
				</div>
			</div>
		);
	}

	// ── Main: immersive three-pane layout with a persistent window toolbar
	// (opencode style): pane toggles live on the toolbar so they never hide
	// with the pane they control; the blank toolbar drags the window.
	// Recent sessions for the header switcher (openchamber
	// SessionSwitcherDropdown parity), newest first.
	const recentSessions = ((): { id: string; label: string; timestamp: number }[] => {
		const rows: { id: string; label: string; timestamp: number }[] = [];
		const walk = (nodes: GuiTreeNode[]): void => {
			for (const n of nodes) {
				rows.push({
					id: n.entry.id,
					label: n.entry.label ?? n.label ?? "",
					timestamp: new Date(n.entry.timestamp).getTime(),
				});
				walk(n.children);
			}
		};
		walk(tree);
		return rows.sort((a, b) => b.timestamp - a.timestamp).slice(0, 10);
	})();
	// Welcome-scene reminders (kimi 实时提醒 parity): sessions currently
	// working in the background (进行中) first, then completed-but-unread
	// ones. Derived from the polled session.list status + the unread set —
	// the tree labels lag cron-created sessions, so rows come from
	// sessionMeta, not the tree. Plain IIFE (like recentSessions): this
	// sits AFTER the booting/connect early returns, so a hook here would
	// violate the Rules of Hooks on the first render (splash skips it).
	// (The session-open loading overlay state used below lives above the
	// early returns with the other session state — see its declaration.)
	const reminders = ((): ReminderRow[] => {
		const rows: ReminderRow[] = [];
		for (const [id, meta] of sessionMeta) {
			if (id === selectedId) continue;
			const working = meta.working === true && meta.paused !== true;
			const unread = unreadSessions.has(id);
			if (!working && !unread) continue;
			rows.push({
				id,
				title: meta.title?.trim() || t("untitled session"),
				timestamp: meta.timestamp ? new Date(meta.timestamp).getTime() : 0,
				working,
				unread,
				project: meta.cwd ? meta.cwd.split(/[\\/]/).filter(Boolean).pop() : undefined,
			});
		}
		rows.sort((a, b) => Number(b.working) - Number(a.working) || b.timestamp - a.timestamp);
		return rows.slice(0, 20);
	})();
	// Tree label of the active session — the header shows it so renames
	// stick (the message-stream fallback cannot see renamed titles).
	const activeSessionLabel = ((): string | null => {
		if (!selectedId) return null;
		const find = (nodes: GuiTreeNode[]): string | null => {
			for (const n of nodes) {
				if (n.entry.id === selectedId) return n.entry.label ?? n.label ?? null;
				const hit = find(n.children);
				if (hit !== null) return hit;
			}
			return null;
		};
		return find(tree);
	})();
	activeLabelRef.current = activeSessionLabel;
	// Remote-workspace badge: the session's cwd lives under the daemon's
	// sshfs mount dir (~/.musepi/remote/<host>/…) — the header shows a
	// 远程 chip so a remote session is never mistaken for a local one.
	const activeSessionRemote = ((): boolean => {
		const cwd = sessionMeta.get(selectedId ?? "")?.cwd;
		if (!cwd) return false;
		return /(^|[\\/])\.musepi[\\/]remote[\\/]/.test(cwd);
	})();
	// ── Mini chat window (?mini=1): the SAME boot/connect/session wiring,
	// rendered as a chat-only surface — a slim drag strip on top, then
	// ChatView full-bleed (transcript + composer, no sidebar/header).
	if (isMini) {
		const miniTitle = ((): string => {
			if (!store) return t("MusePi");
			const snap = store.getSnapshot();
			const first = snap.entries.find(
				e => e.type === "message" && (e as { message?: { role?: string } }).message?.role === "user",
			);
			if (first) {
				const content = (first as { message?: { content?: unknown } }).message?.content;
				if (typeof content === "string" && content.trim()) return content.trim().slice(0, 40);
			}
			return snap.state?.cwd?.split("/").pop() ?? t("session");
		})();
		return (
			<div className="gui-shell gui-shell--mini">
				{error && (
					<div className="gui-error gui-error-bar" role="alert">
						<span className="gui-error-bar-text">{error}</span>
						<button
							type="button"
							className="gui-error-bar-x"
							title={t("dismiss")}
							aria-label={t("dismiss")}
							onClick={() => setError(null)}
						>
							<Icon name="close" className="h-3 w-3" />
						</button>
					</div>
				)}
				{/* Window chrome: slim draggable strip (traffic lights ride
				 * above it at x16,y17) with the session title small. */}
				<div className="gui-mini-drag" aria-hidden>
					<span className="gui-mini-title">{miniTitle}</span>
				</div>
				<div className="gui-mini-chat relative flex min-h-0 min-w-0 flex-1 flex-col">
					<ChatView
						store={store}
						rpc={rpc}
						onSend={(text, images, deliverAs) => void sendPrompt(text, images, undefined, deliverAs)}
						onStop={stop}
						onDecideApproval={decideApproval}
						onReloadSession={() => (selectedId ? openSession(selectedId) : undefined)}
						onForkSession={async forkId => {
							await refreshSessions(rpc);
							await openSession(forkId);
						}}
						presetModelId={presetModelId}
						presetThinkingLevel={presetThinkingLevel}
						busy={status === "connecting"}
						paused={pauseInfo.sessionId === selectedId && pauseInfo.paused}
						pausedAt={pauseInfo.sessionId === selectedId ? pauseInfo.pausedAt : null}
						onResume={() => void togglePause()}
						project={project}
						onProject={action => {
							if (action === "remote") {
								setConnectOpen(true);
							} else if (action === "folder") {
								void pickDirectory().then(dir => {
									if (dir) {
										setProject(dir);
										localStorage.setItem("omp-gui-project", dir);
										window.dispatchEvent(new CustomEvent("omp-gui-project-added", { detail: dir }));
									}
								});
							} else if (action === "none") {
								// "不在项目中": clear the workspace chip — never open the picker.
								setProject(null);
								localStorage.removeItem("omp-gui-project");
							} else {
								// A saved workspace picked from the list — switch to it.
								setProject(action);
								localStorage.setItem("omp-gui-project", action);
							}
						}}
						onSubmitNewSession={(text, opts) => void submitNewSession(text, opts)}
						rightPanelOpen={false}
						terminalOpen={false}
						focusMode={focusMode}
						onToggleFocus={() => setFocusMode(v => !v)}
						reminders={reminders}
						onSelectReminder={id => void openSession(id)}
						onMarkAllRead={markAllRead}
						sessionLoading={sessionLoading}
					/>
				</div>
				<ConnectDialog
					open={connectOpen}
					onClose={() => setConnectOpen(false)}
					rpc={rpc}
					onOpenWorkspace={handleOpenRemoteWorkspace}
				/>
			</div>
		);
	}

	return (
		<div className="gui-shell">
			{error && (
				<div className="gui-error gui-error-bar" role="alert">
					<span className="gui-error-bar-text">{error}</span>
					<button
						type="button"
						className="gui-error-bar-x"
						title={t("dismiss")}
						aria-label={t("dismiss")}
						onClick={() => setError(null)}
					>
						<Icon name="close" className="h-3 w-3" />
					</button>
				</div>
			)}
			{settingsOpen ? (
				/* Full-window settings view replaces the workspace (ZCode),
				 * with the same blur transition as the view swaps: leave =
				 * blur-out (closing), enter = blur-in (opening). */
				<div className={leavingSettings ? "gui-view-leave" : "gui-view-enter"}>
					<SettingsView
						rpc={rpc}
						sessionId={store?.sessionId ?? null}
						providerEvent={providerEvent}
						initialSection={settingsSection}
						onBack={closeSettings}
						cwd={sessionMeta.get(store?.sessionId ?? "")?.cwd}
						onOpenSession={sessionId => {
							closeSettings();
							void openSession(sessionId);
						}}
					/>
				</div>
			) : (
				/* openchamber-style shell: a full-width immersive toolbar riding
				 * the top edge, the three panes below it sharing its surface
				 * (no divider, same frosted tint). */
				<div className="gui-main relative flex min-h-0 flex-1">
					{!sideCollapsed && (
						<div
							className="gui-resize-x gui-resize-x--side"
							style={{ left: sideWidth - 3 }}
							onMouseDown={e => {
								e.preventDefault();
								startResize("side", e.clientX, sideWidth, 180, 420);
							}}
						/>
					)}
					<SessionSidebar
						nodes={tree}
						sessionMeta={sessionMeta}
						selectedId={selectedId}
						onSelect={id => void openSession(id)}
						onNewSession={startNewTask}
						status={status === "open" ? "open" : "closed"}
						onDisconnect={disconnect}
						onOpenConnect={() => setConnectOpen(true)}
						onOpenBoard={() => viewSwapRef.current("board")}
						boardActive={boardOpen}
						onOpenScheduled={() => viewSwapRef.current("scheduled")}
						scheduledActive={scheduledOpen}
						cronGlow={cronGlow}
						onOpenSettings={openSettings}
						onOpenCollab={() => setCollabOpen(true)}
						onRenameSession={renameSession}
						onOpenSearch={() => setPaletteOpen(true)}
						unread={unreadSessions}
						onToggleUnread={toggleUnread}
						onOpenSkills={() => {
							setSettingsSection("skills");
							openSettings();
						}}
						onPickFolder={() => {
							void pickDirectory().then(dir => {
								if (dir) {
									setProject(dir);
									localStorage.setItem("omp-gui-project", dir);
									// Sidebar projects tab contract: surface the picked folder.
									window.dispatchEvent(new CustomEvent("omp-gui-project-added", { detail: dir }));
								}
							});
						}}
						collapsed={sideCollapsed}
						width={sideWidth}
						onDeleteArchived={deleteSession}
					/>
					<div className="gui-chat-col relative flex min-w-0 flex-1 flex-col">
						<GuiHeader
							store={store}
							rpc={rpc}
							sideCollapsed={sideCollapsed}
							onToggleSidebar={() => {
								setSideCollapsed(v => {
									localStorage.setItem("omp-gui-side", v ? "1" : "0");
									return !v;
								});
							}}
							paused={pauseInfo.sessionId === selectedId && pauseInfo.paused}
							pausedAt={pauseInfo.sessionId === selectedId ? pauseInfo.pausedAt : null}
							onTogglePause={() => void togglePause()}
							pauseDisabled={selectedId === null}
							globalPaused={globalPause.paused}
							onToggleGlobalPause={() => void toggleGlobalPause()}
							onNewSession={startNewTask}
							onOpenBoard={() => viewSwapRef.current("board")}
							onOpenSettings={openSettings}
							terminalOpen={bottomTerminal}
							onToggleTerminal={() => setBottomTerminal(v => !v)}
							rightPanelOpen={!rightCollapsed}
							onToggleRightPanel={() => {
								setRightCollapsed(v => {
									localStorage.setItem("omp-gui-right", v ? "1" : "0");
									return !v;
								});
							}}
							project={project}
							onOpenFolder={() => {
								void pickDirectory().then(dir => {
									if (dir) {
										setProject(dir);
										localStorage.setItem("omp-gui-project", dir);
									}
								});
							}}
							sessions={recentSessions}
							onSelectSession={id => void openSession(id)}
							onRenameSession={renameSession}
							sessionLabel={activeSessionLabel}
							remote={activeSessionRemote}
							connected={status === "open"}
							daemonUrl={url}
							onReconnect={() => void boot()}
							onRestartDaemon={() => {
								// Instance menu 重启 daemon: Electron main kills the
								// current listener and spawns fresh code, then the
								// boot chain reconnects (the daemon is detached —
								// GUI relaunch alone never refreshes it).
								const port = Number(/:(?<p>\d+)$/.exec(url)?.groups?.p) || 8300;
								void restartDaemon(port).then(ok => {
									if (ok !== null) void boot();
								});
							}}
							onOpenCollab={() => setCollabOpen(true)}
							onDeleteSession={deleteSession}
						/>
						{(() => {
							const chatSurface = (
								<ChatView
									store={store}
									rpc={rpc}
									onSend={(text, images, deliverAs) => void sendPrompt(text, images, undefined, deliverAs)}
									onStop={stop}
									onDecideApproval={decideApproval}
									onReloadSession={() => (selectedId ? openSession(selectedId) : undefined)}
									onForkSession={async forkId => {
										await refreshSessions(rpc);
										await openSession(forkId);
									}}
									presetModelId={presetModelId}
									presetThinkingLevel={presetThinkingLevel}
									busy={status === "connecting"}
									paused={pauseInfo.sessionId === selectedId && pauseInfo.paused}
									pausedAt={pauseInfo.sessionId === selectedId ? pauseInfo.pausedAt : null}
									onResume={() => void togglePause()}
									project={project}
									onProject={action => {
										if (action === "remote") {
											setConnectOpen(true);
										} else if (action === "none") {
											// "不在项目中": clear the workspace chip — never open the picker.
											setProject(null);
											localStorage.removeItem("omp-gui-project");
										} else if (action === "folder") {
											void pickDirectory().then(dir => {
												if (dir) {
													setProject(dir);
													localStorage.setItem("omp-gui-project", dir);
													// Sidebar projects tab contract: surface the picked folder.
													window.dispatchEvent(new CustomEvent("omp-gui-project-added", { detail: dir }));
												}
											});
										} else {
											// A saved workspace picked from the list — switch to it.
											setProject(action);
											localStorage.setItem("omp-gui-project", action);
										}
									}}
									onSubmitNewSession={(text, opts) => void submitNewSession(text, opts)}
									rightPanelOpen={!rightCollapsed}
									onOpenFileInPanel={() => {
										setRightCollapsed(false);
									}}
									terminalOpen={bottomTerminal}
									onCloseTerminal={() => setBottomTerminal(false)}
									focusMode={focusMode}
									onToggleFocus={() => setFocusMode(v => !v)}
									reminders={reminders}
									onSelectReminder={id => void openSession(id)}
									onMarkAllRead={markAllRead}
									sessionLoading={sessionLoading}
								/>
							);
							return leavingView === "board" ? (
								/* Leaving board → chat: the board surface stays
								 * mounted for its blur-out, then chat enters. */
								<div className="gui-view-leave">
									<div className="gui-chat-col relative flex min-w-0 flex-1 flex-col">
										<div className="gui-chat-surface gui-pixel-reveal m-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-[var(--color-surface)] shadow-[0_4px_24px_rgba(0,0,0,0.25)]">
											<BoardPage
												onBack={() => viewSwapRef.current("chat")}
												rpc={rpc}
												cwd={project ?? undefined}
												jumpId={boardJumpId}
												onJumpConsumed={() => setBoardJumpId(null)}
												onChatCreate={text => {
													// 对话创建 (kimi parity): leave the board and prompt the
													// agent to design boards; with text, create a session and
													// send it right away.
													viewSwapRef.current("chat");
													const trimmed = text.trim();
													if (!trimmed) {
														startNewTask();
														return;
													}
													const prompt = `${trimmed}。请把这些组件放进一个新看板（用 board 工具 save）。`;
													void createSession({ cwd: project }).then(id => {
														if (id) void sendPrompt(prompt, undefined, id);
													});
												}}
											/>
										</div>
									</div>
								</div>
							) : boardOpen ? (
								/* Board view replaces the chat surface only — the
								 * sidebar stays (kimi Work tab parity). */
								<div className="gui-view-enter">
									<div className="gui-chat-col relative flex min-w-0 flex-1 flex-col">
										<div className="gui-chat-surface gui-pixel-reveal m-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-[var(--color-surface)] shadow-[0_4px_24px_rgba(0,0,0,0.25)]">
											<BoardPage
												onBack={() => viewSwapRef.current("chat")}
												rpc={rpc}
												cwd={project ?? undefined}
												jumpId={boardJumpId}
												onJumpConsumed={() => setBoardJumpId(null)}
												onChatCreate={text => {
													// 对话创建 (kimi parity): leave the board and prompt the
													// agent to design boards; with text, create a session and
													// send it right away.
													viewSwapRef.current("chat");
													const trimmed = text.trim();
													if (!trimmed) {
														startNewTask();
														return;
													}
													const prompt = `${trimmed}。请把这些组件放进一个新看板（用 board 工具 save）。`;
													void createSession({ cwd: project }).then(id => {
														if (id) void sendPrompt(prompt, undefined, id);
													});
												}}
											/>
										</div>
									</div>
								</div>
							) : leavingView === "scheduled" ? (
								/* Leaving scheduled → chat/board: scheduled blurs out first. */
								<div className="gui-view-leave">
									<div className="gui-chat-col relative flex min-w-0 flex-1 flex-col">
										<div className="gui-chat-surface gui-pixel-reveal m-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-[var(--color-surface)] shadow-[0_4px_24px_rgba(0,0,0,0.25)]">
											<ScheduledTasksPage
												rpc={rpc}
												onBack={() => viewSwapRef.current("chat")}
												onOpenSession={id => void openSession(id)}
											/>
										</div>
									</div>
								</div>
							) : scheduledOpen ? (
								/* Scheduled tasks view (kimi cron page parity). */
								<div className="gui-view-enter">
									<div className="gui-chat-col relative flex min-w-0 flex-1 flex-col">
										<div className="gui-chat-surface gui-pixel-reveal m-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-[var(--color-surface)] shadow-[0_4px_24px_rgba(0,0,0,0.25)]">
											<ScheduledTasksPage
												rpc={rpc}
												onBack={() => viewSwapRef.current("chat")}
												onOpenSession={id => void openSession(id)}
											/>
										</div>
									</div>
								</div>
							) : leavingView === "chat" ? (
								/* Leaving chat → board: chat blurs out first. */
								<div className="gui-view-leave">{chatSurface}</div>
							) : (
								<div className="gui-view-enter">{chatSurface}</div>
							);
						})()}
					</div>
				</div>
			)}
			<ConnectDialog
				open={connectOpen}
				onClose={() => setConnectOpen(false)}
				rpc={rpc}
				onOpenWorkspace={handleOpenRemoteWorkspace}
			/>
			<CollabDialog
				rpc={rpc}
				sessionId={store?.sessionId ?? null}
				sessionTitle={activeSessionLabel}
				open={collabOpen}
				onClose={() => setCollabOpen(false)}
			/>
			{/* Always mounted — CommandPalette self-hides and plays its exit
			 * animation when `open` flips false (Pop/DialogFrame parity). */}
			<CommandPalette
				open={paletteOpen}
				onClose={() => setPaletteOpen(false)}
				rpc={rpc}
				sessions={recentSessions}
				onNewSession={startNewTask}
				onOpenWorkspace={() => {
					void pickDirectory().then(dir => {
						if (dir) {
							setProject(dir);
							localStorage.setItem("omp-gui-project", dir);
							// Sidebar projects tab contract: surface the picked folder.
							window.dispatchEvent(new CustomEvent("omp-gui-project-added", { detail: dir }));
						}
					});
				}}
				onSettings={openSettings}
				onToggleSidebar={() => {
					setSideCollapsed(v => {
						localStorage.setItem("omp-gui-side", v ? "1" : "0");
						return !v;
					});
				}}
				onToggleTerminal={() => setBottomTerminal(v => !v)}
				onTogglePreview={() => {
					setRightCollapsed(v => {
						localStorage.setItem("omp-gui-right", v ? "1" : "0");
						return !v;
					});
				}}
				onSelectSession={id => void openSession(id)}
			/>
			{/* Process-global freeze overlay: covers the entire window
			 * (settings dialogs included) with a frosted-glass scrim. */}
			<GlobalPauseOverlay
				paused={globalPause.paused}
				pausedAt={globalPause.pausedAt}
				onResume={() => void toggleGlobalPause()}
			/>
			{/* First-launch primer (settings footer 引导 reopens it via event). */}
			<OnboardingOverlay rpc={rpc} providerEvent={providerEvent} />
			{/* What's-new release notes (daemon changelog.startup; settings
			 * footer 新功能 reopens via omp-open-announcement). */}
			<AnnouncementOverlay rpc={rpc} />
		</div>
	);
}

/** PromptProvider wrapper (Electron sandbox has no window.prompt). */
export function App(): ReactNode {
	return (
		<PromptProvider>
			<AppInner />
		</PromptProvider>
	);
}
