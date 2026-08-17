import { AgentsPanel, latestWidgetFromEntries, t, WidgetCard } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { isElectron, openExternalUrl } from "../lib/electron";
import { useConfirm, usePrompt } from "../lib/prompt-dialog";
import type { RpcClient } from "../lib/rpc";
import type { GuiSessionState } from "../lib/session-store";
import { Icon } from "../vendor/oc-icons";
import { AgentControls } from "./AgentControls";
import { FilePane } from "./FilePane";
import { ManagedBrowserPane } from "./ManagedBrowserPane";

/** Electron <webview> tag (embedded browser): the DOM element exposes
 *  loadURL/executeJavaScript/etc. at runtime; only the JSX shape is typed. */
declare global {
	namespace JSX {
		interface IntrinsicElements {
			webview: React.DetailedHTMLProps<
				React.HTMLAttributes<HTMLElement> & {
					src?: string;
					partition?: string;
					allowpopups?: boolean;
					webpreferences?: string;
					onDidFinishLoad?: () => void;
				},
				HTMLElement
			>;
		}
	}
}

/** ZCode right-pane tool views. Backends land behind daemon RPCs; until
 *  then each shows an honest placeholder with its future scope. (The
 *  terminal lives in the bottom dock now, not here.) */
const TOOLS: { id: string; icon: string; label: string }[] = [
	{ id: "git", icon: "git-branch", label: t("git graph") },
	{ id: "pr", icon: "git-pull-request", label: t("pull requests") },
	{ id: "diff", icon: "file", label: t("workspace changes") },
	{ id: "notes", icon: "book", label: t("project notes") },
	{ id: "browser", icon: "global", label: t("browser") },
];

function fmtTokens(n: number): string {
	if (!Number.isFinite(n)) return "0";
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
	return String(n);
}

/**
 * Right pane — ZCode-style session tools: 上下文 / 文件 tabs plus a tool
 * rail (git graph, PRs, diff, notes, browser). The file tree and context
 * summary are live; the tool views are framed placeholders waiting on
 * their daemon backends (the terminal lives in the bottom dock).
 */
