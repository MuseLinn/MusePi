import { getLocaleSnapshot, setLocale, subscribeLocale, t } from "@musepi/desktop-web";
import type { SubagentProgressPayload } from "@musepi/pi-wire";
import type { ReactNode } from "react";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AgentsCenterPage } from "./components/AgentsCenterPage";
import { AnnouncementOverlay } from "./components/AnnouncementOverlay";
import type { AskAnswer, AskRequest } from "./components/AskCard";
import { BlurText } from "./components/BlurText";
import { BoardPage } from "./components/BoardPage";
import { ChatView } from "./components/ChatView";
import { CollabDialog } from "./components/CollabDialog";
import { CommandPalette } from "./components/CommandPalette";
import { ConnectDialog } from "./components/ConnectDialog";
import { DialogFrame } from "./components/DialogFrame";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FloatingScrollbar } from "./components/FloatingScrollbar";
import { GlobalPauseOverlay } from "./components/GlobalPauseOverlay";
import { GuiHeader } from "./components/GuiHeader";
import { ImportSessionsSetup } from "./components/ImportSessionsSetup";
import { OnboardingOverlay } from "./components/OnboardingOverlay";
import type { ReminderRow } from "./components/RemindersPanel";
import { ScheduledTasksPage } from "./components/ScheduledTasksPage";
import type { SessionListNode } from "./components/SessionList";
import { SessionSidebar } from "./components/SessionSidebar";
import { SettingsView } from "./components/SettingsView";
import { ShinyText } from "./components/ShinyText";
import type { ThinkingLevel } from "./components/ThinkingSelector";
import { THINKING_LEVELS } from "./components/thinking-selector-shared";
import { UpdateToast } from "./components/UpdateToast";
import { applyAppearancePrefs } from "./lib/appearance";
import { pickDirectory } from "./lib/electron";
import { applyGlassMaterial, applyGlassPreset, readGlassPreset } from "./lib/glass";
import { dispatchNotification } from "./lib/notify";
import { moodFromState, petEnabled, petMode, petScale } from "./lib/pet";
import { PromptProvider, useConfirm } from "./lib/prompt-dialog";
import { buildWsUrl, loadHosts, newHostId, type RemoteHost, saveHosts } from "./lib/remote-hosts";
import { RpcClient, type StreamEvent } from "./lib/rpc";
import { captureSelectionText } from "./lib/selection-capture";
import { cleanupAction, cleanupCandidates, cleanupDays, cleanupEnabled, runCleanupOnce } from "./lib/session-cleanup";
import { clearRoundDurations, dispatchPetActivity, GuiSessionStore, type PetBubbleKind } from "./lib/session-store";
import { sfxFor } from "./lib/sfx";
import { useMotionExtensions } from "./lib/use-motion-extensions";
import logoUrl from "./vendor/logo.png";
import { Icon } from "./vendor/oc-icons";
import "./styles/gui.css";
import "./styles/gui-taskcenter.css";

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

/** Builtin mode presets used to seed the welcome preset chip when the daemon
 *  modes.list RPC fails/returns empty — the chip must never vanish. Real
 *  localized labels come from the daemon when it responds. */
const WELCOME_MODES_FALLBACK: { id: string; label: string }[] = [
	{ id: "work", label: "Work" },
	{ id: "chat", label: "Chat" },
	{ id: "creator", label: "Creator" },
	{ id: "design", label: "Design" },
];

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
	/** Last-activity time (openchamber `time.updated` parity). */
	updatedAt?: string;
	/** Lifecycle status from the session file tail (TUI session-list parity):
	 *  complete | interrupted | aborted | error | pending. Powers the
	 *  sidebar's colored status square so unfinished history is visible. */
	status?: "complete" | "interrupted" | "aborted" | "error" | "pending" | "unknown";
}

/** Collect every session id in a session tree (drift check for the poll:
 *  the sidebar tree must show exactly the sessions session.list knows). */
function collectTreeIds(nodes: SessionListNode[], out: Set<string>): void {
	for (const n of nodes) {
		out.add(n.entry.id);
		if (n.children.length > 0) collectTreeIds(n.children, out);
	}
}

/** Shared chrome for a surface-replacing view (board / scheduled / agents):
 *  the blur transition wrapper + the fixed chat-column + surface shell, with
 *  the view's page injected as children. The `<ChatView>` "chatSurface" is NOT
 *  routed through here (it already owns the chat-column); use this only for
 *  page views that replace the chat surface. */