export function ContextPanel({
	snap,
	rpc,
	className,
	open = true,
	openRequest = null,
}: {
	/** Materialized snapshot, passed down from ChatView's own store
	 *  subscription (a second useStore here double-subscribed the same
	 *  store for four fields — every notify ran two listeners). */
	snap: GuiSessionState | null;
	rpc: RpcClient;
	/** Optional extra class (inner-panel styling). */
	className?: string;
	/** Width-collapse state: `false` folds the panel to a 0px sliver
	 *  (ChatView keeps it mounted so the width animates on toggle). */
	open?: boolean;
	/** External reveal request (artifact cards / transcript paths):
	 *  switches to the files tab and previews the path. */
	openRequest?: { path: string; nonce: number } | null;
}): ReactNode {
	const cwd = snap?.state?.cwd ?? "";
	// Live mode chips (daemon injects goalMode/planMode into the snapshot).
	const modes = snap?.state as { goalMode?: { enabled?: boolean; objective?: string }; planMode?: boolean } | null;
	// Session stats: message count + wall-clock run time.
	const messageCount = (snap?.entries ?? []).filter(e => e.type === "message").length;
	const firstTs = (snap?.entries ?? []).find(e => typeof e.timestamp === "string")?.timestamp;
	const runMinutes =
		typeof firstTs === "string" ? Math.max(0, Math.round((Date.now() - new Date(firstTs).getTime()) / 60000)) : 0;
	const [tab, setTab] = useState<"context" | "files" | "widget">("files");
	const [tool, setTool] = useState<string | null>(null);
	// Context-window usage (session.contextUsage, same RPC as the header
	// ring): tokens / capacity / percent, polled while the panel lives.
	const [ctxUsage, setCtxUsage] = useState<{
		tokens: number;
		contextWindow: number;
		percent: number;
		model?: string | null;
	} | null>(null);
	useEffect(() => {
		if (!rpc || !snap?.sessionId) return;
		let alive = true;
		const poll = (): void => {
			void rpc
				.request<{ tokens: number; contextWindow: number; percent: number; model?: string | null } | null>(
					"session.contextUsage",
					{ sessionId: snap.sessionId },
				)
				.then(u => {
					if (alive && u) setCtxUsage(u);
				})
				.catch(() => {});
		};
		poll();
		// Event-driven freshness: poll only while the agent WORKS — the
		// `snap.working` flip re-runs this effect, so context usage lands
		// on the transition instead of a timer (idle = zero polling).
		if (!snap?.working) return;
		const t = setInterval(poll, 5000);
		return () => {
			alive = false;
			clearInterval(t);
		};
	}, [rpc, snap?.sessionId, snap?.working]);
	// Selected subagent (TUI Agent Hub parity): click a roster row to open
	// its kill/revive/chat controls beneath the panel.
	const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
	const selectedAgent =
		selectedAgentId !== null ? ((snap?.agents ?? []).find(a => a.id === selectedAgentId) ?? null) : null;
	// Relay external reveal requests into the FilePane preview.
	useEffect(() => {
		if (!openRequest) return;
		setTool(null);
		setTab("files");
	}, [openRequest]);
	// Managed browser (Proma 吸收): when the agent opens a tab in the in-app
	// browser (browser.gui), surface the browser tool so the user sees the
	// agent's work without hunting for the panel.
	const agentBrowserTabRef = useRef<string | null>(null);
	useEffect(() => {
		const api = window.electronAPI;
		if (!api || typeof api.onManagedBrowserState !== "function") return;
		return api.onManagedBrowserState(next => {
			if (next.agentActivity === true && next.activeTabId && agentBrowserTabRef.current !== next.activeTabId) {
				agentBrowserTabRef.current = next.activeTabId;
				setTool("browser");
			}
		});
	}, []);
	// Resizable right-pane width (openchamber parity): drag the left edge;
	// persisted per run.
	const [width, setWidth] = useState(() => {
		try {
			const v = Number.parseInt(localStorage.getItem("omp-gui-right-width") ?? "", 10);
			return Number.isFinite(v) && v >= 200 && v <= 560 ? v : 288;
		} catch {
			return 288;
		}
	});
	const resizeRef = useRef<{ startX: number; startW: number } | null>(null);
	const onResizeStart = (e: React.PointerEvent<HTMLDivElement>): void => {
		resizeRef.current = { startX: e.clientX, startW: width };
		const move = (ev: PointerEvent): void => {
			const s = resizeRef.current;
			if (!s) return;
			const next = Math.min(560, Math.max(200, s.startW + (s.startX - ev.clientX)));
			setWidth(next);
		};
		const up = (): void => {
			resizeRef.current = null;
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			try {
				localStorage.setItem("omp-gui-right-width", String(width));
			} catch {
				// storage unavailable
			}
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	};
	const panelClass = `gui-pane-right gui-pane-right--inner${open ? "" : " gui-pane-right--inner--closed"}${className ? ` ${className}` : ""}`;
	return (
		<aside className={panelClass} style={{ width }}>
			{/* Left-edge drag handle for width (pointer capture on the 4px
			 * strip; cursor col-resize over it). */}
			<div className="gui-pane-resize-x" onPointerDown={onResizeStart} aria-hidden />
			<div className="flex h-full min-h-0 w-full flex-col">
				{/* Header: context/files tabs + tool rail (ZCode 打开标签页). */}
				<div className="flex h-9 flex-shrink-0 items-center gap-1 border-b border-[var(--border)] px-2">
					<button
						type="button"
						title={t("context")}
						aria-label={t("context")}
						className={`gui-pane-tab${tab === "context" ? " gui-pane-tab--active" : ""}`}
						onClick={() => setTab("context")}
					>
						<Icon name="donut-chart" className="h-4 w-4" />
					</button>
					<button
						type="button"
						title={t("files")}
						aria-label={t("files")}
						className={`gui-pane-tab${tab === "files" ? " gui-pane-tab--active" : ""}`}
						onClick={() => setTab("files")}
					>
						<Icon name="folder" className="h-4 w-4" />
					</button>
					<button
						type="button"
						title={t("widget preview")}
						aria-label={t("widget preview")}
						className={`gui-pane-tab${tab === "widget" ? " gui-pane-tab--active" : ""}`}
						onClick={() => setTab("widget")}
					>
						<Icon name="sparkling" className="h-4 w-4" />
					</button>
					<div className="ml-auto flex items-center gap-0.5">
						{TOOLS.map(toolDef => (
							<button
								key={toolDef.id}
								type="button"
								className={`gui-pane-tool${tool === toolDef.id ? " gui-pane-tool--active" : ""}`}
								title={toolDef.label}
								aria-label={toolDef.label}
								onClick={() => setTool(prev => (prev === toolDef.id ? null : toolDef.id))}
							>
								<Icon name={toolDef.icon as never} className="h-3.5 w-3.5" />
								{tool === toolDef.id && <span className="gui-pane-tool-label">{toolDef.label}</span>}
							</button>
						))}
					</div>
				</div>
				<div className="flex-1 overflow-y-auto px-2.5 pb-3 pt-1.5">
					{tool === "notes" ? (
						<NotesPane rpc={rpc} cwd={cwd} />
					) : tool === "diff" ? (
						<DiffPane rpc={rpc} cwd={cwd} />
					) : tool === "git" ? (
						<GitLogPane rpc={rpc} cwd={cwd} />
					) : tool === "pr" ? (
						<PrPane rpc={rpc} cwd={cwd} />
					) : tool === "browser" ? (
						<BrowserPane rpc={rpc} />
					) : tool ? (
						<div className="gui-tool-placeholder">
							<Icon name={TOOLS.find(x => x.id === tool)?.icon as never} className="h-5 w-5" />
							<div className="text-[13px] font-medium">{TOOLS.find(x => x.id === tool)?.label}</div>
							<p className="text-[12px] leading-relaxed text-[var(--color-text-faint)]">
								{t("tool needs a daemon backend — coming with the desktop release")}
							</p>
						</div>
					) : tab === "files" && cwd ? (
						<FilePane rpc={rpc} cwd={cwd} openRequest={openRequest} />
					) : tab === "widget" ? (
						<WidgetSidebarTab entries={snap?.entries ?? []} />
					) : tab === "context" ? (
						<div className="px-1 py-2">
							<div className="gui-group-label px-2 pb-1 pt-1">{t("session")}</div>
							<div className="flex flex-col gap-1 px-2 text-[13px]">
								<div className="flex items-center gap-2 text-[var(--color-text-muted)]">
									<Icon name="folder" className="h-3.5 w-3.5 flex-shrink-0" />
									<span className="truncate">{cwd || t("no folder")}</span>
								</div>
								{snap?.state?.model?.id && (
									<div className="flex items-center gap-2 text-[var(--color-text-muted)]">
										<Icon name="ai-agent" className="h-3.5 w-3.5 flex-shrink-0" />
										<span className="truncate">{snap.state.model.id}</span>
									</div>
								)}
								{modes && (
									<div className="flex items-center gap-2 text-[var(--color-text-muted)]">
										<Icon name="target" className="h-3.5 w-3.5 flex-shrink-0" />
										<span className="truncate">
											{modes.goalMode?.enabled === true
												? `${t("goal mode")}: ${modes.goalMode.objective ?? ""}`
												: modes.planMode === true
													? t("plan mode")
													: t("default mode")}
										</span>
									</div>
								)}
							</div>
							{/* Session stats (openchamber context-drawer parity): message
							 * count and run time at a glance. */}
							<div className="gui-group-label px-2 pb-1 pt-3">{t("stats")}</div>
							<div className="grid grid-cols-2 gap-1.5 px-2">
								<div className="gui-ctx-stat">
									<div className="gui-ctx-stat-v">{messageCount}</div>
									<div className="gui-ctx-stat-l">{t("messages")}</div>
								</div>
								<div className="gui-ctx-stat">
									<div className="gui-ctx-stat-v">{runMinutes}</div>
									<div className="gui-ctx-stat-l">{t("minutes")}</div>
								</div>
							</div>
							{/* Context-window usage: live tokens/capacity bar (product
							 * parity with the header ring — same RPC). */}
							{ctxUsage && (
								<>
									<div className="gui-group-label px-2 pb-1 pt-3">{t("context window")}</div>
									<div className="px-2">
										<div className="gui-ctx-usage-row">
											<span className="text-[12px] tabular-nums opacity-80">
												{fmtTokens(ctxUsage.tokens)} / {fmtTokens(ctxUsage.contextWindow)}
												{ctxUsage.model ? ` · ${ctxUsage.model}` : ""}
											</span>
											<span className="text-[12px] tabular-nums opacity-70">
												{Math.round(ctxUsage.percent)}%
											</span>
										</div>
										<div className="gui-ctx-usage-track">
											<div
												className={`gui-ctx-usage-bar${ctxUsage.percent > 90 ? " gui-ctx-usage-bar--hot" : ""}`}
												style={{ width: `${Math.min(100, Math.max(2, ctxUsage.percent))}%` }}
											/>
										</div>
									</div>
								</>
							)}
							{/* Reusable context quick actions: copy the workspace path. */}
							<div className="mt-2 flex flex-col gap-0.5 px-2">
								<button
									type="button"
									className="gui-pane-action"
									onClick={() => {
										if (cwd) void navigator.clipboard.writeText(cwd).catch(() => {});
									}}
								>
									<Icon name="clipboard" className="h-3.5 w-3.5" />
									<span>{t("copy workspace path")}</span>
								</button>
							</div>
							{/* Swarm visual parity (TUI subagent HUD): live agent rows —
							 * status dot, activity line, token/cost meta — fed from
							 * the session stream (agent-progress/lifecycle). Click a
							 * row to open its kill/revive/chat controls. */}
							<div className="gui-group-label px-2 pb-1 pt-3">{t("agents")}</div>
							<div className="px-2">
								<AgentsPanel
									agents={snap?.agents ?? []}
									progress={snap?.progress ?? new Map()}
									lifecycle={snap?.lifecycle ?? new Map()}
									selectedId={selectedAgentId}
									onSelect={setSelectedAgentId}
								/>
								{selectedAgent && (
									<AgentControls agent={selectedAgent} rpc={rpc} onClose={() => setSelectedAgentId(null)} />
								)}
							</div>
						</div>
					) : (
						<p className="px-2 py-5 text-[13px] leading-relaxed text-[var(--color-text-faint)]">
							{t("select a session")}
						</p>
					)}
				</div>
			</div>
		</aside>
	);
}

/** Persistent widget preview tab (常驻标签页): mirrors the latest widget
 *  the conversation rendered. The last successful widget tool result wins;
 *  the card stays until a newer widget replaces it. */
function WidgetSidebarTab({ entries }: { entries: readonly unknown[] }): ReactNode {
	const payload = latestWidgetFromEntries(entries);
	if (!payload) {
		return (
			<div className="gui-widget-tab-empty">
				<Icon name="layout-column" className="h-5 w-5" />
				<p>{t("widget preview empty")}</p>
			</div>
		);
	}
	return (
		<div className="gui-widget-tab">
			<WidgetCard payload={payload} />
		</div>
	);
}

interface TodoItem {
	id: string;
	text: string;
	done: boolean;
	createdAt: number;
}

interface PlanFile {
	id: string;
	title: string;
	createdAt: string;
}

const TODO_STORAGE_PREFIX = "omp-gui-todos:";
const TODO_TEXT_MAX = 120;

function loadTodos(cwd: string): TodoItem[] {
	try {
		const raw = localStorage.getItem(`${TODO_STORAGE_PREFIX}${cwd}`);
		const parsed = raw ? (JSON.parse(raw) as TodoItem[]) : [];
		return parsed.map(t => ({ id: t.id, text: t.text, done: t.done, createdAt: t.createdAt ?? Date.now() }));
	} catch {
		return [];
	}
}

/** Project notes (right-panel 项目笔记): quick note (daemon notes.get/set,
 *  400ms debounce autosave + blur flush) + per-workspace todo list
 *  (localStorage) + saved plan files (daemon plans.*). openchamber parity. */
function NotesPane({ rpc, cwd }: { rpc: RpcClient; cwd: string }): ReactNode {
	const { prompt } = usePrompt();
	const { confirm } = useConfirm();
	const [text, setText] = useState("");
	const [loaded, setLoaded] = useState(false);
	const [saved, setSaved] = useState(false);
	const [todos, setTodos] = useState<TodoItem[]>(() => loadTodos(cwd));
	const [todoInput, setTodoInput] = useState("");
	const [plans, setPlans] = useState<PlanFile[] | null>(null);
	const [planOpen, setPlanOpen] = useState<{ id: string; title: string; body: string } | null>(null);
	const saveNote = (): void => {
		if (!loaded) return;
		void rpc.request("notes.set", { cwd, text }).then(() => {
			setSaved(true);
			setTimeout(() => setSaved(false), 1200);
		});
	};
	// openchamber-style 400ms debounce autosave; blur flushes immediately.
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const onNoteChange = (value: string): void => {
		setText(value);
		if (saveTimer.current) clearTimeout(saveTimer.current);
		saveTimer.current = setTimeout(() => {
			saveTimer.current = null;
			saveNote();
		}, 400);
	};
	useEffect(() => {
		let alive = true;
		setLoaded(false);
		void rpc
			.request<{ text: string }>("notes.get", { cwd })
			.then(res => {
				if (!alive) return;
				setText(res?.text ?? "");
				setLoaded(true);
			})
			.catch(() => {
				if (alive) {
					setText("");
					setLoaded(true);
				}
			});
		return () => {
			alive = false;
		};
	}, [rpc, cwd]);
	const persistTodos = (next: TodoItem[]): void => {
		setTodos(next);
		try {
			localStorage.setItem(`${TODO_STORAGE_PREFIX}${cwd}`, JSON.stringify(next));
		} catch {
			// storage unavailable
		}
	};
	const addTodo = (): void => {
		const value = todoInput.trim().slice(0, TODO_TEXT_MAX);
		if (!value) return;
		// openchamber: insert before the first completed item.
		const firstDone = todos.findIndex(t => t.done);
		const next = [...todos];
		next.splice(firstDone === -1 ? next.length : firstDone, 0, {
			id: crypto.randomUUID(),
			text: value,
			done: false,
			createdAt: Date.now(),
		});
		persistTodos(next);
		setTodoInput("");
	};
	const toggleTodo = (id: string): void => {
		// openchamber: completing moves the item to the end (completed-last).
		const target = todos.find(t => t.id === id);
		if (!target) return;
		const rest = todos.filter(t => t.id !== id);
		const next = target.done ? [...rest, { ...target, done: false }] : [...rest, { ...target, done: true }];
		persistTodos(next);
	};
	const removeTodo = (id: string): void => {
		persistTodos(todos.filter(t => t.id !== id));
	};
	const clearDone = (): void => {
		persistTodos(todos.filter(t => !t.done));
	};
	const doneCount = todos.filter(t => t.done).length;
	// Note pane height (openchamber parity): compact by default with a
	// drag handle on the bottom edge; the expand button fills the pane.
	const [noteH, setNoteH] = useState(180);
	const [noteExpanded, setNoteExpanded] = useState(false);
	const noteResizeRef = useRef<{ startY: number; startH: number } | null>(null);
	const onNoteResizeStart = (e: React.PointerEvent<HTMLDivElement>): void => {
		noteResizeRef.current = { startY: e.clientY, startH: noteH };
		const move = (ev: PointerEvent): void => {
			const s = noteResizeRef.current;
			if (!s) return;
			setNoteH(Math.min(640, Math.max(100, s.startH + (ev.clientY - s.startY))));
		};
		const up = (): void => {
			noteResizeRef.current = null;
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	};
	// ── Saved plans (daemon plans.*) ──────────────────────────────────────
	const loadPlans = useCallback((): void => {
		void rpc
			.request<{ plans?: PlanFile[] }>("plans.list", { cwd })
			.then(res => setPlans(res.plans ?? []))
			.catch(() => setPlans([]));
	}, [rpc, cwd]);
	useEffect(() => {
		loadPlans();
	}, [loadPlans]);
	const createPlan = async (): Promise<void> => {
		const title = await prompt({ title: t("new plan title") });
		if (!title) return;
		const body = await prompt({ title: t("new plan body") });
		if (body === null) return;
		try {
			await rpc.request("plans.save", { cwd, title, body });
		} catch {
			// daemon rejected — keep list as-is
		}
		loadPlans();
	};
	const openPlan = async (id: string): Promise<void> => {
		try {
			const res = await rpc.request<{ title?: string; body?: string; error?: string }>("plans.get", { cwd, id });
			if (res.error || !res.body) return;
			setPlanOpen({ id, title: res.title ?? id, body: res.body });
		} catch {
			// not found — ignore
		}
	};
	const deletePlan = async (id: string): Promise<void> => {
		const ok = await confirm(t("confirm delete plan"));
		if (!ok) return;
		try {
			await rpc.request("plans.delete", { cwd, id });
		} catch {
			// daemon rejected
		}
		if (planOpen?.id === id) setPlanOpen(null);
		loadPlans();
	};
	return (
		<div
			className={`flex min-h-0 flex-col${noteExpanded ? " flex-1" : ""}`}
			style={noteExpanded ? undefined : { height: noteH }}
		>
			<div className="flex items-center justify-between px-1 pb-1 pt-1">
				<span className="flex min-w-0 items-baseline gap-2">
					<span className="gui-group-label px-2">{t("project notes")}</span>
					<span className="text-[11px] text-[var(--color-text-faint)]">{text.length}/3000</span>
				</span>
				<div className="flex items-center gap-1">
					<button
						type="button"
						className="gui-pane-action !w-auto px-2"
						onClick={() => {
							setNoteExpanded(v => !v);
						}}
						title={noteExpanded ? t("restore") : t("expand")}
						aria-label={noteExpanded ? t("restore") : t("expand")}
					>
						<Icon name={noteExpanded ? "fullscreen-exit" : "fullscreen"} className="h-3.5 w-3.5" />
					</button>
					<button type="button" className="gui-pane-action !w-auto px-2" onClick={saveNote} disabled={!loaded}>
						<Icon name={saved ? "check" : "download"} className="h-3.5 w-3.5" />
						<span>{saved ? t("saved") : t("save")}</span>
					</button>
				</div>
			</div>
			<textarea
				className="gui-notes-editor min-h-0 flex-1 resize-none rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)] p-2.5 text-[12.5px] leading-relaxed text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)]"
				value={text}
				maxLength={3000}
				disabled={!loaded}
				placeholder={t("notes placeholder")}
				spellCheck={false}
				onChange={e => onNoteChange(e.target.value)}
				onBlur={saveNote}
			/>
			{/* Drag handle: note pane height (openchamber parity). */}
			<div className="gui-notes-resize-y" onPointerDown={onNoteResizeStart} aria-hidden />
			<div className="gui-notes-todos">
				<div className="flex items-center justify-between px-1 pt-2">
					<span className="gui-group-label px-2">{t("todo count items", { count: todos.length })}</span>
					<button
						type="button"
						className="gui-link text-[11.5px]"
						disabled={doneCount === 0}
						onClick={clearDone}
						title={doneCount === 0 ? t("clear done disabled") : t("clear done")}
					>
						{t("clear done")}
					</button>
				</div>
				<div className="flex items-center gap-1 px-1 pt-1">
					<input
						className="gui-input min-w-0 flex-1 !px-2 !py-1 text-[12px]"
						value={todoInput}
						maxLength={TODO_TEXT_MAX}
						placeholder={t("add todo placeholder")}
						onChange={e => setTodoInput(e.target.value)}
						onKeyDown={e => {
							if (e.key === "Enter") addTodo();
						}}
					/>
					<button type="button" className="gui-btn gui-btn-icon" onClick={addTodo} title={t("add todo")}>
						<Icon name="add" className="h-3.5 w-3.5" />
					</button>
				</div>
				{todos.length === 0 ? (
					<p className="rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)]/40 px-3 py-3 text-[12px] text-[var(--color-text-faint)]">
						{t("no todos yet")}
					</p>
				) : (
					<div className="mt-1 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)]/40">
						<ul className="gui-notes-todo-list">
							{todos.map(todo => (
								<li key={todo.id} className="gui-notes-todo-row">
									<button
										type="button"
										className={`gui-notes-todo-check${todo.done ? " gui-notes-todo-check--done" : ""}`}
										onClick={() => toggleTodo(todo.id)}
										title={todo.done ? t("mark undone") : t("mark done")}
									>
										{todo.done && <Icon name="check" className="h-2.5 w-2.5" />}
									</button>
									<span className={`gui-notes-todo-text${todo.done ? " gui-notes-todo-text--done" : ""}`}>
										{todo.text}
									</span>
									<button
										type="button"
										className="gui-notes-todo-remove"
										onClick={() => removeTodo(todo.id)}
										title={t("remove todo")}
									>
										✕
									</button>
								</li>
							))}
						</ul>
					</div>
				)}
			</div>
			<div className="gui-notes-plans">
				<div className="flex items-center justify-between px-1 pt-2">
					<span className="gui-group-label px-2">{t("plan count files", { count: plans?.length ?? 0 })}</span>
					<button
						type="button"
						className="gui-btn gui-btn-icon"
						onClick={() => void createPlan()}
						title={t("new plan")}
					>
						<Icon name="add" className="h-3.5 w-3.5" />
					</button>
				</div>
				{planOpen && (
					<div className="gui-notes-plan-open">
						<div className="flex items-center justify-between gap-2">
							<span className="gui-notes-plan-open-title" title={planOpen.title}>
								{planOpen.title}
							</span>
							<button
								type="button"
								className="gui-btn gui-btn-icon"
								title={t("close")}
								onClick={() => setPlanOpen(null)}
							>
								✕
							</button>
						</div>
						<pre className="gui-notes-plan-open-body">{planOpen.body}</pre>
					</div>
				)}
				{plans !== null && plans.length === 0 && !planOpen && (
					<p className="rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)]/40 px-3 py-3 text-[12px] text-[var(--color-text-faint)]">
						{t("no plans yet")}
					</p>
				)}
				{plans !== null && plans.length > 0 && (
					<div className="mt-1 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)]/40">
						<ul className="gui-notes-plan-list">
						{plans.map(plan => (
							<li key={plan.id} className="gui-notes-plan-row">
								<button
									type="button"
									className="gui-notes-plan-open-btn"
									onClick={() => void openPlan(plan.id)}
								>
									<span className="gui-notes-plan-title">{plan.title}</span>
									<span className="gui-notes-plan-date">{plan.createdAt}</span>
								</button>
								<button
									type="button"
									className="gui-notes-todo-remove"
									onClick={() => void deletePlan(plan.id)}
									title={t("delete plan")}
								>
									✕
								</button>
							</li>
						))}
						</ul>
					</div>
				)}
			</div>
		</div>
	);
}

/** Parse one `git log --graph` line into its graph column chars + the
 *  commit tail (hash, decorations, subject). Graph columns are the
 *  leading run of `* | \ /` and spaces; a commit line continues with
 *  `<hash> [(<decor>)] <subject>`. Lines without a hash are connector
 *  rows (bare graph chars) that still occupy a row in the SVG. */
function parseGraphLine(line: string): { cols: string[]; tail: string | null } {
	const cols: string[] = [];
	let i = 0;
	while (i < line.length && "*|\\/ ".includes(line[i] ?? "")) {
		cols.push(line[i]!);
		i++;
	}
	const rest = line.slice(i).trim();
	const tail = /^[0-9a-f]{7,}(?: \(| )/.test(rest) ? rest : rest.startsWith("(") ? rest : null;
	return { cols, tail };
}

/** Branch colors per graph column (gitk-style palette). */
const GRAPH_COLORS = ["#e5484d", "#46a758", "#3e63dd", "#f76b15", "#8e4ec6", "#0091ff", "#f2b8c6", "#94a3b8"];

/** Commit-graph view: parses `git log --graph --all` ASCII into an SVG of
 *  nodes + connector lines, with commit tails as HTML beside it. */
function GitGraph({ graph }: { graph: string }): ReactNode {
	const rows = graph.split("\n").map(parseGraphLine);
	const maxCols = Math.max(1, ...rows.map(r => r.cols.length));
	const COLS = 14;
	const ROW_H = 20;
	const W = maxCols * COLS + 8;
	const H = rows.length * ROW_H;
	const segs: ReactNode[] = [];
	for (let r = 0; r < rows.length; r++) {
		const { cols } = rows[r]!;
		const y0 = r * ROW_H;
		for (let c = 0; c < cols.length; c++) {
			const ch = cols[c]!;
			const x = c * COLS + 7;
			const color = GRAPH_COLORS[c % GRAPH_COLORS.length]!;
			if (ch === "*") {
				segs.push(<circle key={`n${r}-${c}`} cx={x} cy={y0 + ROW_H / 2} r={3.2} fill={color} />);
			} else if (ch === "|") {
				segs.push(
					<line key={`v${r}-${c}`} x1={x} y1={y0} x2={x} y2={y0 + ROW_H} stroke={color} strokeWidth={1.6} />,
				);
			} else if (ch === "\\") {
				segs.push(
					<line
						key={`b${r}-${c}`}
						x1={x}
						y1={y0}
						x2={x + COLS}
						y2={y0 + ROW_H}
						stroke={color}
						strokeWidth={1.4}
					/>,
				);
			} else if (ch === "/") {
				segs.push(
					<line
						key={`f${r}-${c}`}
						x1={x + COLS}
						y1={y0}
						x2={x}
						y2={y0 + ROW_H}
						stroke={color}
						strokeWidth={1.4}
					/>,
				);
			}
		}
	}
	return (
		<div className="relative">
			<svg width={W} height={H} className="absolute left-0 top-0" aria-hidden>
				{segs}
			</svg>
			<div style={{ marginLeft: W }}>
				{rows.map((row, r) =>
					row.tail ? (
						<div key={r} className="flex h-5 items-center gap-1.5 whitespace-nowrap pr-1">
							<span className="font-mono text-[10.5px] text-[var(--color-text-faint)]">
								{row.tail.slice(0, 7)}
							</span>
							{(() => {
								const m = /^\(([^)]*)\)/.exec(row.tail.slice(7).trim());
								return m ? (
									<span className="flex items-center gap-1 overflow-hidden">
										{m[1]!.split(/,\s*/).map(d => {
											const isHead = d.includes("HEAD");
											const isTag = d.startsWith("tag:");
											return (
												<span
													key={d}
													className={`rounded px-1 py-px text-[9.5px] leading-none ${isHead ? "bg-[var(--color-accent)]/20 text-[var(--color-accent)]" : isTag ? "bg-amber-500/20 text-amber-700" : "bg-[var(--color-surface-sunken)] text-[var(--color-text-muted)]"}`}
												>
													{d.replace(/^tag: /, "tag/")}
												</span>
											);
										})}
									</span>
								) : null;
							})()}
							<span className="truncate text-[12px] text-[var(--color-text)]">
								{row.tail.replace(/^\([^)]*\)\s*/, "")}
							</span>
						</div>
					) : (
						<div key={r} className="h-5" />
					),
				)}
			</div>
		</div>
	);
}

/** Recent-commit view (right-pane git tool): git log + branch sync state
 *  via the daemon git.log + git.status RPCs. */
function GitLogPane({ rpc, cwd }: { rpc: RpcClient; cwd: string }): ReactNode {
	const [graph, setGraph] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [branch, setBranch] = useState<string | null>(null);
	const [ahead, setAhead] = useState(0);
	const [behind, setBehind] = useState(0);
	const load = useCallback((): void => {
		if (!rpc) return;
		void rpc
			.request<{ graph?: string; error?: string }>("git.log", { cwd, graph: true })
			.then(res => {
				setGraph(res?.graph ?? null);
				setError(res?.error ?? null);
			})
			.catch(err => setError(err instanceof Error ? err.message : String(err)));
		void rpc
			.request<{ branch?: string | null; ahead?: number; behind?: number }>("git.status", { cwd })
			.then(res => {
				setBranch(res?.branch ?? null);
				setAhead(res?.ahead ?? 0);
				setBehind(res?.behind ?? 0);
			})
			.catch(() => {});
	}, [rpc, cwd]);
	useEffect(load, [load]);
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center justify-between px-1 pb-1 pt-1">
				<span className="gui-group-label px-2">{t("git graph")}</span>
				<button type="button" className="gui-pane-action !w-auto px-2" onClick={load}>
					<Icon name="refresh" className="h-3.5 w-3.5" />
					<span>{t("refresh")}</span>
				</button>
			</div>
			{branch && (
				<div className="mb-1 flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)] px-2 py-1.5 text-[12px]">
					<Icon name="git-branch" className="h-3.5 w-3.5 text-[var(--color-accent)]" />
					<span className="min-w-0 flex-1 truncate font-medium">{branch}</span>
					{(ahead > 0 || behind > 0) && (
						<span className="flex-shrink-0 text-[11px] text-[var(--color-text-faint)]">
							{ahead > 0 ? `↑${ahead} ` : ""}
							{behind > 0 ? `↓${behind}` : ""}
						</span>
					)}
				</div>
			)}
			<div className="min-h-0 flex-1 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)] p-2">
				{error ? (
					<div className="px-1 py-4 text-[12.5px] text-[var(--color-text-faint)]">{error}</div>
				) : graph === null ? (
					<div className="px-1 py-4 text-[12.5px] text-[var(--color-text-faint)]">{t("loading…")}</div>
				) : graph === "" ? (
					<div className="px-1 py-4 text-[12.5px] text-[var(--color-text-faint)]">{t("no changes")}</div>
				) : (
					<GitGraph graph={graph} />
				)}
			</div>
		</div>
	);
}

/** Common gitmojis (subset of carloscuesta/gitmoji, bundled so the picker
 *  works offline — openchamber fetches the full list over the network). */
const GITMOJIS: { emoji: string; code: string; desc: string }[] = [
	{ emoji: "✨", code: ":sparkles:", desc: "引入新功能" },
	{ emoji: "🐛", code: ":bug:", desc: "修复 bug" },
	{ emoji: "📝", code: ":memo:", desc: "文档" },
	{ emoji: "♻️", code: ":recycle:", desc: "重构" },
	{ emoji: "✅", code: ":white_check_mark:", desc: "测试" },
	{ emoji: "🔧", code: ":wrench:", desc: "配置" },
	{ emoji: "⚡", code: ":zap:", desc: "性能" },
	{ emoji: "🎨", code: ":art:", desc: "样式/格式" },
	{ emoji: "🚀", code: ":rocket:", desc: "部署/发布" },
	{ emoji: "🔥", code: ":fire:", desc: "删除代码" },
	{ emoji: "🩹", code: ":adhesive_bandage:", desc: "简单修复" },
	{ emoji: "⬆️", code: ":arrow_up:", desc: "依赖升级" },
	{ emoji: "📦", code: ":package:", desc: "打包" },
	{ emoji: "🏗️", code: ":building_construction:", desc: "结构调整" },
	{ emoji: "💄", code: ":lipstick:", desc: "UI 样式" },
	{ emoji: "🌐", code: ":globe_with_meridians:", desc: "国际化" },
	{ emoji: "🔒", code: ":lock:", desc: "安全" },
	{ emoji: "💥", code: ":boom:", desc: "破坏性变更" },
	{ emoji: "👷", code: ":construction_worker:", desc: "CI" },
];