function ChatSurfaceShell({ leave, children }: { leave?: boolean; children: ReactNode }) {
	return (
		<div className={leave ? "gui-view-leave" : "gui-view-enter"}>
			<div className="gui-chat-col relative flex min-w-0 flex-1 flex-col">
				<div className="gui-chat-surface gui-pixel-reveal m-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-[var(--color-surface)] shadow-[0_4px_24px_rgba(0,0,0,0.25)]">
					{children}
				</div>
			</div>
		</div>
	);
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
			const fs = localStorage.getItem("musepi-gui-font-scale");
			if (fs) document.documentElement.style.setProperty("--gui-font-scale", `${fs}px`);
			// Glass transparency (slider value = transparency %) — migrates the
			// v1 scrim-coefficient pref once, then applies scrim + adaptive text.
			applyGlassPreset(readGlassPreset());
			// Window-transparency toggle OFF → opaque panes (overrides the slider).
			const glassEnabled = localStorage.getItem("musepi-gui-glass-enabled") !== "0";
			if (!glassEnabled) {
				document.documentElement.style.setProperty("--gui-glass-overlay", "100%");
				document.documentElement.classList.remove("gui-glass-adaptive");
			}
			// Desktop shell: mirror the toggle + theme onto the native window
			// material (light scheme → bright vibrancy, dark → under-window).
			applyGlassMaterial(glassEnabled);
			const motion = localStorage.getItem("musepi-gui-motion");
			if (motion === "off") document.documentElement.classList.add("gui-motion-off");
			else document.documentElement.classList.remove("gui-motion-off");
			if (localStorage.getItem("musepi-gui-images") === "0") document.documentElement.classList.add("gui-no-images");
			else document.documentElement.classList.remove("gui-no-images");
			// Chat display prefs (settings → 聊天): applied as root classes so the
			// shared transcript CSS can hide/keep rows without prop drilling.
			const chat = (key: string, cls: string): void => {
				document.documentElement.classList.toggle(cls, localStorage.getItem(key) === "0");
			};
			chat("musepi-gui-chat-time", "gui-chat-hide-time");
			chat("musepi-gui-chat-rowactions", "gui-chat-hide-row-actions");
			chat("musepi-gui-chat-codehl", "gui-chat-plain-code");
			chat("musepi-gui-chat-thinking", "gui-chat-hide-thinking");
			chat("musepi-gui-chat-caret", "gui-chat-no-caret");
			// gui-chat-no-smooth is NOT mapped here: 平滑流式 is controlled
			// solely by the daemon display.smoothStreaming setting (外观 →
			// 显示) since the chat tab merged into 外观 (2026-08-12). ChatView
			// syncs the class from settings.get, so the old localStorage key
			// must not re-apply a stale value at startup.
			// Output style preset (settings → 聊天 → 输出风格): the same key
			// the segmented picker writes, mirrored onto <html> at startup so
			// the choice survives relaunches.
			const outputStyle = localStorage.getItem("musepi-gui-chat-output-style");
			document.documentElement.dataset.outputStyle =
				outputStyle === "kimi" || outputStyle === "zcode" ? outputStyle : "default";
			// 消息字号 (settings → 外观 → 消息字号): --tr-font-size drives the
			// transcript body ladder (headings/code scale off it in
			// transcript.css); output-style presets no longer set sizes.
			const trFontSize = localStorage.getItem("musepi-gui-chat-font-size");
			if (trFontSize) document.documentElement.style.setProperty("--tr-font-size", `${trFontSize}px`);
			// Typing effect preset (settings → 聊天 → 逐字动效): NOT applied
			// here — effect classes now live on the streaming block's own
			// .tr-md root (Markdown.tsx reads the key per render), so finished
			// and historic messages always render plain text.
			// Code appearance prefs (settings → 外观 → 代码设置): root classes
			// for line numbers / long-line wrap; themes + size re-apply below.
			document.documentElement.classList.toggle(
				"gui-code-lines",
				localStorage.getItem("musepi-gui-code-lines") !== "0",
			);
			document.documentElement.classList.toggle(
				"gui-code-wrap",
				// Long-line wrap default ON (user direction): only an explicit
				// "0" disables it.
				localStorage.getItem("musepi-gui-code-wrap") !== "0",
			);
			// Font picks (--font-ui / --font-mono) + spacing density (--gui-density):
			// re-apply at startup so choices survive relaunches.
			applyAppearancePrefs();
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
			applyGlassMaterial(localStorage.getItem("musepi-gui-glass-enabled") !== "0");
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
			return localStorage.getItem("musepi-gui-url") ?? DEFAULT_URL;
		} catch {
			return DEFAULT_URL;
		}
	});
	const [rpc, setRpc] = useState<RpcClient | null>(null);
	const [hosts, setHosts] = useState<RemoteHost[]>(() => loadHosts());
	const [status, setStatus] = useState<"idle" | "connecting" | "open" | "closed">("idle");
	const [error, setError] = useState<string | null>(null);
	// GUI motion packs (extension center → injected <style>): declared
	// before any early return — the booting splash early-returns and React
	// hook order must not shift between renders (see 2026-08-12 crash note).
	useMotionExtensions(rpc);
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
	// Shared in-app error toast: WelcomeComposer's branch checkout (and any
	// other pane far from the banner) dispatches `musepi-gui-toast` — route
	// it into the same banner instead of dropping it (was listener-less).
	useEffect(() => {
		const onToast = (e: Event): void => {
			const detail = (e as CustomEvent<string>).detail;
			if (typeof detail === "string" && detail) setError(detail);
		};
		window.addEventListener("musepi-gui-toast", onToast);
		return () => window.removeEventListener("musepi-gui-toast", onToast);
	}, []);
	const [tree, setTree] = useState<SessionListNode[]>([]);
	// Sessions with an undismissed completion (pet badge + persistent
	// bubble + sidebar 未读 marker + welcome reminders panel) — cleared
	// when the user opens the session. Seeded from localStorage, grown by
	// pet completions and the cursor-based derivation (message-count
	// growth past the last read count, kimi 实时提醒 parity).
	const [unreadSessions, setUnreadSessions] = useState<Set<string>>(() => {
		try {
			return new Set(JSON.parse(localStorage.getItem("musepi-gui-unread") ?? "[]") as string[]);
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
			localStorage.setItem("musepi-gui-unread", JSON.stringify([...unreadSessions]));
		} catch {
			// storage unavailable
		}
	}, [unreadSessions]);
	const treeRef = useRef<SessionListNode[]>([]);
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
			const raw = localStorage.getItem("musepi-gui-read-count");
			if (raw) readCountRef.current = new Map(JSON.parse(raw) as [string, number][]);
			readSeededRef.current = localStorage.getItem("musepi-gui-read-count-seeded") === "1";
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
	// openSession with a 250ms flicker threshold, cleared when the store
	// lands (or the open fails). MUST sit above the booting/connect early
	// returns below — a hook after them is skipped by the splash/connect
	// renders and throws "Rendered more hooks than during the previous
	// render" on the splash → full-app transition (Rules of Hooks).
	const [sessionLoading, setSessionLoading] = useState(false);
	const sessionLoadingTimerRef = useRef<Timer | null>(null);
	// Panel collapse (ZCode-style): side rail and context panel fold to thin
	// strips with a reopen button.
	const [sideCollapsed, setSideCollapsed] = useState(() => localStorage.getItem("musepi-gui-side") === "0");
	const [sideWidth, setSideWidth] = useState<number>(() => Number(localStorage.getItem("musepi-gui-side-w") ?? 256));
	const startResize = (which: "side" | "right", startX: number, startW: number, min: number, max: number): void => {
		const onMove = (e: MouseEvent): void => {
			const w = Math.min(max, Math.max(min, startW + (e.clientX - startX) * (which === "side" ? 1 : -1)));
			if (which === "side") {
				setSideWidth(w);
				localStorage.setItem("musepi-gui-side-w", String(w));
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
	const [rightCollapsed, setRightCollapsed] = useState(() => localStorage.getItem("musepi-gui-right") === "0");
	const [project, setProject] = useState<string | null>(() => {
		try {
			return localStorage.getItem("musepi-gui-project");
		} catch {
			return null;
		}
	});
	const [connectOpen, setConnectOpen] = useState(false);
	const [collabOpen, setCollabOpen] = useState(false);
	const [importOpen, setImportOpen] = useState(false);
	// kimiwork parity: 新建空白项目 dialog (name + parent path → daemon
	// fs.mkdir → open the folder). Kept always-mounted so the DialogFrame
	// plays its enter/exit animation.
	const [newProjectOpen, setNewProjectOpen] = useState(false);
	const [newProjectName, setNewProjectName] = useState("");
	const [newProjectParent, setNewProjectParent] = useState<string | null>(null);
	const [newProjectBusy, setNewProjectBusy] = useState(false);
	const [newProjectError, setNewProjectError] = useState<string | null>(null);
	// Pending ask question (TUI ask parity): the agent asked mid-run and the
	// daemon pushed an ask-request envelope — the AskCard answers it via
	// session.askAnswer. Tagged with the OWNING session: asks raised in
	// other sessions are recorded too (the cross-session guard drops every
	// other envelope kind), but the card only shows for the session it
	// belongs to.
	const [pendingAsk, setPendingAsk] = useState<(AskRequest & { sessionId?: string }) | null>(null);
	// answerAsk is memoized on selectedId only — the ref keeps the current
	// envelope reachable without rebuilding the callback.
	const pendingAskRef = useRef<(AskRequest & { sessionId?: string }) | null>(null);
	pendingAskRef.current = pendingAsk;
	// mkdir the blank project under the chosen parent (daemon fs.mkdir is
	// cwd-scoped, so the parent rides as cwd + the name as relative path),
	// then open + surface it like 打开文件夹 does.
	const createNewProject = async (): Promise<void> => {
		const name = newProjectName.trim();
		const parent = newProjectParent;
		if (!name || !parent || !rpc || newProjectBusy) return;
		setNewProjectBusy(true);
		setNewProjectError(null);
		try {
			const res = (await rpc.request<{ ok?: boolean; error?: string }>("fs.mkdir", {
				cwd: parent,
				path: name,
			})) as { ok?: boolean; error?: string };
			if (res?.ok === false || res?.error) {
				setNewProjectError(res?.error ?? t("create project failed"));
				return;
			}
			const dir = `${parent.replace(/\/+$/, "")}/${name}`;
			setProject(dir);
			localStorage.setItem("musepi-gui-project", dir);
			window.dispatchEvent(new CustomEvent("musepi-gui-project-added", { detail: dir }));
			setNewProjectOpen(false);
			setNewProjectName("");
			setNewProjectParent(null);
		} catch {
			setNewProjectError(t("create project failed"));
		} finally {
			setNewProjectBusy(false);
		}
	};
	// daimon-canvas jump from chat: board id to open after the view swap.
	const [boardJumpId, setBoardJumpId] = useState<string | null>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [boardOpen, setBoardOpen] = useState(false);
	const [scheduledOpen, setScheduledOpen] = useState(false);
	const [agentsOpen, setAgentsOpen] = useState(false);
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
	// Welcome 预设 chip 选项:modes.list 一次拉取 + modes.changed 即时刷新.
	// Fallback: if modes.list fails/returns empty the preset chip must still
	// render (the builtin 4 are always valid) instead of vanishing — the load
	// error is surfaced to the console so the real cause stays visible.
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		const load = (): void => {
			void rpc
				.request<{ modes: { id: string; label: string }[] } | null>("modes.list", {})
				.then(res => {
					if (!alive) return;
					const modes = res?.modes;
					setWelcomeModes(Array.isArray(modes) && modes.length > 0 ? modes : WELCOME_MODES_FALLBACK);
				})
				.catch(err => {
					console.warn("[gui] modes.list failed; falling back to builtin modes", err);
					if (alive) setWelcomeModes(WELCOME_MODES_FALLBACK);
				});
		};
		load();
		const off = rpc.addEventListener(event => {
			const payload = event.payload as { type?: string } | undefined;
			if (payload?.type === "modes.changed") load();
		});
		return () => {
			alive = false;
			off();
		};
	}, [rpc]);
	// Board / scheduled / chat surface swap with the same blur transition
	// as the board home ↔ collection swap (150ms leave blur, 300ms enter).
	const [leavingView, setLeavingView] = useState<"board" | "scheduled" | "agents" | "chat" | null>(null);
	const swapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const viewSwapRef = useRef((_to: "board" | "scheduled" | "agents" | "chat"): void => {});
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
	viewSwapRef.current = (to: "board" | "scheduled" | "agents" | "chat"): void => {
		const from = boardOpen ? "board" : scheduledOpen ? "scheduled" : agentsOpen ? "agents" : "chat";
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
			setAgentsOpen(to === "agents");
		}, 150);
	};
	// Section the settings pane lands on (sidebar 技能 entry + welcome
	// composer 自定义补充 preselect).
	const [settingsSection, setSettingsSection] = useState<"skills" | "suggestions" | undefined>(undefined);
	// Settings open/close rides the same blur transition as the board /
	// scheduled / chat swaps: the outgoing surface blurs out (150ms), then
	// the settings view (or the workspace) enters with its 300ms blur-in.
	const [leavingSettings, setLeavingSettings] = useState(false);
	const settingsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const openSettings = useCallback((): void => {
		if (settingsOpen) return;
		// Blur the current surface out first (leavingView keeps it mounted).
		setLeavingView(boardOpen ? "board" : scheduledOpen ? "scheduled" : agentsOpen ? "agents" : "chat");
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
	// Cross-component navigation into a settings section (welcome composer
	// 自定义补充 chip): open the pane on the requested section.
	useEffect(() => {
		const onOpenSection = (e: Event): void => {
			const section = (e as CustomEvent<string>).detail;
			if (section === "skills" || section === "suggestions") {
				setSettingsSection(section);
				openSettings();
			}
		};
		window.addEventListener("musepi-gui-open-settings-section", onOpenSection);
		return () => window.removeEventListener("musepi-gui-open-settings-section", onOpenSection);
	}, [openSettings]);
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
	/** 预设(mode)选择(欢迎页 chip):welcome 创建会话时随 create RPC 传入。
	 *  默认 Work(全量,= 未启用预设时的行为);与 presetModelId 同语义:
	 *  一次选择应用到下一次新建,不随会话回写。 */
	const [welcomeModeId, setWelcomeModeId] = useState<string | null>(
		() => localStorage.getItem("musepi-gui-default-mode") ?? "work",
	);
	/** modes.list(欢迎页 chip 选项;挂载 + modes.changed 刷新)。 */
	const [welcomeModes, setWelcomeModes] = useState<{ id: string; label: string }[] | null>(null);
	/** The DEFAULT-role model (modelRoles.default) — the welcome composer's
	 *  resting preselect for new sessions. Kept SEPARATE from presetModelId:
	 *  opening a session must not clobber the welcome default with that
	 *  session's model (a pick in one session must not leak into the next
	 *  new task). Updated by the boot settings snapshot and the
	 *  musepi-gui-default-model-changed event (selector target button +
	 *  settings DEFAULT row). */
	const [defaultModelId, setDefaultModelId] = useState<string | null>(null);
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
	// Delete-confirmation dialog (settings 会话 toggle musepi-gui-confirm-delete).
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
			localStorage.setItem("musepi-gui-read-count", JSON.stringify([...readCountRef.current]));
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
					localStorage.setItem("musepi-gui-read-count-seeded", "1");
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
				const nodes = await client.request<SessionListNode[]>("session.tree");
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
								updatedAt: r.updatedAt,
								status: r.status,
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
								updatedAt: r.updatedAt ?? row.updatedAt,
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
				if (phase === "closed") {
					setStatus("closed");
					// Unannounced drop (daemon restart / machine sleep): the
					// in-place auto-reconnect restore froze the main-window
					// renderer (ce1c9284d — CPU idle, clicks dead); recover
					// through the proven-working boot() path instead.
					recoverFromDropRef.current();
				} else if (phase === "connecting") setStatus("connecting");
				else if (phase === "open") {
					console.log("[gui] rpc open — restoring");
					setStatus("open");
					// Reconnect (daemon restart / machine sleep): clear the stale
					// error bar, refresh the session tree, and re-open the session
					// that was showing (openchamber parity — the UI comes back to
					// the live session instead of a dead snapshot).
					setError(null);
					console.log("[gui] refreshSessions…");
					void refreshSessions(client).then(
						() => console.log("[gui] refreshSessions done"),
						err => console.log("[gui] refreshSessions err", String(err).slice(0, 80)),
					);
					const active = selectedIdRef.current;
					console.log("[gui] reopen session", active?.slice(0, 8));
					if (active) void openSessionRef.current?.(active);
				}
			};
			// Route subscription envelopes to the active session store; provider
			// auth/prompt envelopes surface through the settings dialog instead.
			client.onEvent = (event: StreamEvent) => {
				// Ask card FIRST: an ask raised in a background session must be
				// recorded with its owning session even while another session
				// is displayed — the 窜台 guard below drops every other
				// cross-session envelope, and the subscribe-time daemon replay
				// re-delivers it when the user switches over anyway.
				if (event.kind === "ask-request") {
					setPendingAsk({ ...(event.payload as AskRequest), sessionId: event.sessionId });
					return;
				}
				// B1: envelopes carry the subscribing sessionId. The daemon
				// allows multi-subscription per connection now, so switching
				// sessions leaves the old subscription attached — drop events
				// from sessions this store isn't displaying (cross-session
				// 窜台 guard; UI-command/global envelopes have no sessionId
				// and pass through).
				if (event.sessionId !== undefined && event.sessionId !== storeRef.current?.sessionId) return;
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
				// notifications setting (musepi-gui-notify).
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
			// Subscribe to daemon global events (extensions.changed /
			// modes.changed …). Without this the daemon never broadcasts
			// HMR invalidation — slot hosts fall back to 10s polling and
			// "instant refresh" is dead code. Fire-and-forget: a missing
			// RPC on older daemons is non-fatal (polling still works).
			client.request("events.subscribe", {}).catch(() => {});
			localStorage.setItem("musepi-gui-url", targetUrl);
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
						setDefaultModelId(role.model);
						setPresetThinkingLevel(
							role.level === null ? dfltLevel : role.level === "off" ? null : (role.level as ThinkingLevel),
						);
					} else {
						setPresetModelId(res.modelRoles.default);
						setDefaultModelId(res.modelRoles.default);
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
		// Remote hosts (instance switcher) skip the Electron version gate and
		// the local probe/spawn fallback — those only make sense for the
		// machine's own daemon.
		const isLocalUrl = (u: string): boolean => {
			const h = new URL(u).hostname;
			return h === "127.0.0.1" || h === "localhost" || h === "::1";
		};
		const tryUrl = async (u: string): Promise<boolean> => {
			try {
				await connect(u);
				await waitForPrewarm();
				// OTA/发布一致性:daemon 是 detached 进程(daemon.cjs spawn
				// detached:true),GUI 重启从不刷新它 —— 新版本 GUI 连旧
				// daemon 会看不到新功能(2026-08-17 实测)。daemon.cjs
				// spawn 时注入 MUSEPI_VERSION=GUI 版本,这里与当前 GUI
				// 版本比对:不一致 → daemon-restart(kill+spawn 新代码)
				// 后重连。dev 迭代(版本号不变)不触发,发布/OTA 必触发。
				// Token-bearing URLs are user-configured remote instances (the
				// instance switcher): the version gate must NOT restart them.
				if (isElectron() && isLocalUrl(u) && !new URL(u).searchParams.has("token")) {
					const rpc = rpcRef.current;
					const api = (
						window as unknown as {
							electronAPI?: { getAppVersion?(): Promise<string>; restartDaemon?(port: number): Promise<number> };
						}
					).electronAPI;
					if (rpc && api?.getAppVersion && api.restartDaemon) {
						const meta = await rpc.request<{ musepiVersion?: string | null }>("system.meta").catch(() => null);
						const appVersion = await api.getAppVersion().catch(() => null);
						if (meta?.musepiVersion && appVersion && meta.musepiVersion !== appVersion) {
							const port = Number.parseInt(new URL(u).port, 10) || 8300;
							await api.restartDaemon(port);
							await connect(u);
							await waitForPrewarm();
						}
					}
				}
				return true;
			} catch {
				return false;
			}
		};
		try {
			if ((await tryUrl(url)) === true) return;
			// Electron shell: discover a running daemon, else spawn one.
			if (isElectron() && isLocalUrl(url)) {
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

	// ── Unexpected-drop recovery (sleep/wake freeze fix, 2026-08-20) ───────
	// An unannounced close (daemon restart / machine sleep) MUST NOT be
	// restored in place — ce1c9284d documented that path freezing the
	// main-window renderer (CPU idle, console alive, clicks dead). The
	// proven-working recovery is what the 重新连接 button does: stop the
	// stale client's backoff retry, show the splash, boot() from a clean
	// state (fresh client + full init: events.subscribe, daemon.pauseStatus,
	// settings, session re-open). Pause state lives in the daemon, so a
	// global or per-session pause survives the reconnect and is re-fetched
	// during boot + openSession — nothing about pause is lost here.
	const recoveringRef = useRef(false);
	const recoverFromDropRef = useRef<() => void>(() => {});
	recoverFromDropRef.current = (): void => {
		if (recoveringRef.current) return;
		recoveringRef.current = true;
		setBooting(true); // splash first — the main UI never flashes the error page
		rpcRef.current?.close(); // stop the stale client's backoff retry loop
		rpcRef.current = null;
		setRpc(null);
		void boot().finally(() => {
			recoveringRef.current = false;
		});
	};

	// macOS sleep/wake: Electron tears down the renderer's WebSocket on
	// system sleep (electron#19993); the main process pushes a resume event
	// (powerMonitor) that fires reliably on wake where visibilitychange /
	// online may not. Recover proactively instead of waiting for the
	// keepalive loop to notice the dead socket.
	useEffect(() => {
		if (!window.electronAPI?.onPowerResume) return;
		return window.electronAPI.onPowerResume(() => recoverFromDropRef.current());
	}, []);

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
			sessionLoadingTimerRef.current = setTimeout(() => setSessionLoading(true), 250);
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
				// shape, so one store path serves both. Live sessions additionally
				// carry stream-only visual hydration (running tool calls + owned
				// subagent progress) so switching back restores the composer
				// dock / swarm card immediately instead of waiting for a frame.
				let initial: {
					entries: unknown[];
					state?: unknown;
					cursor: number;
					header?: { cwd?: string };
					activeTools?: {
						toolCallId: string;
						toolName: string;
						args: unknown;
						intent?: string;
						partialResult?: unknown;
						startedAt: number;
					}[];
					agentsProgress?: SubagentProgressPayload[];
				} | null = null;
				try {
					const res = await client.request<{
						stream: string | null;
						initial: {
							entries: unknown[];
							state?: unknown;
							cursor: number;
							header?: { cwd?: string };
							tail?: { hasMore: boolean; beforeId: string | null };
							activeTools?: {
								toolCallId: string;
								toolName: string;
								args: unknown;
								intent?: string;
								partialResult?: unknown;
								startedAt: number;
							}[];
							agentsProgress?: SubagentProgressPayload[];
						};
					}>("session.subscribe", { sessionId });
					initial = res.initial;
				} catch {
					// Unknown session (history) — fall back to resume.
					const res = await client.request<{
						snapshot: {
							entries: unknown[];
							state?: unknown;
							cursor: number;
							header?: { cwd?: string };
							tail?: { hasMore: boolean; beforeId: string | null };
						};
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
						tail: (initial as { tail?: { hasMore: boolean; beforeId: string | null } } | null)?.tail,
						activeTools: initial?.activeTools,
						agentsProgress: initial?.agentsProgress,
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
			/** Explicit modeId override (creation flows pass "creator"); falls
			 * back to the welcome chip selection. */
			modeId?: string | null;
		}): Promise<string | null> => {
			const client = rpcRef.current;
			if (!client) return null;
			// Swap to the chat surface up front: the create RPC can take
			// seconds, so the user must not sit on the welcome/board view
			// while it runs. Idempotent when already on chat (clears any
			// stale leave state); openSession re-swaps after the store
			// mounts, and the sessionLoading skeleton still arms there.
			viewSwapRef.current("chat");
			setError(null);
			try {
				// The ZCode project picker chooses the workspace folder — it
				// becomes the session cwd so 按项目 groups by it.}
				const res = await client.request<{ sessionId: string }>("session.create", {
					...(opts?.cwd ? { cwd: opts.cwd } : {}),
					// Settings → 会话 → 自动生成会话标题: off keeps the session
					// title generic instead of falling back to the first message.
					autoTitle: localStorage.getItem("musepi-gui-autotitle") !== "0",
					// Welcome-composer choices ride INSIDE the create RPC: the
					// daemon resolves modelPattern + thinkingLevel during initial
					// session setup, collapsing the old create → setThinkingLevel
					// → setModel serial chain (1–7s) into a single awaited RPC.
					// modelId is already the model selector parseModelPattern
					// accepts (bare id or provider/id composite — both exact-match
					// the registry); an unresolvable id falls back to the DEFAULT
					// role exactly like the old swallowed setModel error.
					...(opts?.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
					...(opts?.modelId ? { modelPattern: opts.modelId } : {}),
					// Welcome 预设 chip 选择 / 创作流覆盖:modeId 随 create 一次应用
					// (daemon 侧白名单/提示词/settings 覆盖);显式 modeId(创作流
					// creator)优先,否则用 welcome chip 选择;无选择 = 默认(Standard)。
					...((opts?.modeId ?? welcomeModeId) ? { modeId: opts?.modeId ?? welcomeModeId } : {}),
				});
				// Carry the welcome-composer model seed so the composer never
				// flashes a stale model from a previous session while
				// contextUsage (the authoritative live model) loads. No explicit
				// model → the daemon resolves the DEFAULT role; seed with it.
				setPresetModelId(opts?.modelId ?? defaultModelId);
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
				// Sidebar tree/metadata refresh for the new session — fire and
				// forget: openSession and sendPrompt don't depend on it (the
				// ack-hooked refresh in sendPrompt plus the 5s poll cover a
				// drop), and awaiting it here only delayed the first send.
				void refreshSessions(client);
				await openSession(res.sessionId);
				return res.sessionId;
			} catch (err) {
				setError(fmtError("session.create", err));
				return null;
			}
		},
		[openSession, refreshSessions, defaultModelId],
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

	/** Pick a folder and register it as the workspace/project. Sidebar projects
	 *  tab contract: surface the picked folder via the project-added event. */
	const pickProjectFolder = useCallback((): void => {
		void pickDirectory().then(dir => {
			if (dir) {
				setProject(dir);
				localStorage.setItem("musepi-gui-project", dir);
				window.dispatchEvent(new CustomEvent("musepi-gui-project-added", { detail: dir }));
			}
		});
	}, []);

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
			// The prompt is committed the moment the user hits send — leave
			// the welcome surface before the create RPC (1–7s) instead of
			// after openSession resolves, so the session UI is what the
			// user sees while the daemon spins up. Same-target call is a
			// no-op that clears stale leave state; the sessionLoading
			// skeleton still arms inside openSession.
			viewSwapRef.current("chat");
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

	/** DSH creation-flow parity: open a chat session under the given modeId
	 *  (creation contexts pass "creator") and send the first prompt right
	 *  away — used by the board and settings-preset 新建输入框, where the
	 *  agent designs & saves the artifact (board / preset) in a chat. */
	const createAndSend = useCallback(
		async (text: string, modeId: string): Promise<void> => {
			viewSwapRef.current("chat");
			const id = await createSession({ cwd: project, modeId });
			if (id) void sendPrompt(text, undefined, id);
		},
		[createSession, sendPrompt, project],
	);

	/** Settings → 智能体 → 预设 新建输入框 (DSH):send the natural-language
	 *  preset description to a Creator session that designs & saves the
	 *  preset (modes-plan structure → modes.save). Closes the settings pane
	 *  first so the new chat isn't buried behind it. */
	const onPresetCreate = useCallback(
		(text: string): void => {
			const trimmed = text.trim();
			if (!trimmed) return;
			closeSettings();
			const prompt = `${trimmed}。请设计并保存这个预设：遵循 docs/modes-plan.md 契约（extends 继承、promptComplete、settings 覆盖），完成后用 modes.validate 自检，再用 modes.save 保存到模式目录。`;
			void createAndSend(prompt, "creator");
		},
		[createAndSend, closeSettings],
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

	/** Ask answer (TUI ask parity): the floating AskCard above the composer
	 *  answered — resolve the daemon's ask-request promise. */
	const answerAsk = useCallback(
		(answer: AskAnswer): void => {
			const ask = pendingAskRef.current;
			if (!ask) return;
			setPendingAsk(null);
			const client = rpcRef.current;
			const id = selectedId;
			if (!client || !id) return;
			void client.request("session.askAnswer", { sessionId: id, requestId: ask.requestId, answer }).catch(() => {});
		},
		[selectedId],
	);

	/** The ask card renders only for the session it belongs to — an ask
	 *  raised in a background session stays recorded (the daemon replays it
	 *  on subscribe) but must not surface over the displayed one. */
	const activeAsk =
		pendingAsk && (pendingAsk.sessionId === undefined || pendingAsk.sessionId === selectedId) ? pendingAsk : null;

	const switchHost = useCallback((host: RemoteHost | null): void => {
		const targetUrl = host ? buildWsUrl(host) : "ws://127.0.0.1:8300";
		setUrl(targetUrl);
		localStorage.setItem("musepi-gui-url", targetUrl);
	}, []);
	const addHost = useCallback(
		(input: { label: string; url: string; token?: string }): void => {
			const h: RemoteHost = { id: newHostId(), label: input.label, url: input.url, token: input.token || undefined };
			const next = [...hosts, h];
			setHosts(next);
			saveHosts(next);
		},
		[hosts],
	);
	const removeHost = useCallback(
		(id: string): void => {
			const next = hosts.filter(h => h.id !== id);
			setHosts(next);
			saveHosts(next);
		},
		[hosts],
	);
	/** Permanently delete a session (journal + index) and refresh the tree;
	 *  resets the UI when the deleted session was the active one. The
	 *  confirm dialog honors the settings toggle (musepi-gui-confirm-delete). */
	const deleteSession = useCallback(
		async (sessionId: string): Promise<boolean> => {
			const client = rpcRef.current;
			if (!client) return false;
			try {
				if (localStorage.getItem("musepi-gui-confirm-delete") !== "0") {
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
			} catch (err) {
				// e.g. the daemon refuses to delete a streaming session
				// (TUI parity) — surface why instead of failing silently.
				setError(fmtError("session.delete", err));
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
			syncRecentPoll();
		};
		// Recent-session list for the pet panel: derive from the tree (top 6
		// by timestamp) and push on tree change + a light 15s poll. The poll
		// only runs while the pet is enabled AND in desktop mode — an
		// always-on 15s interval would wake the renderer even on machines
		// that never enable the pet.
		const pushRecent = (): void => {
			if (!petEnabled() || petMode() !== "desktop") return;
			const walk = (nodes: SessionListNode[]): { id: string; label: string; timestamp: number }[] => {
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
		let recentTimer: ReturnType<typeof setInterval> | null = null;
		const syncRecentPoll = (): void => {
			const want = petEnabled() && petMode() === "desktop";
			if (want && recentTimer === null) {
				pushRecent();
				recentTimer = setInterval(pushRecent, 15_000);
			} else if (!want && recentTimer !== null) {
				clearInterval(recentTimer);
				recentTimer = null;
			}
		};
		syncRecentPoll();
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
		// DEFAULT-role model changed via the selector's "set as DEFAULT"
		// target or the settings role tab: refresh the welcome preselect (a
		// boot-time snapshot would otherwise keep showing the OLD default on
		// the next new task). Deliberately NOT presetModelId — the in-chat
		// selector shows each session's OWN model, never the global default.
		const onDefaultModelChanged = (e: Event): void => {
			const ref = (e as CustomEvent<string>).detail;
			if (ref) setDefaultModelId(ref);
		};
		window.addEventListener("musepi-gui-default-model-changed", onDefaultModelChanged);
		const onDefaultModeChanged = (e: Event): void => {
			const ref = (e as CustomEvent<string | null>).detail;
			if (ref !== undefined) setWelcomeModeId(ref);
		};
		window.addEventListener("musepi-gui-default-mode-changed", onDefaultModeChanged);
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
				// Read-only snapshot — MUST NOT session.subscribe: that would
				// attach this connection's live stream to an extra session,
				// which (with single-store routing) bleeds its events into the
				// currently displayed session (cross-session 窜台).
				let initial: { entries: unknown[] } | null = null;
				try {
					initial = await client.request<{ entries: unknown[] }>("session.snapshot", { sessionId });
				} catch {
					return;
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
			if (recentTimer !== null) clearInterval(recentTimer);
			window.removeEventListener("omp-pet-activity", onBubble);
			window.removeEventListener("omp-pet-changed", onPetChanged);
			window.removeEventListener("musepi-gui-default-model-changed", onDefaultModelChanged);
			window.removeEventListener("musepi-gui-default-mode-changed", onDefaultModeChanged);
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
						new CustomEvent("musepi-gui-ask", {
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
					window.dispatchEvent(new CustomEvent("musepi-gui-quote-append", { detail: { text } }));
				} else {
					(document.querySelector('[data-chat-input="true"] textarea') as HTMLTextAreaElement | null)?.focus();
				}
			} else if (mod && k === "k") {
				e.preventDefault();
				setPaletteOpen(v => !v);
			} else if (mod && k === "o") {
				e.preventDefault();
				pickProjectFolder();
			} else if (mod && k === "b") {
				e.preventDefault();
				setSideCollapsed(v => {
					localStorage.setItem("musepi-gui-side", v ? "1" : "0");
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
			} else if (mod && k === "arrowdown") {
				// settings → 快捷键 reference: jump the transcript to the
				// latest message (smooth, like most chat apps).
				e.preventDefault();
				const scroller = document.querySelector<HTMLElement>(".gui-chat-surface .gui-transcript");
				if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
			} else if (mod && e.shiftKey && k === "e") {
				// openchamber ⌘⇧E: focus mode (composer fills the surface).
				e.preventDefault();
				setFocusMode(v => !v);
			} else if (mod && !e.shiftKey && k === "e") {
				e.preventDefault();
				setRightCollapsed(v => {
					localStorage.setItem("musepi-gui-right", v ? "1" : "0");
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
		const walk = (nodes: SessionListNode[]): void => {
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
		const find = (nodes: SessionListNode[]): string | null => {
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
					<div className="gui-error gui-error-toast" role="alert">
						<span className="gui-error-toast-text">{error}</span>
						<button
							type="button"
							className="gui-error-toast-x"
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
						modes={welcomeModes}
						modeId={welcomeModeId}
						onModeChange={setWelcomeModeId}
						defaultModelId={defaultModelId}
						presetThinkingLevel={presetThinkingLevel}
						busy={status === "connecting"}
						paused={pauseInfo.sessionId === selectedId && pauseInfo.paused}
						pausedAt={pauseInfo.sessionId === selectedId ? pauseInfo.pausedAt : null}
						onResume={() => void togglePause()}
						project={project}
						onProject={action => {
							if (action === "remote") {
								setConnectOpen(true);
							} else if (action === "new") {
								setNewProjectOpen(true);
							} else if (action === "folder") {
								pickProjectFolder();
							} else if (action === "none") {
								// "不在项目中": clear the workspace chip — never open the picker.
								setProject(null);
								localStorage.removeItem("musepi-gui-project");
							} else {
								// A saved workspace picked from the list — switch to it.
								setProject(action);
								localStorage.setItem("musepi-gui-project", action);
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
						ask={activeAsk}
						onAskAnswer={answerAsk}
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
				<div className="gui-error gui-error-toast" role="alert">
					<span className="gui-error-toast-text">{error}</span>
					<button
						type="button"
						className="gui-error-toast-x"
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
						onCreateChat={onPresetCreate}
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
						onOpenAgents={() => viewSwapRef.current("agents")}
						agentsActive={agentsOpen}
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
							pickProjectFolder();
						}}
						onCreateProject={() => setNewProjectOpen(true)}
						onImportSessions={() => setImportOpen(true)}
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
									localStorage.setItem("musepi-gui-side", v ? "1" : "0");
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
									localStorage.setItem("musepi-gui-right", v ? "1" : "0");
									return !v;
								});
							}}
							project={project}
							// Reuse pickProjectFolder: a bare pickDirectory here updated
							// musepi-gui-project (welcome chip) but never announced the
							// workspace, so the sidebar 项目 tab stayed empty — the two
							// surfaces disagreed on what "added" means.
							onOpenFolder={pickProjectFolder}
							sessions={recentSessions}
							onSelectSession={id => void openSession(id)}
							onRenameSession={renameSession}
							sessionLabel={activeSessionLabel}
							remote={activeSessionRemote}
							connected={status === "open"}
							daemonUrl={url}
							onReconnect={() => void boot()}
							onOpenCollab={() => setCollabOpen(true)}
							onDeleteSession={deleteSession}
							hosts={hosts}
							onSwitchHost={switchHost}
							onAddHost={addHost}
							onRemoveHost={removeHost}
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
									modes={welcomeModes}
									modeId={welcomeModeId}
									onModeChange={setWelcomeModeId}
									defaultModelId={defaultModelId}
									presetThinkingLevel={presetThinkingLevel}
									busy={status === "connecting"}
									paused={pauseInfo.sessionId === selectedId && pauseInfo.paused}
									pausedAt={pauseInfo.sessionId === selectedId ? pauseInfo.pausedAt : null}
									onResume={() => void togglePause()}
									project={project}
									onProject={action => {
										if (action === "remote") {
											setConnectOpen(true);
										} else if (action === "new") {
											setNewProjectOpen(true);
										} else if (action === "none") {
											// "不在项目中": clear the workspace chip — never open the picker.
											setProject(null);
											localStorage.removeItem("musepi-gui-project");
										} else if (action === "folder") {
											pickProjectFolder();
										} else {
											// A saved workspace picked from the list — switch to it.
											setProject(action);
											localStorage.setItem("musepi-gui-project", action);
										}
									}}
									onSubmitNewSession={(text, opts) => void submitNewSession(text, opts)}
									rightPanelOpen={!rightCollapsed}
									onOpenFileInPanel={() => {
										setRightCollapsed(false);
									}}
									onToggleRightPanel={() => {
										setRightCollapsed(v => {
											localStorage.setItem("musepi-gui-right", v ? "1" : "0");
											return !v;
										});
									}}
									onExpandRightPanel={() => {
										setRightCollapsed(false);
										localStorage.setItem("musepi-gui-right", "0");
									}}
									terminalOpen={bottomTerminal}
									onCloseTerminal={() => setBottomTerminal(false)}
									focusMode={focusMode}
									onToggleFocus={() => setFocusMode(v => !v)}
									reminders={reminders}
									onSelectReminder={id => void openSession(id)}
									onMarkAllRead={markAllRead}
									sessionLoading={sessionLoading}
									ask={activeAsk}
									onAskAnswer={answerAsk}
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
													// agent to design boards; with text, create a session
													// (DSH creation flow: Creator persona) and send it
													// right away.
													const trimmed = text.trim();
													if (!trimmed) {
														startNewTask();
														return;
													}
													const prompt = `${trimmed}。请把这些组件放进一个新看板（用 board 工具 save）。`;
													void createAndSend(prompt, "creator");
												}}
											/>
										</div>
									</div>
								</div>
							) : boardOpen ? (
								/* Board view replaces the chat surface only — the
								 * sidebar stays (kimi Work tab parity). */
								<ChatSurfaceShell>
									<BoardPage
										onBack={() => viewSwapRef.current("chat")}
										rpc={rpc}
										cwd={project ?? undefined}
										jumpId={boardJumpId}
										onJumpConsumed={() => setBoardJumpId(null)}
										onChatCreate={text => {
											// 对话创建 (kimi parity): leave the board and prompt the
											// agent to design boards; with text, create a session
											// (DSH creation flow: Creator persona) and send it
											// right away.
											const trimmed = text.trim();
											if (!trimmed) {
												startNewTask();
												return;
											}
											const prompt = `${trimmed}。请把这些组件放进一个新看板（用 board 工具 save）。`;
											void createAndSend(prompt, "creator");
										}}
									/>
								</ChatSurfaceShell>
							) : leavingView === "scheduled" ? (
								/* Leaving scheduled → chat/board: scheduled blurs out first. */
								<ChatSurfaceShell leave>
									<ScheduledTasksPage
										rpc={rpc}
										onBack={() => viewSwapRef.current("chat")}
										onOpenSession={id => void openSession(id)}
									/>
								</ChatSurfaceShell>
							) : scheduledOpen ? (
								/* Scheduled tasks view (kimi cron page parity). */
								<ChatSurfaceShell>
									<ScheduledTasksPage
										rpc={rpc}
										onBack={() => viewSwapRef.current("chat")}
										onOpenSession={id => void openSession(id)}
									/>
								</ChatSurfaceShell>
							) : leavingView === "agents" ? (
								/* Leaving agents → chat/board: agents blurs out first. */
								<ChatSurfaceShell leave>
									<AgentsCenterPage rpc={rpc} store={store} onBack={() => viewSwapRef.current("chat")} />
								</ChatSurfaceShell>
							) : agentsOpen ? (
								/* Agents center view (live subagent roster). */
								<ChatSurfaceShell>
									<AgentsCenterPage rpc={rpc} store={store} onBack={() => viewSwapRef.current("chat")} />
								</ChatSurfaceShell>
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
			{/* Session import (sidebar projects tab entry) — import sessions
			 * from other agents into MusePi. */}
			<DialogFrame
				open={importOpen}
				onClose={() => setImportOpen(false)}
				label={t("import sessions")}
				className="gui-import-dialog"
			>
				<ImportSessionsSetup rpc={rpc} />
			</DialogFrame>
			{/* kimiwork parity: 新建空白项目 — name + parent path, mkdir via the
			 * daemon (works outside any session cwd), then open + surface it. */}
			<DialogFrame
				open={newProjectOpen}
				onClose={() => setNewProjectOpen(false)}
				label={t("new blank project")}
				className="gui-new-project-dialog gui-dialog--confirm"
			>
				{" "}
				<div className="flex flex-col gap-3">
					<div className="gui-new-project-field">
						<div className="gui-new-project-label">
							{t("project name")} <span className="gui-new-project-req">*</span>
						</div>
						<input
							className="gui-input w-full"
							value={newProjectName}
							placeholder={t("project name placeholder")}
							autoFocus
							spellCheck={false}
							onChange={e => setNewProjectName(e.target.value)}
							onKeyDown={e => {
								if (e.key === "Enter") void createNewProject();
							}}
						/>
					</div>
					<div className="gui-new-project-field">
						<div className="gui-new-project-label">
							{t("project parent path")} <span className="gui-new-project-req">*</span>
						</div>
						<button
							type="button"
							className="gui-new-project-path"
							onClick={() => {
								void pickDirectory().then(dir => {
									if (dir) setNewProjectParent(dir);
								});
							}}
						>
							<Icon name="folder" className="h-3.5 w-3.5 flex-none" />
							<span className="min-w-0 flex-1 truncate">
								{newProjectParent ?? t("project parent placeholder")}
							</span>
							<Icon name="arrow-right-s" className="h-3 w-3 flex-none opacity-60" />
						</button>
					</div>
					{newProjectError && <div className="text-[12.5px] text-[var(--color-danger)]">{newProjectError}</div>}
					<div className="mt-1 flex justify-end gap-2">
						<button type="button" className="gui-btn" onClick={() => setNewProjectOpen(false)}>
							{t("cancel")}
						</button>
						<button
							type="button"
							className="gui-btn gui-btn-primary"
							disabled={!newProjectName.trim() || !newProjectParent || newProjectBusy}
							onClick={() => void createNewProject()}
						>
							{newProjectBusy ? t("creating…") : t("save")}
						</button>
					</div>
				</div>
			</DialogFrame>
			{/* Ask card (TUI ask parity) renders inside ChatView as a floating
			 * card above the composer (openchamber QuestionCard parity) —
			 * see ChatView `ask`/`onAskAnswer` props. */}
			{/* Always mounted — CommandPalette self-hides and plays its exit
			 * animation when `open` flips false (Pop/DialogFrame parity). */}
			<CommandPalette
				open={paletteOpen}
				onClose={() => setPaletteOpen(false)}
				rpc={rpc}
				sessions={recentSessions}
				onNewSession={startNewTask}
				onOpenWorkspace={() => {
					pickProjectFolder();
				}}
				onSettings={openSettings}
				onToggleSidebar={() => {
					setSideCollapsed(v => {
						localStorage.setItem("musepi-gui-side", v ? "1" : "0");
						return !v;
					});
				}}
				onToggleTerminal={() => setBottomTerminal(v => !v)}
				onTogglePreview={() => {
					setRightCollapsed(v => {
						localStorage.setItem("musepi-gui-right", v ? "1" : "0");
						return !v;
					});
				}}
				onSelectSession={id => void openSession(id)}
				onOpenAgents={() => viewSwapRef.current("agents")}
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
			{/* Auto-checked update notice (BitFun parity toast; main.cjs
			 * pushes update-available ~12s after boot). */}
			<UpdateToast rpc={rpc} />
			{/* Floating pac-man scroll indicator (fixed overlay — system
			 * scrollbars are hidden; see FloatingScrollbar.tsx). */}
			<FloatingScrollbar />
		</div>
	);
}

/** PromptProvider wrapper (Electron sandbox has no window.prompt). */
export function App(): ReactNode {
	return (
		<ErrorBoundary>
			<PromptProvider>
				<AppInner />
			</PromptProvider>
		</ErrorBoundary>
	);
}