/** Commit identity wire shape (settings Git tab 身份, localStorage). */
interface GitCommitIdentity {
	id: string;
	name: string;
	email: string;
}

/** Workspace-changes view (right-pane diff tool): a staged/unstaged/
 *  untracked file tree (openchamber ChangesPanel parity) with per-file
 *  unified diffs, fed by the daemon git.status + git.diff RPCs. Rows
 *  carry stage/unstage actions, and the header offers flat/tree view,
 *  gitignored display and a commit dialog (subject + bundled gitmoji
 *  picker + the settings-configured default identity). */
function DiffPane({ rpc, cwd }: { rpc: RpcClient; cwd: string }): ReactNode {
	const [status, setStatus] = useState<{
		root: string;
		branch: string | null;
		staged: { path: string; status: string }[];
		unstaged: { path: string; status: string }[];
		untracked: { path: string; status: string }[];
		ignored?: { path: string; status: string }[];
		error?: string;
	} | null>(null);
	const [loading, setLoading] = useState(true);
	const [openPath, setOpenPath] = useState<string | null>(null);
	const [fileDiff, setFileDiff] = useState<{ staged: string; unstaged: string } | null>(null);
	const [diffLoading, setDiffLoading] = useState(false);
	// openchamber GitSettings parity: flat/tree view, show-gitignored and
	// gitmoji picker — localStorage keys shared with the settings Git tab.
	const [view, setView] = useState<"flat" | "tree">(() =>
		localStorage.getItem("omp-gui-git-view") === "tree" ? "tree" : "flat",
	);
	const [showIgnored, setShowIgnored] = useState<boolean>(
		() => localStorage.getItem("omp-gui-git-show-ignored") === "1",
	);
	const [gitmojiOn, setGitmojiOn] = useState<boolean>(() => localStorage.getItem("omp-gui-gitmoji") !== "0");
	// Git settings (Git tab) toggles this pref and dispatches
	// omp-gitmoji-changed (same-window storage events don't fire) — keep
	// the gitmoji badges in the context panel in sync.
	useEffect(() => {
		const sync = (): void => setGitmojiOn(localStorage.getItem("omp-gui-gitmoji") !== "0");
		window.addEventListener("omp-gitmoji-changed", sync);
		return () => window.removeEventListener("omp-gitmoji-changed", sync);
	}, []);
	const [commitOpen, setCommitOpen] = useState(false);
	const [commitMsg, setCommitMsg] = useState("");
	const [committing, setCommitting] = useState(false);
	const [commitError, setCommitError] = useState<string | null>(null);
	const [treeOpen, setTreeOpen] = useState<Set<string>>(new Set());
	const load = useCallback((): void => {
		if (!rpc) return;
		setLoading(true);
		void rpc
			.request<typeof status>("git.status", { ignored: showIgnored, cwd })
			.then(res => {
				setStatus(res ?? null);
				setLoading(false);
			})
			.catch(err => {
				setStatus({
					root: "",
					branch: null,
					staged: [],
					unstaged: [],
					untracked: [],
					error: err instanceof Error ? err.message : String(err),
				});
				setLoading(false);
			});
	}, [rpc, showIgnored, cwd]);
	useEffect(load, [load]);
	const openFile = (path: string): void => {
		if (openPath === path) {
			setOpenPath(null);
			setFileDiff(null);
			return;
		}
		setOpenPath(path);
		setFileDiff(null);
		setDiffLoading(true);
		void rpc
			.request<{ staged: string; unstaged: string }>("git.diff", { path, maxLines: 400, cwd })
			.then(res => {
				setFileDiff(res ?? { staged: "", unstaged: "" });
				setDiffLoading(false);
			})
			.catch(() => setDiffLoading(false));
	};
	const stagePaths = async (paths: string[], stage: boolean): Promise<void> => {
		if (!rpc) return;
		await rpc.request(stage ? "git.stage" : "git.unstage", { paths, cwd }).catch(() => {});
		await load();
	};
	const runCommit = async (): Promise<void> => {
		if (!rpc || !commitMsg.trim()) return;
		setCommitting(true);
		setCommitError(null);
		try {
			const raw = localStorage.getItem("omp-gui-git-identities");
			let identity: GitCommitIdentity | undefined;
			if (raw) {
				const all = JSON.parse(raw) as GitCommitIdentity[];
				const def = localStorage.getItem("omp-gui-git-default-identity");
				identity = all.find(i => i.id === def) ?? all[0];
			}
			const res = await rpc.request<{ ok?: boolean; error?: string }>("git.commit", {
				message: commitMsg.trim(),
				identity: identity ? { name: identity.name, email: identity.email } : undefined,
				cwd,
			});
			if (res?.error) {
				setCommitError(res.error);
				return;
			}
			setCommitOpen(false);
			setCommitMsg("");
			await load();
		} catch (err) {
			setCommitError(err instanceof Error ? err.message : String(err));
		} finally {
			setCommitting(false);
		}
	};

	const hunks = (text: string): ReactNode[] => {
		const lines = text.split("\n");
		const out: ReactNode[] = [];
		let inHunk = false;
		for (const line of lines) {
			if (line.startsWith("diff --git")) {
				out.push(
					<div key={`f${out.length}`} className="gui-diff-file">
						{line.replace("diff --git ", "").replace(/^a\//, "").split(" b/")[0] ?? line}
					</div>,
				);
				inHunk = true;
				continue;
			}
			if (line.startsWith("@@")) {
				out.push(
					<div key={`h${out.length}`} className="gui-diff-hunk">
						{line}
					</div>,
				);
				continue;
			}
			if (line.startsWith("+") && !line.startsWith("+++")) {
				out.push(
					<div key={`a${out.length}`} className="gui-diff-line gui-diff-line--add">
						{line}
					</div>,
				);
				continue;
			}
			if (line.startsWith("-") && !line.startsWith("---")) {
				out.push(
					<div key={`d${out.length}`} className="gui-diff-line gui-diff-line--del">
						{line}
					</div>,
				);
				continue;
			}
			if (inHunk && line.trim() !== "") {
				out.push(
					<div key={`c${out.length}`} className="gui-diff-line">
						{line}
					</div>,
				);
			}
		}
		return out;
	};
	const statusBadge = (code: string): string => {
		const m: Record<string, string> = { M: "M", A: "A", D: "D", R: "R", C: "C", "??": "?", "!!": "!" };
		return m[code] ?? code;
	};
	const FileRow = ({
		file,
		group,
	}: {
		file: { path: string; status: string };
		group: "staged" | "unstaged" | "untracked" | "ignored";
	}): ReactNode => {
		const open = openPath === file.path;
		const cls =
			group === "staged"
				? "gui-changes-badge--staged"
				: group === "untracked"
					? "gui-changes-badge--untracked"
					: group === "ignored"
						? "gui-changes-badge--ignored"
						: "";
		return (
			<div key={file.path} className="gui-changes-row-wrap">
				<button
					type="button"
					className={`gui-changes-row${open ? " gui-changes-row--open" : ""}`}
					onClick={() => openFile(file.path)}
				>
					<span className={`gui-changes-badge ${cls}`}>{statusBadge(file.status)}</span>
					<span className="min-w-0 flex-1 truncate text-left">{file.path}</span>
					{group !== "ignored" &&
						(group === "staged" ? (
							<span
								className="gui-changes-act"
								title={t("unstage")}
								aria-label={t("unstage")}
								onClick={e => {
									e.stopPropagation();
									void stagePaths([file.path], false);
								}}
							>
								<Icon name="arrow-left-s" className="h-3.5 w-3.5" />
							</span>
						) : (
							<span
								className="gui-changes-act"
								title={t("stage")}
								aria-label={t("stage")}
								onClick={e => {
									e.stopPropagation();
									void stagePaths([file.path], true);
								}}
							>
								<Icon name="arrow-right-s" className="h-3.5 w-3.5" />
							</span>
						))}
					<Icon
						name={open ? "arrow-down" : "arrow-right"}
						className="h-3 w-3 flex-shrink-0 text-[var(--color-text-faint)]"
					/>
				</button>
				{open && (
					<div className="gui-changes-file-diff overflow-x-auto rounded-md border border-[var(--border)] bg-[var(--color-surface-sunken)] p-2 font-mono text-[11px] leading-relaxed">
						{diffLoading ? (
							<div className="px-1 py-2 text-[12px] text-[var(--color-text-faint)]">{t("loading…")}</div>
						) : (
							<>
								{hunks(fileDiff?.staged ?? "")}
								{hunks(fileDiff?.unstaged ?? "")}
								{!fileDiff?.staged && !fileDiff?.unstaged && (
									<div className="px-1 py-2 text-[12px] text-[var(--color-text-faint)]">{t("no changes")}</div>
								)}
							</>
						)}
					</div>
				)}
			</div>
		);
	};
	/** openchamber changesTree parity: group rows by their first path
	 *  segment; a collapsed directory hides its children. */
	const groupRows = (
		files: { path: string; status: string }[],
		group: "staged" | "unstaged" | "untracked" | "ignored",
	): ReactNode[] => {
		if (view === "flat") return files.map(f => FileRow({ file: f, group }));
		const dirs = new Map<string, { path: string; status: string }[]>();
		const roots: { path: string; status: string }[] = [];
		for (const f of files) {
			const seg = f.path.split("/");
			if (seg.length > 1) {
				const list = dirs.get(seg[0]) ?? [];
				list.push(f);
				dirs.set(seg[0], list);
			} else {
				roots.push(f);
			}
		}
		return [
			...roots.map(f => FileRow({ file: f, group })),
			...[...dirs.entries()].map(([dir, entries]) => {
				const open = treeOpen.has(dir);
				return (
					<div key={dir}>
						<button
							type="button"
							className="gui-changes-row gui-changes-row--dir"
							onClick={() => {
								const next = new Set(treeOpen);
								if (open) next.delete(dir);
								else next.add(dir);
								setTreeOpen(next);
							}}
						>
							<Icon name="folder" className="h-3.5 w-3.5 text-[var(--color-text-faint)]" />
							<span className="min-w-0 flex-1 truncate text-left font-medium">{dir}/</span>
							<span className="text-[11px] text-[var(--color-text-faint)]">{entries.length}</span>
							<Icon
								name={open ? "arrow-down" : "arrow-right"}
								className="h-3 w-3 flex-shrink-0 text-[var(--color-text-faint)]"
							/>
						</button>
						{open && entries.map(f => FileRow({ file: f, group }))}
					</div>
				);
			}),
		];
	};

	if (loading) {
		return <div className="px-2 py-5 text-[13px] text-[var(--color-text-faint)]">{t("loading…")}</div>;
	}
	if (status?.error || !status?.root) {
		return (
			<div className="px-2 py-5 text-[13px] text-[var(--color-text-faint)]">
				{status?.error ?? t("not a git repository")}
			</div>
		);
	}
	const total = status.staged.length + status.unstaged.length + status.untracked.length;
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center gap-1 px-1 pb-1 pt-1">
				<span className="gui-group-label px-2">{t("workspace changes")}</span>
				<div className="ml-auto flex items-center gap-0.5">
					{/* openchamber GitSettings parity: flat/tree changes view */}
					<button
						type="button"
						className={`gui-pane-tool${view === "flat" ? " gui-pane-tool--active" : ""}`}
						title={t("flat list")}
						aria-label={t("flat list")}
						onClick={() => {
							setView("flat");
							localStorage.setItem("omp-gui-git-view", "flat");
						}}
					>
						<Icon name="align-justify" className="h-3.5 w-3.5" />
					</button>
					<button
						type="button"
						className={`gui-pane-tool${view === "tree" ? " gui-pane-tool--active" : ""}`}
						title={t("tree view")}
						aria-label={t("tree view")}
						onClick={() => {
							setView("tree");
							localStorage.setItem("omp-gui-git-view", "tree");
						}}
					>
						<Icon name="node-tree" className="h-3.5 w-3.5" />
					</button>
					<button
						type="button"
						className={`gui-pane-tool${showIgnored ? " gui-pane-tool--active" : ""}`}
						title={t("show gitignored")}
						aria-label={t("show gitignored")}
						onClick={() => {
							const next = !showIgnored;
							setShowIgnored(next);
							localStorage.setItem("omp-gui-git-show-ignored", next ? "1" : "0");
						}}
					>
						<Icon name="eye-off" className="h-3.5 w-3.5" />
					</button>
					<button
						type="button"
						className="gui-pane-tool"
						title={t("refresh")}
						aria-label={t("refresh")}
						onClick={load}
					>
						<Icon name="refresh" className="h-3.5 w-3.5" />
					</button>
					<button
						type="button"
						className={`gui-btn !h-6 !px-2 !py-0 !text-[11.5px]${status.staged.length === 0 ? " opacity-50" : ""}`}
						disabled={status.staged.length === 0}
						onClick={() => {
							setCommitOpen(true);
							setCommitError(null);
						}}
					>
						<Icon name="git-commit" className="h-3 w-3" />
						{t("commit")}
					</button>
				</div>
			</div>
			{commitOpen && (
				<div className="gui-commit-box mb-1 rounded-lg border border-[var(--border)] bg-[var(--color-surface-raised)] p-2">
					<textarea
						className="gui-input min-h-[64px] w-full resize-y text-[12.5px]"
						value={commitMsg}
						placeholder={t("commit message")}
						onChange={e => setCommitMsg(e.target.value)}
						autoFocus
						onKeyDown={e => {
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void runCommit();
							else if (e.key === "Escape") setCommitOpen(false);
						}}
					/>
					{gitmojiOn && (
						<div className="mt-1.5 flex flex-wrap gap-1">
							{GITMOJIS.map(g => (
								<button
									key={g.code}
									type="button"
									className="gui-gitmoji-chip"
									title={`${g.emoji} ${g.desc}`}
									aria-label={g.desc}
									onClick={() => setCommitMsg(prev => `${prev}${prev ? " " : ""}${g.code} `)}
								>
									<span>{g.emoji}</span>
								</button>
							))}
						</div>
					)}
					{commitError && <div className="mt-1.5 text-[12px] text-[var(--color-danger)]">{commitError}</div>}
					<div className="mt-2 flex items-center justify-end gap-2">
						<span className="mr-auto text-[11.5px] text-[var(--color-text-faint)]">
							{t("staged count", { count: String(status.staged.length) })}
						</span>
						<button type="button" className="gui-btn" onClick={() => setCommitOpen(false)}>
							{t("cancel")}
						</button>
						<button
							type="button"
							className="gui-btn gui-btn-primary"
							disabled={committing || !commitMsg.trim()}
							onClick={() => void runCommit()}
						>
							{committing ? t("committing…") : t("commit")}
						</button>
					</div>
				</div>
			)}
			{total === 0 && !showIgnored ? (
				<div className="px-2 py-5 text-[12.5px] text-[var(--color-text-faint)]">{t("no changes")}</div>
			) : (
				<div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)] p-1.5">
					{status.staged.length > 0 && (
						<>
							<div className="gui-group-label px-2 pb-0.5 pt-1">
								{t("staged")} · {status.staged.length}
							</div>
							{groupRows(status.staged, "staged")}
						</>
					)}
					{status.unstaged.length > 0 && (
						<>
							<div className="gui-group-label px-2 pb-0.5 pt-2">
								{t("unstaged")} · {status.unstaged.length}
							</div>
							{groupRows(status.unstaged, "unstaged")}
						</>
					)}
					{status.untracked.length > 0 && (
						<>
							<div className="gui-group-label px-2 pb-0.5 pt-2">
								{t("untracked")} · {status.untracked.length}
							</div>
							{groupRows(status.untracked, "untracked")}
						</>
					)}
					{showIgnored && (status.ignored?.length ?? 0) > 0 && (
						<>
							<div className="gui-group-label px-2 pb-0.5 pt-2">
								{t("ignored")} · {status.ignored?.length}
							</div>
							{groupRows(status.ignored ?? [], "ignored")}
						</>
					)}
					{total === 0 && (status.ignored?.length ?? 0) === 0 && (
						<div className="px-2 py-5 text-[12.5px] text-[var(--color-text-faint)]">{t("no changes")}</div>
					)}
				</div>
			)}
		</div>
	);
}

/** Pull-request view (right-pane PR tool): `gh pr list` via the daemon,
 *  with a clear message when the CLI is missing. */
function PrPane({ rpc, cwd }: { rpc: RpcClient; cwd: string }): ReactNode {
	const [prs, setPrs] = useState<
		| {
				number: number;
				title: string;
				author: { login: string };
				isDraft: boolean;
				state: string;
				headRefName: string;
				baseRefName: string;
				url: string;
		  }[]
		| null
	>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const load = useCallback((): void => {
		if (!rpc) return;
		setLoading(true);
		void rpc
			.request<{ prs?: typeof prs; error?: string }>("github.prs", { cwd })
			.then(res => {
				setPrs(res?.prs ?? []);
				setError(res?.error ?? null);
				setLoading(false);
			})
			.catch(err => {
				setError(err instanceof Error ? err.message : String(err));
				setLoading(false);
			});
	}, [rpc]);
	useEffect(load, [load]);
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center justify-between px-1 pb-1 pt-1">
				<span className="gui-group-label px-2">{t("pull requests")}</span>
				<button type="button" className="gui-pane-action !w-auto px-2" onClick={load}>
					<Icon name="refresh" className="h-3.5 w-3.5" />
					<span>{t("refresh")}</span>
				</button>
			</div>
			{error ? (
				<div className="px-2 py-5 text-[12.5px] leading-relaxed text-[var(--color-text-faint)]">{error}</div>
			) : loading ? (
				<div className="px-2 py-5 text-[12.5px] text-[var(--color-text-faint)]">{t("loading…")}</div>
			) : prs && prs.length > 0 ? (
				<div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--color-surface-sunken)] p-1.5">
					{prs.map(pr => (
						<button
							key={pr.number}
							type="button"
							className="gui-changes-row"
							onClick={() => {
								// Open the PR in the SYSTEM browser (Electron
								// shell.openExternal; window.open fallback for
								// plain-browser dev).
								void openExternalUrl(pr.url);
							}}
						>
							<span
								className={`gui-changes-badge gui-pr-badge--${pr.isDraft ? "draft" : pr.state === "OPEN" ? "open" : "merged"}`}
							>
								{pr.isDraft ? "D" : pr.state === "OPEN" ? "O" : "M"}
							</span>
							<span className="min-w-0 flex-1 truncate text-left">
								<span className="text-[var(--color-text-faint)]">#{pr.number}</span> {pr.title}
							</span>
							<span className="flex-shrink-0 text-[10.5px] text-[var(--color-text-faint)]">
								{pr.headRefName} → {pr.baseRefName}
							</span>
						</button>
					))}
				</div>
			) : (
				<div className="px-2 py-5 text-[12.5px] text-[var(--color-text-faint)]">{t("no open pull requests")}</div>
			)}
		</div>
	);
}

/** Injected element-picker (bitfun/openchamber parity): hover highlight +
 *  click capture inside the webview; resolves {tag, text, selector,
 *  outerHTML} via executeJavaScript (cross-origin safe). */
const BROWSER_INSPECT_SCRIPT = `(() => {
	const { promise, resolve } = Promise.withResolvers();
	const overlay = document.createElement("div");
	overlay.style.cssText =
		"position:fixed;pointer-events:none;z-index:2147483647;background:rgba(66,133,244,0.15);outline:2px solid #4285f4;display:none;";
	const tip = document.createElement("div");
	tip.style.cssText =
		"position:fixed;pointer-events:none;z-index:2147483647;background:#1a1a1a;color:#fff;font:11px monospace;padding:2px 6px;border-radius:3px;display:none;";
	document.documentElement.appendChild(overlay);
	document.documentElement.appendChild(tip);
	const cssPath = el => {
		if (el.id) return "#" + el.id;
		const parts = [];
		let node = el;
		while (node && node.nodeType === 1 && parts.length < 6) {
			let part = node.tagName.toLowerCase();
			if (node.className && typeof node.className === "string") {
				part += "." + node.className.trim().split(/\\s+/).slice(0, 3).join(".");
			}
			const parent = node.parentElement;
			if (parent) {
				const same = Array.from(parent.children).filter(c => c.tagName === node.tagName);
				if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
			}
			parts.unshift(part);
			node = parent;
		}
		return parts.join(" > ");
	};
	let current = null;
	const cleanup = () => {
		document.removeEventListener("mousemove", onMove, true);
		document.removeEventListener("click", onClick, true);
		document.removeEventListener("keydown", onKey, true);
		overlay.remove();
		tip.remove();
	};
	const onMove = e => {
		const el = document.elementFromPoint(e.clientX, e.clientY);
		if (!el || el === overlay || el === tip) return;
		current = el;
		const r = el.getBoundingClientRect();
		overlay.style.display = "block";
		overlay.style.left = r.left + "px";
		overlay.style.top = r.top + "px";
		overlay.style.width = r.width + "px";
		overlay.style.height = r.height + "px";
		tip.textContent = el.tagName.toLowerCase() + (el.id ? "#" + el.id : "");
		tip.style.display = "block";
		tip.style.left = Math.min(e.clientX + 12, window.innerWidth - 160) + "px";
		tip.style.top = e.clientY + 12 + "px";
	};
	const onClick = e => {
		e.preventDefault();
		e.stopPropagation();
		const el = current || document.elementFromPoint(e.clientX, e.clientY);
		cleanup();
		if (!el) return resolve(null);
		resolve({
			tag: el.tagName.toLowerCase(),
			text: (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 500),
			selector: cssPath(el),
			outerHTML: el.outerHTML.slice(0, 2000),
		});
	};
	const onKey = e => {
		if (e.key !== "Escape") return;
		e.preventDefault();
		cleanup();
		resolve(null);
	};
	document.addEventListener("mousemove", onMove, true);
	document.addEventListener("click", onClick, true);
	document.addEventListener("keydown", onKey, true);
	return promise;
})()`;

interface PickedElement {
	tag: string;
	text: string;
	selector: string;
	outerHTML: string;
}

/** Read the webview page's current text selection (cross-origin safe via
 *  <webview> executeJavaScript) for the selection→ask popover. */
const BROWSER_ASK_SELECTION_SCRIPT = `(() => {
	const sel = window.getSelection();
	const text = sel && sel.rangeCount > 0 && !sel.isCollapsed ? sel.toString().replace(/\\r\\n?/g, "\\n").trim() : "";
	if (!text) return null;
	return { text, title: document.title || "" };
})()`;

const BROWSER_VIEWPORTS = [
	{ labelKey: "viewport fit", width: null },
	{ labelKey: "viewport phone", width: 393 },
	{ labelKey: "viewport tablet", width: 768 },
	{ labelKey: "viewport desktop", width: 1440 },
] as const;

/**
 * Browser tool pane: the managed in-app browser (Electron WebContentsView +
 * local CDP bridge) when the shell exposes it — the SAME browser the agent
 * drives with `browser.gui`. Plain-browser builds fall back to the legacy
 * webview/iframe pane.
 */
function BrowserPane({ rpc }: { rpc: RpcClient }): ReactNode {
	const managed = typeof window.electronAPI?.managedBrowserOpen === "function";
	if (managed) return <ManagedBrowserPane />;
	return <LegacyBrowserPane rpc={rpc} />;
}

/** Legacy embedded browser: Electron <webview> (real Chromium, cross-origin
 *  executeJavaScript for the element picker) with an iframe fallback for the
 *  plain-browser build. URL bar, back/forward history, quick ports, viewport
 *  presets and an element-picker that inserts the picked element into the
 *  chat composer via the omp-gui-insert-text window event. The "Agent 标签页"
 *  strip mirrors the SHARED automation Chromium (the same instance the agent
 *  drives) — click a tab to open its URL here and see a live screenshot. */
interface BrowserTabInfo {
	targetId: string;
	title: string;
	url: string;
}

function LegacyBrowserPane({ rpc }: { rpc: RpcClient }): ReactNode {
	const [url, setUrl] = useState("http://localhost:5173");
	const [current, setCurrent] = useState("http://localhost:5173");
	const [history, setHistory] = useState<string[]>(["http://localhost:5173"]);
	const [histIndex, setHistIndex] = useState(0);
	const [loading, setLoading] = useState(true);
	const [picking, setPicking] = useState(false);
	const [viewport, setViewport] = useState<number | null>(null);
	const [agentTabs, setAgentTabs] = useState<BrowserTabInfo[]>([]);
	const [agentShot, setAgentShot] = useState<{ targetId: string; base64: string } | null>(null);
	const webviewRef = useRef<HTMLElement | null>(null);
	const electron = isElectron();

	// Shared-browser tab strip: refresh every 3s while the pane is open
	// (cheap Target.getTargets over the daemon).
	useEffect(() => {
		let alive = true;
		const load = (): void => {
			void rpc
				.request<{ tabs?: BrowserTabInfo[] }>("browser.tabs", {})
				.then(res => {
					if (!alive) return;
					const tabs = res?.tabs ?? [];
					setAgentTabs(prev =>
						prev.length === tabs.length && prev.every((t, i) => t.targetId === tabs[i]?.targetId) ? prev : tabs,
					);
				})
				.catch(() => {});
		};
		load();
		const id = setInterval(load, 3000);
		return () => {
			alive = false;
			clearInterval(id);
		};
	}, [rpc]);

	const pickAgentTab = (tab: BrowserTabInfo): void => {
		go(tab.url);
		void rpc
			.request<{ base64?: string }>("browser.screenshot", { targetId: tab.targetId })
			.then(res => res?.base64 && setAgentShot({ targetId: tab.targetId, base64: res.base64 }))
			.catch(() => {});
	};
	// Webview load-end → clear the loading spinner (addEventListener form:
	// React's webview JSX types don't expose the Electron event props).
	useEffect(() => {
		if (!electron) return;
		const wv = webviewRef.current as unknown as {
			addEventListener?(event: string, fn: () => void): void;
			removeEventListener?(event: string, fn: () => void): void;
		} | null;
		if (!wv?.addEventListener) return;
		const onLoad = (): void => setLoading(false);
		wv.addEventListener("did-finish-load", onLoad);
		return () => wv.removeEventListener?.("did-finish-load", onLoad);
	}, [electron]);
	const normalize = (target: string): string => {
		let u = target.trim();
		if (u && !/^[a-z]+:\/\//i.test(u)) u = `http://${u}`;
		return u;
	};
	const go = (target: string): void => {
		const u = normalize(target);
		if (!u) return;
		setUrl(u);
		setCurrent(u);
		setHistory(h => [...h.slice(0, histIndex + 1), u]);
		setHistIndex(i => i + 1);
	};
	const back = (): void => {
		if (histIndex <= 0) return;
		const idx = histIndex - 1;
		setHistIndex(idx);
		const u = history[idx]!;
		setUrl(u);
		setCurrent(u);
	};
	const forward = (): void => {
		if (histIndex >= history.length - 1) return;
		const idx = histIndex + 1;
		setHistIndex(idx);
		const u = history[idx]!;
		setUrl(u);
		setCurrent(u);
	};
	const refresh = (): void => {
		const u = `${current}${current.includes("?") ? "&" : "?"}_=${Date.now()}`;
		setCurrent(u);
		setHistory(h => [...h.slice(0, histIndex), u]);
	};
	const pickElement = async (): Promise<void> => {
		if (!electron) return;
		const wv = webviewRef.current as unknown as {
			executeJavaScript?(script: string, userGesture: boolean): Promise<unknown>;
		} | null;
		if (!wv?.executeJavaScript) return;
		setPicking(true);
		try {
			const picked = (await wv.executeJavaScript(BROWSER_INSPECT_SCRIPT, true)) as PickedElement | null;
			if (picked?.text) {
				const insertion = `${t("inserted element", { tag: picked.tag, text: picked.text.slice(0, 80) })}\n${t("inserted element selector")}: ${picked.selector}`;
				window.dispatchEvent(new CustomEvent("omp-gui-insert-text", { detail: { text: insertion } }));
			}
	} catch {
		// page not scriptable (about:blank / crashed) — ignore
	} finally {
		setPicking(false);
	}
};
	const askSelection = async (): Promise<void> => {
		if (!electron) return;
		const wv = webviewRef.current as unknown as {
			executeJavaScript?(script: string, userGesture: boolean): Promise<unknown>;
		} | null;
		if (!wv?.executeJavaScript) return;
		try {
			const picked = (await wv.executeJavaScript(BROWSER_ASK_SELECTION_SCRIPT, true)) as {
				text?: string;
				title?: string;
			} | null;
			if (!picked?.text) return;
			const rect = webviewRef.current?.getBoundingClientRect();
			window.dispatchEvent(
				new CustomEvent("omp-gui-ask", {
					detail: {
						text: picked.text,
						x: (rect?.left ?? 0) + (rect?.width ?? 0) / 2,
						y: (rect?.top ?? 0) + Math.min((rect?.height ?? 0) / 2, 200),
						context: picked.title ? `${t("ask browser selection")}: ${picked.title}` : undefined,
					},
				}),
			);
		} catch {
			// page not scriptable (about:blank / crashed) — ignore
		}
	};
	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* Agent 标签页 strip: live tabs of the shared automation Chromium
			 * (the browser the agent drives). Click → open the URL here +
			 * capture a screenshot thumbnail. */}
			{agentTabs.length > 0 && (
				<div className="flex items-center gap-1 overflow-x-auto px-1 pb-1">
					<span className="flex-shrink-0 text-[10.5px] text-[var(--color-text-faint)]">{t("agent tabs")}:</span>
					{agentTabs.map(tab => (
						<button
							key={tab.targetId}
							type="button"
							className={`gui-pane-tool flex-shrink-0 px-1.5 py-0.5 text-[11px] ${
								agentShot?.targetId === tab.targetId ? "gui-pane-tool--active" : ""
							}`}
							title={tab.url}
							onClick={() => pickAgentTab(tab)}
						>
							<span className="max-w-[110px] truncate">{tab.title}</span>
						</button>
					))}
				</div>
			)}
			{/* Screenshot thumbnail of the picked agent tab. */}
			{agentShot && (
				<div className="relative mx-1 mb-1 overflow-hidden rounded-md border border-[var(--border)]">
					<img
						src={`data:image/jpeg;base64,${agentShot.base64}`}
						alt={t("agent tab preview")}
						className="block h-24 w-full object-cover object-top opacity-80"
					/>
					<button
						type="button"
						className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded bg-[rgba(0,0,0,0.6)] text-[10px] text-white"
						aria-label={t("close")}
						onClick={() => setAgentShot(null)}
					>
						×
					</button>
				</div>
			)}
			<div className="flex items-center gap-1 px-1 pb-1 pt-1">
				<button
					type="button"
					className="gui-pane-action !w-auto px-1.5"
					aria-label={t("back")}
					title={t("back")}
					disabled={histIndex <= 0}
					onClick={back}
				>
					<Icon name="arrow-left" className="h-3.5 w-3.5" />
				</button>
				<button
					type="button"
					className="gui-pane-action !w-auto px-1.5"
					aria-label={t("forward")}
					title={t("forward")}
					disabled={histIndex >= history.length - 1}
					onClick={forward}
				>
					<Icon name="arrow-right" className="h-3.5 w-3.5" />
				</button>
				<form
					className="flex min-w-0 flex-1 items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--color-surface-sunken)] px-2 py-1"
					onSubmit={e => {
						e.preventDefault();
						go(url);
					}}
				>
					<Icon name="global" className="h-3 w-3 flex-shrink-0 text-[var(--color-text-faint)]" />
					<input
						className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--color-text)] outline-none"
						value={url}
						spellCheck={false}
						onChange={e => setUrl(e.target.value)}
						placeholder="localhost:5173"
					/>
				</form>
				<button
					type="button"
					className="gui-pane-action !w-auto px-2"
					aria-label={loading ? t("loading…") : t("refresh")}
					title={loading ? t("loading…") : t("refresh")}
					aria-busy={loading ? "true" : undefined}
					onClick={refresh}
				>
					<Icon name="refresh" className={`h-3.5 w-3.5${loading ? " gui-spin" : ""}`} />
				</button>
				<button
					type="button"
					className="gui-pane-action !w-auto px-2"
					aria-label={t("open in browser")}
					title={t("open in browser")}
					onClick={() => void openExternalUrl(current)}
				>
					<Icon name="external-link" className="h-3.5 w-3.5" />
				</button>
				{electron && (
					<button
						type="button"
						className={`gui-pane-action !w-auto px-2${picking ? " gui-view-opt--active" : ""}`}
						aria-label={picking ? t("stop picking element") : t("pick element")}
						title={picking ? t("stop picking element") : t("pick element")}
						onClick={() => void pickElement()}
					>
						<Icon name="cursor" className="h-3.5 w-3.5" />
					</button>
				)}
				{electron && (
					<button
						type="button"
						className="gui-pane-action !w-auto px-2"
						aria-label={t("ask about page selection")}
						title={t("ask about page selection")}
						onClick={() => void askSelection()}
					>
						<Icon name="sparkling" className="h-3.5 w-3.5" />
					</button>
				)}
				{/* Viewport presets (手机/平板/桌面/自适应): the browser pane is
				 * used for responsive checks — fixed widths wrap the webview. */}
				<div className="flex items-center gap-0.5 rounded-md border border-[var(--border)] p-0.5">
					{BROWSER_VIEWPORTS.map(v => (
						<button
							key={v.labelKey}
							type="button"
							className={`gui-pane-action !w-auto px-1.5 text-[10.5px]${
								viewport === v.width ? " gui-view-opt--active" : ""
							}`}
							aria-label={t(v.labelKey)}
							title={t(v.labelKey)}
							onClick={() => setViewport(v.width)}
						>
							{t(v.labelKey)}
						</button>
					))}
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-auto rounded-lg border border-[var(--border)] bg-white">
				<div
					className="mx-auto h-full min-h-full transition-[width] duration-150"
					style={viewport ? { width: viewport } : { width: "100%" }}
				>
					{electron ? (
						<webview
							ref={webviewRef}
							src={current}
							partition="persist:omp-browser"
							allowpopups
							webpreferences="contextIsolation=yes, sandbox=yes"
							className="h-full w-full"
							style={{ display: "flex" }}
							{...({
								onDidStartLoading: () => setLoading(true),
								onDidStopLoading: () => setLoading(false),
							} as Record<string, unknown>)}
						/>
					) : (
						<iframe
							key={current}
							src={current}
							className="h-full w-full border-0"
							sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
							title={t("browser")}
							onLoad={() => setLoading(false)}
						/>
					)}
				</div>
			</div>
		</div>
	);
}
