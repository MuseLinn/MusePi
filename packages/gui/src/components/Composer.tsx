import { resolveToolRenderer, type ToolRenderHost } from "@musepi/desktop-web";
import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n/index.js";
import { ComposerFrame } from "../lib/composer-frame";
import { type ContextBreakdownView, isContextCommand } from "../lib/context-command";
import { tapFeedback } from "../lib/haptic";
import type { PetMood } from "../lib/pet";
import type { RpcClient } from "../lib/rpc";
import { sfxFor } from "../lib/sfx";
import {
	COMPOSER_DOCK_SLOT,
	COMPOSER_LEFT_SLOT,
	COMPOSER_RIGHT_SLOT,
	SlotComponentHost,
	useSlotComponents,
} from "../lib/slot-host";
import { isAutoresearchCommand, isDebugCommand, isUsageCommand } from "../lib/usage-command";
import { useFloatingMenu } from "../lib/use-floating-menu";
import { startDictation } from "../lib/voice";
import { Icon } from "../vendor/oc-icons";
import { AttachMenu } from "./AttachMenu";
import { AutoresearchPanel } from "./AutoresearchPanel";
import { ContextRing, type SnapcompactSavingsView, type UsageQuotaView } from "./ContextRing";
import {
	EnhanceButton,
	type EnhanceState,
	FocusButton,
	QueueChip,
	RetryButton,
	SendButton,
	StopButton,
	VoiceButton,
} from "./composer/action-buttons";
import { AgentStatusLine, CompactionStatusLine, readStatusPrefs } from "./composer/agent-status-line";
import { CompletionMenus, SlashNotice } from "./composer/completion-menus";
import { ContextUsageCard } from "./composer/context-dialog";
import { GoalDetailCard } from "./composer/goal-detail-card";
import { MagicKeywordTip } from "./composer/magic-keyword-tip";
import { GoalChip, PlanChip } from "./composer/mode-chips";
import { PlanPanel } from "./composer/plan-panel";
import { QueuePanel } from "./composer/queue-panel";
import { QuoteCards } from "./composer/quote-cards";
import { QueueToggleChip, SwarmChip, TodoChip } from "./composer/status-chips";
import { TodoPanel } from "./composer/todo-panel";
import type {
	UsageActiveAccountView,
	UsageDisabledCredentialView,
	UsageReloginDeadlineView,
	UsageReportsData,
	UsageReportView,
	UsageUnreportedAccountView,
} from "./composer/usage-panel";
import { fmtQuotaDuration, UsagePanelCard } from "./composer/usage-panel";
import { useAttachments } from "./composer/use-attachments";
import { useCompletion } from "./composer/use-completion";
import { useDraftPersistence } from "./composer/use-draft-persistence";
import { useModes } from "./composer/use-modes";
import { autosize, MIN_ROWS } from "./composer-autosize";
import { DebugToolsPanel } from "./DebugToolsPanel";
import { ExtensionStatusCard } from "./ExtensionStatusCard";
import { ModelSelector } from "./ModelSelector";
import { PetSprite, usePet } from "./PetSprite";
import { type ThinkingLevel, ThinkingSelector } from "./ThinkingSelector";

export type { AgentStatusEffect, AgentStatusIndicator, SweepColor } from "./composer/agent-status-line";
// Public surface — re-exported for existing importers (ChatView,
// WelcomeComposer, SettingsView, settings-sections).
export { AgentStatusLine, readStatusPrefs } from "./composer/agent-status-line";
export type {
	UsageActiveAccountView,
	UsageAmountView,
	UsageDisabledCredentialView,
	UsageLimitView,
	UsageReloginDeadlineView,
	UsageReportsData,
	UsageReportView,
	UsageUnreportedAccountView,
} from "./composer/usage-panel";
export { fmtQuotaDuration, UsageGapLines, UsageProviderSection } from "./composer/usage-panel";

export interface ComposerProps {
	working: boolean;
	/** Agent companion mood (伙伴) — derived by ChatView from the session
	 *  snapshot; the pet renders only when enabled + input mode. */
	petMood?: PetMood;
	onSend(
		text: string,
		images?: { type: "image"; data: string; mimeType: string }[],
		deliverAs?: "prompt" | "steer" | "followUp",
	): void;
	onStop(): void;
	rpc: RpcClient;
	sessionId: string;
	/** Session workspace root — feeds "@" file/folder completion. */
	cwd?: string;
	/** Current session thinking effort (snap.state.thinkingLevel). */
	thinkingLevel?: string | null;
	/** Per-model effort ceiling; higher ladder rungs disable. */
	thinkingCeiling?: string | null;
	/** Current model's exact effort ladder (getSupportedEfforts); undefined
	 *  shows the full fixed ladder. */
	thinkingEfforts?: readonly string[] | null;
	/** Quoted message texts to prepend (ZCode 引用回复 / Cmd+L 追加引用).
	 *  Each renders as a card above the input; the list is append-only from
	 *  the caller's side (quote buttons / global Cmd+L), cards close
	 *  individually, everything clears on send. */
	quotes: string[];
	onQuotesChange(next: string[]): void;
	/** User-message edit: load text into the composer. */
	pendingEdit?: string | null;
	onEditConsumed?(): void;
	onSetThinking?(level: ThinkingLevel | null): void;
	/** Model switch inside the composer (session.setModel) — parent re-fetches
	 *  per-model thinking info (ceiling/ladder) that the wire event can't
	 *  drive (the session store reference is stable across model changes). */
	onModelChange?(modelId: string): void;
	/** Model preselect carried from the welcome composer. */
	presetModelId?: string | null;
	/** Welcome 预设(mode)chip:仅 welcome 场景传入(modes 列表);会话态不传 → 不渲染。 */
	modes?: { id: string; label: string }[] | null;
	modeId?: string | null;
	onModeChange?(id: string | null): void;
	/** Modes v2:会话态热切换 —— chip 变为可点,下拉选预设走 session.setMode
	 *  RPC(welcome 的 onModeChange 只影响新会话创建;本回调作用于当前会话)。 */
	onSessionModeChange?(id: string | null): void;
	/** welcome 空态(true 时 modes/modeId/onModeChange 生效;会话态只读 label)。 */
	welcome?: boolean;
	/** 会话态当前预设 id(sessionModeLabel 的原始值,热切换 chip 打勾用)。 */
	sessionModeId?: string | null;
	/** 会话态只读预设标签(DSH AgentPresetLabel 对齐;welcome 时不显示)。 */
	sessionModeLabel?: string | null;
	/** Focus mode (openchamber ⌘⇧E): the composer fills the surface. */
	focused?: boolean;
	onToggleFocus?(): void;
	/** Live `task` tool running in this session (ChatView passes the last
	 *  active task tool's partialResult) — drives the temporary swarm status
	 *  chip above the input. Clicking the chip opens the frosted floating
	 *  member grid (avatar + progress), kimiwork parity. null → no chip. */
	activeTask?: { partialResult?: unknown } | null;
	/** Host for the floating member grid (agent trajectory drill-down). */
	swarmHost?: import("@musepi/desktop-web").ToolRenderHost;
}

/**
 * Floating member grid (kimiwork parity): renders the desktop-web task
 * renderer's SwarmCard against the live task tool's partialResult details
 * (progress/results) — the frosted card opened from the composer's
 * temporary swarm status chip. Host wires agent-trajectory drill-down.
 */
/**
 * Modes v2 会话态热切换 chip:点击展开预设列表,选中走 session.setMode RPC
 * (welcome 的 picker 只影响新会话创建;这里作用于当前会话)。样式与 welcome
 * 项目 chip 同款(按钮 + 浮层菜单),复读会话(无 handler)回退只读标签。
 */
function SessionModeChip({
	label,
	modes,
	currentId,
	onSelect,
}: {
	label: string;
	modes: { id: string; label: string }[];
	currentId: string | null;
	onSelect(id: string | null): void;
}): ReactNode {
	const [open, setOpen] = useState(false);
	return (
		<div className="relative z-20 flex-shrink-0">
			<button
				type="button"
				className="gui-mode-chip"
				title={t("modes title")}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen(v => !v)}
			>
				<Icon name="stack" className="h-3 w-3" />
				<span className="max-w-[160px] truncate">{label}</span>
				<Icon name="more" className="h-2.5 w-2.5 opacity-60" />
			</button>
			{open ? (
				<>
					<div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
					<div className="absolute right-0 z-20 mt-1 min-w-[180px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--color-surface)] p-1 shadow-[0_8px_32px_rgba(0,0,0,0.35)]">
						{modes.map(m => (
							<button
								key={m.id}
								type="button"
								className={`gui-view-opt${currentId === m.id ? " gui-view-opt--active" : ""}`}
								onClick={() => {
									onSelect(m.id);
									setOpen(false);
								}}
							>
								<span className="min-w-0 flex-1 truncate">{m.label}</span>
								{currentId === m.id && <Icon name="check" className="h-3 w-3 flex-shrink-0" />}
							</button>
						))}
					</div>
				</>
			) : null}
		</div>
	);
}

function SwarmCardPreview({ details, host }: { details?: unknown; host?: ToolRenderHost }): ReactNode {
	const SwarmCard = resolveToolRenderer("task").SwarmCard;
	if (!SwarmCard) return null;
	return <SwarmCard name="task" args={{}} result={{ content: [], details }} host={host} />;
}

function shouldSubmitOnEnter(e: KeyboardEvent<HTMLTextAreaElement>, composing: boolean): boolean {
	if (e.key !== "Enter") return false;
	// IME composition: the confirming Enter must commit the candidate text,
	// not send the message. isComposing covers standard IMEs; keyCode 229 is
	// Safari's legacy marker (WebKit dispatches Enter after compositionend,
	// when isComposing is already false).
	if (composing || e.nativeEvent.isComposing || e.keyCode === 229) return false;
	if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return false;
	return true;
}

/**
 * Prompt-enhancement (aicss AI Agent Input parity): rewrites the draft
 * via the session's model through the ephemeral side channel (same
 * runEphemeralTurn path as selection→ask — no transcript/journal write).
 * Falls back to the original prompt when the daemon is unreachable or
 * the model returns empty, so the enhance button never destroys input.
 */
async function enhancePrompt(prompt: string, rpc: RpcClient | null, sessionId: string | null): Promise<string> {
	if (!rpc || !sessionId) return prompt;
	try {
		const res = await rpc.request<{ replyText?: string }>("session.ephemeralAsk", {
			sessionId,
			promptText: `你是一个提示词优化助手。请把下面的提示词改写得更清晰、具体、可执行，保留原意，只输出改写后的提示词本身，不要任何解释或前缀后缀：\n\n${prompt}`,
		});
		const out = res?.replyText?.trim();
		return out && out.length > 0 ? out : prompt;
	} catch {
		return prompt;
	}
}

export function Composer({
	working,
	petMood,
	onSend,
	onStop,
	rpc,
	sessionId,
	cwd,
	thinkingLevel,
	onSetThinking,
	onModelChange,
	thinkingCeiling,
	thinkingEfforts,
	quotes,
	onQuotesChange,
	pendingEdit,
	onEditConsumed,
	presetModelId,
	focused,
	onToggleFocus,
	activeTask,
	swarmHost,
	modes: modeOptions,
	onSessionModeChange,
	welcome,
	sessionModeLabel,
	sessionModeId,
}: ComposerProps): ReactNode {
	const pet = usePet();
	// composer 座位槽(DSH conversation.input.dock/left/right 对齐):
	// dock = 输入卡上方行;left/right = 底部工具栏两端。list 语义 ——
	// 扩展声明 composer.dock/left/right 槽位即注入组件。
	const composerDockItems = useSlotComponents(rpc, COMPOSER_DOCK_SLOT);
	const composerLeftItems = useSlotComponents(rpc, COMPOSER_LEFT_SLOT);
	const composerRightItems = useSlotComponents(rpc, COMPOSER_RIGHT_SLOT);
	const [text, setText] = useState("");
	// Element picker (browser tool) inserts picked-page text into the draft.
	useEffect(() => {
		const onInsert = (e: Event): void => {
			const detail = (e as CustomEvent<{ text?: string }>).detail;
			const insertion = detail?.text;
			if (!insertion) return;
			setText(prev => (prev.length === 0 ? insertion : `${prev}\n${insertion}`));
		};
		window.addEventListener("musepi-gui-insert-text", onInsert);
		return () => window.removeEventListener("musepi-gui-insert-text", onInsert);
	}, []);
	const [enhance, setEnhance] = useState<EnhanceState>("idle");
	// Image paste/drop attachments (extracted: composer/use-attachments).
	const { attachments, setAttachments, addImageFiles, onPaste, onDrop } = useAttachments(rpc);
	const [dictating, setDictating] = useState(false);
	const [transcribing, setTranscribing] = useState(false);
	const [voiceSeconds, setVoiceSeconds] = useState(0);
	const [voiceLevel, setVoiceLevel] = useState(0);

	// ── Completion machinery + draft persistence (extracted to
	// composer/use-completion + composer/use-draft-persistence): the
	// destructured names below match the inlined originals exactly, so
	// the rest of the body is untouched. ─────────────────────────────────
	const {
		taRef,
		slashOpen,
		setSlashOpen,
		slashIdx,
		setSlashIdx,
		slashFilter,
		onSlashInput,
		insertSlash,
		atOpen,
		setAtOpen,
		atIdx,
		setAtIdx,
		atFilter,
		onAtInput,
		insertAt,
		hashOpen,
		setHashOpen,
		hashIdx,
		setHashIdx,
		hashFilter,
		hashLabel,
		onHashInput,
		insertHash,
	} = useCompletion({ rpc, cwd, setText });
	useDraftPersistence({ sessionId, rpc, text, setText });
	const spellcheckEnabled = (): boolean => {
		try {
			return localStorage.getItem("musepi-gui-chat-spellcheck") === "1";
		} catch {
			return false;
		}
	};

	// ── Goal / plan mode + todo progress (TUI /goal /plan parity) ─────────
	// Extracted to composer/use-modes; destructured names match the
	// inlined originals exactly.
	const {
		modes,
		setModes,
		todo,
		todoTotal,
		todoDone,
		goalArmed,
		setGoalArmed,
		toggleGoalMode,
		togglePlanMode,
		todoOp,
		refreshModes,
		todoOpen,
		setTodoOpen,
		appendText,
		setAppendText,
	} = useModes(rpc, sessionId);
	const stopDict = useRef<(() => void) | null>(null);

	// ── Context-window usage (usage ring) ─────────────────────────────────
	const [contextUsage, setContextUsage] = useState<{
		tokens: number;
		contextWindow: number;
		percent: number;
		model?: string | null;
		snapcompact?: SnapcompactSavingsView | null;
		breakdown?: ContextBreakdownView | null;
	} | null>(null);
	// Shared by the 3s poll and the model-switch immediate refresh — the
	// ring/card must follow a model change without waiting for the next tick.
	const refreshUsage = useCallback((): void => {
		if (!rpc || !sessionId) return;
		void rpc
			.request<{
				tokens: number;
				contextWindow: number;
				percent: number;
				model?: string | null;
				snapcompact?: SnapcompactSavingsView | null;
				breakdown?: ContextBreakdownView | null;
				autoCompactBufferTokens?: number;
				freeTokens?: number;
			} | null>("session.contextUsage", {
				sessionId,
			})
			.then(usage => {
				// Value-compare: skip the setState (and the re-render)
				// when the ring's numbers did not move. contextWindow is
				// part of the identity: an empty/low-use session switching
				// to a differently-sized model keeps percent=0 and
				// tokens=0, and without this the window line would freeze
				// on the old model's capacity. model rides along: the
				// composer's model selector seeds from it, and an external
				// switch (auto downshift, same-window-size model) must not
				// leave the displayed model stale.
				setContextUsage(prev =>
					usage &&
					prev &&
					prev.tokens === usage.tokens &&
					prev.percent === usage.percent &&
					prev.contextWindow === usage.contextWindow &&
					prev.model === usage.model
						? prev.snapcompact?.savedTokens === usage.snapcompact?.savedTokens
							? prev
							: usage
						: usage,
				);
				// Keep the /context card in step with the live session:
				// model switches change contextWindow/percent and the
				// card must follow instead of freezing at open time.
				setContextPanel(s => (s?.open ? { open: true, loading: false, data: usage } : s));
			})
			.catch(() => {});
	}, [rpc, sessionId]);
	useEffect(() => {
		if (!rpc || !sessionId) return;
		refreshUsage();
		// Event-driven freshness: poll only while the agent WORKS; the
		// `working` flip re-runs this effect (idle = zero polling).
		if (!working) return;
		// Same 3s cadence + visibility pause as the modes poll above.
		let id = setInterval(refreshUsage, 3000);
		const onVis = (): void => {
			clearInterval(id);
			if (document.visibilityState === "visible") {
				refreshUsage();
				id = setInterval(refreshUsage, 3000);
			}
		};
		document.addEventListener("visibilitychange", onVis);
		return () => {
			clearInterval(id);
			document.removeEventListener("visibilitychange", onVis);
		};
	}, [rpc, sessionId, refreshUsage, working]);

	// ── Manual context compaction (TUI /compact parity) ────────────────────
	// The ring shows usage; this is the escape hatch when it fills up. The
	// engine gates preconditions itself (summarizer model present, context
	// big enough, not already compacting) and throws otherwise — surface
	// that via a transient error state instead of swallowing it.
	const [compactBusy, setCompactBusy] = useState(false);
	const [compactFailed, setCompactFailed] = useState(false);
	// Set by cancelCompaction: the in-flight session.compact RPC rejects
	// with CompactionCancelledError once the daemon aborts it — a
	// deliberate cancel must NOT flash the red "compaction failed" state.
	const compactCancelledRef = useRef(false);
	const compactContext = useCallback((): void => {
		if (!rpc || !sessionId) return;
		setCompactBusy(true);
		void rpc
			.request<{ summary: string; shortSummary: string | null; tokensBefore: number }>("session.compact", {
				sessionId,
			})
			.then(() => {
				refreshModes();
				void rpc
					.request<{
						tokens: number;
						contextWindow: number;
						percent: number;
						snapcompact?: SnapcompactSavingsView | null;
					} | null>("session.contextUsage", {
						sessionId,
					})
					.then(usage => {
						if (usage) setContextUsage(prev => (prev && prev.tokens === usage.tokens ? prev : usage));
					})
					.catch(() => {});
			})
			.catch(() => {
				if (compactCancelledRef.current) return;
				setCompactFailed(true);
				window.setTimeout(() => setCompactFailed(false), 3000);
			})
			.finally(() => {
				compactCancelledRef.current = false;
				setCompactBusy(false);
			});
	}, [rpc, sessionId, refreshModes]);

	// ── Cancel compaction (TUI Esc parity) ────────────────────────────────
	// The daemon's session.abort routes into AgentSession.abort →
	// abortCompaction (the same path the TUI Esc uses), so the stop
	// button on the compaction status line cancels BOTH a manual
	// compactContext run and a daemon auto-compaction. No confirm —
	// aborting is cheap and the action can be re-triggered.
	const cancelCompaction = useCallback((): void => {
		if (!rpc || !sessionId) return;
		compactCancelledRef.current = true;
		void rpc.request("session.abort", { sessionId }).catch(() => {});
	}, [rpc, sessionId]);
	/** Compaction in flight: manual RPC pending OR daemon reports it (auto). */
	const compacting = compactBusy || modes?.isCompacting === true;

	// ── Provider subscription quota (TUI /usage parity) ───────────────────
	// Fetched lazily by the ContextRing popover (hover/focus); converts the
	// daemon's UsageReport[] wire shape into the compact popover view.
	const fetchUsageQuota = useCallback(async (): Promise<UsageQuotaView | null> => {
		if (!rpc || !sessionId) return null;
		try {
			const res = await rpc.request<{
				reports: Array<{
					provider: string;
					metadata?: Record<string, unknown>;
					limits: Array<{
						label: string;
						scope?: { accountId?: string; windowId?: string };
						amount?: { usedFraction?: number; remainingFraction?: number };
						window?: { id?: string; label?: string; resetsAt?: number; resetLabel?: string };
					}>;
				}>;
			}>("usage.reports", { sessionId });
			const reports = res?.reports ?? [];
			if (reports.length === 0) return null;
			// Same-provider credentials merge into window rows with one
			// side-by-side column each (tray / TUI /usage treatment) instead
			// of the old flattened limit list.
			const providers: Array<{
				provider: string;
				windows: Array<{
					key: string;
					label: string;
					cells: Array<{ cred: string; usedPercent: number; resetsIn?: string }>;
				}>;
			}> = [];
			for (const report of reports) {
				let providerEntry = providers.find(p => p.provider === report.provider);
				if (!providerEntry) {
					providerEntry = { provider: report.provider, windows: [] };
					providers.push(providerEntry);
				}
				const meta = report.metadata ?? {};
				const cred =
					(typeof meta.email === "string" && meta.email ? meta.email : undefined) ??
					(typeof meta.accountId === "string" && meta.accountId ? meta.accountId : undefined) ??
					report.provider;
				for (const limit of report.limits ?? []) {
					const usedFraction = limit.amount?.usedFraction;
					if (usedFraction === undefined) continue;
					const windowId = limit.window?.id ?? limit.scope?.windowId ?? "default";
					const winKey = `${limit.label}|${windowId}`;
					let win = providerEntry.windows.find(w => w.key === winKey);
					if (!win) {
						win = { key: winKey, label: limit.label, cells: [] };
						providerEntry.windows.push(win);
					}
					const resetsAt = limit.window?.resetsAt;
					win.cells.push({
						cred,
						usedPercent: usedFraction * 100,
						...(resetsAt && resetsAt > Date.now() ? { resetsIn: fmtQuotaDuration(resetsAt - Date.now()) } : {}),
					});
				}
			}
			const cleaned = providers
				.map(p => ({ provider: p.provider, windows: p.windows.filter(w => w.cells.length > 0) }))
				.filter(p => p.windows.length > 0);
			return cleaned.length > 0 ? { providers: cleaned } : null;
		} catch {
			return null;
		}
	}, [rpc, sessionId]);

	// GUI-native /usage: typing /usage in the composer shows this quota
	// panel (structured RPC data) instead of sending the command to the
	// agent (whose reply is TUI panel ANSI text). Panel is transient —
	// dismiss with the × button or Escape.
	const [usagePanel, setUsagePanel] = useState<{
		open: boolean;
		loading: boolean;
		data: UsageReportsData | null;
	}>({
		open: false,
		loading: false,
		data: null,
	});
	// Full report shape from usage.reports (daemon passes the raw
	// @musepi/pi-ai UsageReport[] through) — the panel renders TUI /usage
	// parity, while the ContextRing popover keeps its compact fetchUsageQuota.
	const fetchUsageReports = useCallback(async (): Promise<UsageReportsData | null> => {
		if (!rpc || !sessionId) return null;
		try {
			const res = await rpc.request<{
				reports: UsageReportView[];
				activeAccount?: UsageActiveAccountView | null;
				unreportedAccounts?: UsageUnreportedAccountView[];
				disabledCredentials?: UsageDisabledCredentialView[];
				reloginDeadlines?: UsageReloginDeadlineView[];
			}>("usage.reports", { sessionId });
			if (!res || !Array.isArray(res.reports)) return null;
			return {
				reports: res.reports,
				activeAccount: res.activeAccount ?? null,
				unreportedAccounts: res.unreportedAccounts ?? [],
				disabledCredentials: res.disabledCredentials ?? [],
				reloginDeadlines: res.reloginDeadlines ?? [],
				fetchedAt: Date.now(),
			};
		} catch {
			return null;
		}
	}, [rpc, sessionId]);
	const [arPanel, setArPanel] = useState(false);
	const openArPanel = useCallback((): void => {
		setContextPanel(null);
		setArPanel(true);
	}, []);
	const closeArPanel = useCallback((): void => setArPanel(false), []);
	// GUI-native /debug: TUI /debug is a TUI-only interactive menu
	// (session.slashCommand reports it "tui-only") — the GUI intercepts it
	// and shows the same diagnostics actions as a panel (TUI selector parity).
	const [debugPanel, setDebugPanel] = useState(false);
	const openDebugPanel = useCallback((): void => {
		setContextPanel(null);
		setDebugPanel(true);
	}, []);
	const closeDebugPanel = useCallback((): void => setDebugPanel(false), []);
	const openUsagePanel = useCallback((): void => {
		setContextPanel(null);
		setUsagePanel({ open: true, loading: true, data: null });
		void fetchUsageReports().then(data => {
			setUsagePanel(s => (s.open ? { open: true, loading: false, data } : s));
		});
	}, [fetchUsageReports]);
	// Quota panel: a floating card above the composer (user direction —
	// query results belong near the input, not in a modal dialog). Portaled
	// + fixed like the todo/queue panels so the chat surface can't clip it.
	const { anchorRef: quotaAnchorRef, renderMenu: renderQuotaMenu } = useFloatingMenu(
		usagePanel.open,
		v => setUsagePanel(s => ({ ...s, open: v })),
		// NOTE: no className here — the outer gui-menu-popup container must
		// NOT carry the card styles (that would double-draw the rounded card:
		// outer shell + inner .gui-quota-panel dialog). Card styles live on
		// the inner div only.
		{ align: "right" },
	);
	const closeUsagePanel = useCallback((): void => {
		setUsagePanel(s => ({ ...s, open: false }));
	}, []);
	// GUI-native /context: categorized context-window dialog (TUI /context
	// panel parity). Fetched from session.contextUsage with the full
	// breakdown the daemon now attaches; centered dialog like /usage.
	const [contextPanel, setContextPanel] = useState<{
		open: boolean;
		loading: boolean;
		data: {
			tokens: number;
			contextWindow: number;
			percent: number;
			model?: string | null;
			snapcompact?: SnapcompactSavingsView | null;
			breakdown?: ContextBreakdownView | null;
			autoCompactBufferTokens?: number;
			freeTokens?: number;
		} | null;
	} | null>(null);
	const openContextPanel = useCallback((): void => {
		if (!rpc || !sessionId) {
			setContextPanel({ open: true, loading: false, data: null });
			return;
		}
		setUsagePanel(s => ({ ...s, open: false }));
		setContextPanel({ open: true, loading: true, data: null });
		void rpc
			.request<{
				tokens: number;
				contextWindow: number;
				percent: number;
				model?: string | null;
				snapcompact?: SnapcompactSavingsView | null;
				breakdown?: ContextBreakdownView | null;
				autoCompactBufferTokens?: number;
				freeTokens?: number;
			} | null>("session.contextUsage", { sessionId })
			.then(usage => {
				setContextPanel(s => (s?.open ? { open: true, loading: false, data: usage } : s));
			})
			.catch(() => {
				setContextPanel(s => (s?.open ? { open: true, loading: false, data: null } : s));
			});
	}, [rpc, sessionId]);

	// Context dialog: same floating card (mutually exclusive with quota —
	// opening one closes the other).
	const { anchorRef: contextAnchorRef, renderMenu: renderContextMenu } = useFloatingMenu(
		contextPanel?.open ?? false,
		v => setContextPanel(s => (s ? { ...s, open: v } : s)),
		// NOTE: no className here — the outer gui-menu-popup container must
		// NOT carry the card styles (that would double-draw the rounded card:
		// outer shell + inner .gui-quota-panel dialog). Card styles live on
		// the inner div only.
		{ align: "right" },
	);

	// Goal detail card (TUI /goal menu + show parity): an anchored floating
	// panel under the goal chip — lifecycle actions + budget live here, not
	// on a binary toggle. Declared before the Escape handler so it can close.
	const [goalOpen, setGoalOpen] = useState(false);
	const goalAnchorRef = useRef<HTMLDivElement | null>(null);
	const { renderMenu: renderGoalMenu } = useFloatingMenu(goalOpen, v => setGoalOpen(v), { align: "right" });
	// Plan review panel (TUI plan-approval overlay parity): anchored under
	// the plan chip — approve/refine/exit, plan file read-only.
	const [planOpen, setPlanOpen] = useState(false);
	const planAnchorRef = useRef<HTMLDivElement | null>(null);
	const { renderMenu: renderPlanMenu } = useFloatingMenu(planOpen, v => setPlanOpen(v), { align: "right" });

	useEffect(() => {
		if (!usagePanel.open && !contextPanel?.open && !goalOpen && !planOpen) return;
		const onKey = (e: globalThis.KeyboardEvent): void => {
			if (e.key === "Escape") {
				setUsagePanel(s => ({ ...s, open: false }));
				setContextPanel(s => (s ? { ...s, open: false } : s));
				setGoalOpen(false);
				setPlanOpen(false);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [usagePanel.open, contextPanel?.open, goalOpen, planOpen]);

	// ── Retry last failed turn (TUI /retry parity) ─────────────────────────
	// The engine decides whether there is anything to retry (no failed turn
	// → false); the button only surfaces the outcome.
	const [retryBusy, setRetryBusy] = useState(false);
	const [retryNone, setRetryNone] = useState(false);
	const retryLastTurn = useCallback((): void => {
		if (!rpc || !sessionId) return;
		setRetryBusy(true);
		void rpc
			.request<{ ok: boolean }>("session.retry", { sessionId })
			.then(res => {
				if (!res.ok) {
					setRetryNone(true);
					window.setTimeout(() => setRetryNone(false), 3000);
				}
			})
			.catch(() => {})
			.finally(() => setRetryBusy(false));
	}, [rpc, sessionId]);

	// ── Pending-message queue (TUI /queue parity): while the agent works,
	// sent messages land in the follow-up queue — poll the live count so
	// the composer can show the "queue N" chip. Idle → nothing to show.
	const [queued, setQueued] = useState<{ count: number; steering: string[]; followUp: string[] } | null>(null);
	const [queueOpen, setQueueOpen] = useState(false);
	// Busy-state plain-Enter behavior (settings.busyEnter, dsh parity):
	// "steer" (TUI default — insert into the running turn now) or "queue"
	// (follow-up, delivered after the turn yields). Cmd/Ctrl+Enter flips it.
	const [busyEnter, setBusyEnter] = useState<"steer" | "queue">("steer");
	// Magic-keyword enable flags (settings.magicKeywords.*) — the composer
	// tip only advertises keywords the user has turned on.
	const [magicKeywords, setMagicKeywords] = useState<{
		enabled: boolean;
		ultrathink: boolean;
		orchestrate: boolean;
		workflow: boolean;
	}>({ enabled: true, ultrathink: true, orchestrate: true, workflow: true });
	useEffect(() => {
		if (!rpc) return;
		const load = (): void => {
			void rpc
				.request<Record<string, unknown> | null>("settings.get", { keys: ["busyEnter"] })
				.then(v => {
					const b = v?.busyEnter;
					if (b === "queue" || b === "steer") setBusyEnter(b);
				})
				.catch(() => {});
		};
		load();
		// Re-read when 设置 writes it, so an open composer follows the new
		// behavior without remounting.
		window.addEventListener("omp-settings-changed", load);
		return () => window.removeEventListener("omp-settings-changed", load);
	}, [rpc]);
	useEffect(() => {
		if (!rpc) return;
		const load = (): void => {
			void rpc
				.request<Record<string, unknown> | null>("settings.get", {
					keys: [
						"magicKeywords.enabled",
						"magicKeywords.ultrathink",
						"magicKeywords.orchestrate",
						"magicKeywords.workflow",
					],
				})
				.then(v => {
					setMagicKeywords(prev => ({
						enabled: v?.["magicKeywords.enabled"] !== false,
						ultrathink: (v?.["magicKeywords.ultrathink"] ?? prev.ultrathink) !== false,
						orchestrate: (v?.["magicKeywords.orchestrate"] ?? prev.orchestrate) !== false,
						workflow: (v?.["magicKeywords.workflow"] ?? prev.workflow) !== false,
					}));
				})
				.catch(() => {});
		};
		load();
		window.addEventListener("omp-settings-changed", load);
		return () => window.removeEventListener("omp-settings-changed", load);
	}, [rpc]);
	// 取回: pop the newest queued message back into the editor (TUI Alt+Up
	// parity) so the user can edit before re-sending.
	const popQueued = useCallback((): Promise<void> => {
		if (!rpc || !sessionId) return Promise.resolve();
		return rpc
			.request<{ text: string; images?: { type: string; data: string; mimeType: string }[] } | null>(
				"session.queuedPop",
				{
					sessionId,
				},
			)
			.then(res => {
				if (res?.text) {
					setText(prev => {
						const merged = prev.trim() ? `${prev.trim()}\n${res.text}` : res.text;
						requestAnimationFrame(() => autosize(taRef.current));
						return merged;
					});
					taRef.current?.focus();
				}
				// Optimistic count decrement — the next 3s poll confirms.
				setQueued(prev => (prev && prev.count > 0 ? { ...prev, count: prev.count - 1 } : prev));
			})
			.catch(() => {});
	}, [rpc, sessionId]);
	const clearQueued = useCallback((): Promise<void> => {
		if (!rpc || !sessionId) return Promise.resolve();
		return rpc
			.request("session.queuedClear", { sessionId })
			.then(() => {
				setQueueOpen(false);
				setQueued(prev => (prev ? { ...prev, count: 0, steering: [], followUp: [] } : prev));
			})
			.catch(() => {});
	}, [rpc, sessionId]);
	// 立即发出: pull one queued message out and inject it as an immediate
	// steer (TUI 引导消息回车即发 parity). Drop it from the local snapshot
	// right away; the 3s poll reconciles anything the daemon re-queues.
	const sendQueued = useCallback(
		(group: "steering" | "followUp", text: string, index: number): Promise<void> => {
			if (!rpc || !sessionId) return Promise.resolve();
			return rpc
				.request("session.queuedSend", { sessionId, group, text })
				.then(() => {
					setQueued(prev =>
						prev
							? {
									...prev,
									count: Math.max(0, prev.count - 1),
									[group]: prev[group].filter((_, i) => i !== index),
								}
							: prev,
					);
				})
				.catch(() => {});
		},
		[rpc, sessionId],
	);
	useEffect(() => {
		if (!rpc || !sessionId || !working) return;
		let disposed = false;
		const tick = (): void => {
			void rpc
				.request<{ count: number; steering: string[]; followUp: string[] }>("session.queued", { sessionId })
				.then(res => {
					if (disposed) return;
					setQueued(prev =>
						prev &&
						prev.count === res?.count &&
						prev.steering.length === res?.steering.length &&
						prev.followUp.length === res?.followUp.length
							? prev
							: res,
					);
				})
				.catch(() => {});
		};
		tick();
		// Event-driven freshness: poll only while the agent WORKS; the
		// `working` flip re-runs this effect (idle = zero polling).
		if (!working) return;
		let id = setInterval(tick, 3000);
		const onVis = (): void => {
			clearInterval(id);
			if (document.visibilityState === "visible") {
				tick();
				id = setInterval(tick, 3000);
			}
		};
		document.addEventListener("visibilitychange", onVis);
		return () => {
			disposed = true;
			clearInterval(id);
			document.removeEventListener("visibilitychange", onVis);
			setQueued(null);
		};
	}, [rpc, sessionId, working]);

	const composingRef = useRef(false);
	// Select-all + delete clears text AND attachments together (the flag
	// is consumed by onChange once the textarea reports the emptied value).
	const clearAllRef = useRef(false);
	// The completion menus (@/ #//) share one portaled anchor: the textarea.
	// Portaling lets the frosted glass sample real content behind the menu
	// (in-place, the composer frame's own backdrop is all the blur sees).
	const { anchorRef: menuAnchorRef, renderMenu: renderFloatMenu } = useFloatingMenu(
		slashOpen || atOpen || hashOpen,
		open => {
			if (open) return;
			setSlashOpen(false);
			setAtOpen(false);
			setHashOpen(false);
		},
	);
	// Todo panel: portaled the same way (gui-todo-panel used to be an
	// absolute child of the composer frame — it popped up past the chat
	// surface's overflow:hidden and got clipped, the panel's lower half
	// cut off behind the input. The floating menu portals to body with
	// fixed positioning and flips when the anchor is near the top).
	const { anchorRef: todoAnchorRef, renderMenu: renderTodoMenu } = useFloatingMenu(todoOpen, setTodoOpen, {
		className: "gui-todo-popup",
	});
	// Swarm status chip (kimiwork parity): while a `task` tool is running,
	// a temporary chip sits above the input; clicking opens the frosted
	// floating member grid (avatars + progress) — same portaled pattern.
	const [swarmOpen, setSwarmOpen] = useState(false);
	const { anchorRef: swarmAnchorRef, renderMenu: renderSwarmMenu } = useFloatingMenu(swarmOpen, setSwarmOpen, {
		className: "gui-swarm-popup",
	});
	// Pending-queue panel: same overflow clip as the todo panel — portaled.
	const { anchorRef: queueAnchorRef, renderMenu: renderQueueMenu } = useFloatingMenu(queueOpen, setQueueOpen, {
		className: "gui-queue-popup",
	});

	// ── Slash commands (TUI parity) ──────────────────────────────────────
	// "/xxx" executes the daemon's builtin registry headlessly; "//xxx"
	// escapes to literal text (the doubled slash parses to no command, so
	// the daemon reports consumed:false and we fall through to a normal
	// send). Output lines surface as a transient note above the input.
	const [slashNotice, setSlashNotice] = useState<{ level: "info" | "error"; text: string } | null>(null);
	const slashNoticeTimerRef = useRef<Timer | null>(null);
	const showSlashNotice = useCallback((level: "info" | "error", text: string): void => {
		setSlashNotice({ level, text });
		if (slashNoticeTimerRef.current) clearTimeout(slashNoticeTimerRef.current);
		slashNoticeTimerRef.current = setTimeout(() => setSlashNotice(null), 6000);
	}, []);
	const runSlash = useCallback(
		(command: string): void => {
			if (!rpc || !sessionId) return;
			void rpc
				.request<{ consumed: boolean; reason?: string; prompt?: string; outputs?: string[] }>(
					"session.slashCommand",
					{ sessionId, text: command },
				)
				.then(res => {
					if (!res) return;
					if (!res.consumed) {
						showSlashNotice(
							"error",
							res.reason === "tui-only"
								? t("this command only works in the terminal")
								: res.reason === "skill-not-found"
									? t("skill not found")
									: t("unknown slash command"),
						);
						return;
					}
					setText("");
					for (const line of res.outputs ?? []) {
						if (line) showSlashNotice("info", line);
					}
					if (res.prompt) {
						// Residual prompt (e.g. /force <tool> <prompt>): the
						// command kept the trailing text as a real message.
						onSend(res.prompt, [], undefined);
						sfxFor("send");
					}
				})
				.catch(() => showSlashNotice("error", t("slash command failed")));
		},
		[rpc, sessionId, onSend, showSlashNotice],
	);

	const runBash = useCallback(
		(command: string): void => {
			if (!rpc || !sessionId) return;
			void rpc
				.request<{
					command: string;
					excludeFromContext: boolean;
					exitCode: number | null;
					cancelled: boolean;
					totalLines: number;
					outputTruncated: boolean;
					output: string;
				}>("session.bashCommand", { sessionId, command })
				.then(res => {
					if (!res) return;
					setText("");
					if (res.cancelled) {
						showSlashNotice("info", t("bash command cancelled"));
						return;
					}
					let summary = t("bash exited with code {code} ({lines} lines)", {
						code: res.exitCode === null ? "?" : String(res.exitCode),
						lines: String(res.totalLines),
					});
					if (res.excludeFromContext) summary += ` · ${t("bash output excluded from context")}`;
					showSlashNotice(res.exitCode === 0 ? "info" : "error", summary);
				})
				.catch(() => showSlashNotice("error", t("bash command failed")));
		},
		[rpc, sessionId, showSlashNotice],
	);

	const send = useCallback(
		(accelerated = false): void => {
			const trimmed = text.trim();
			if (!trimmed && quotes.length === 0 && attachments.length === 0) return;
			// GUI-native /usage: show the structured quota panel instead of
			// sending the command to the agent (whose reply is TUI panel
			// ANSI text that never parses cleanly).
			if (isUsageCommand(trimmed)) {
				openUsagePanel();
				setText("");
				sfxFor("send");
				return;
			}
			// GUI-native /autoresearch: experiment dashboard panel.
			if (isAutoresearchCommand(trimmed)) {
				openArPanel();
				setText("");
				sfxFor("send");
				return;
			}
			// GUI-native /debug: diagnostics panel (TUI /debug selector
			// parity — the TUI command is TUI-only, so intercept like /usage).
			if (isDebugCommand(trimmed)) {
				openDebugPanel();
				setText("");
				sfxFor("send");
				return;
			}
			// GUI-native /context: categorized context-window dialog (same
			// reason — the agent's /context reply is ANSI panel text).
			if (isContextCommand(trimmed)) {
				openContextPanel();
				setText("");
				sfxFor("send");
				return;
			}
			// Delivery semantics MUST match the TUI:
			//  - Enter while the agent works → the configured busy behavior
			//    (busyEnter: steer = insert into the running turn now, TUI
			//    default; queue = follow-up delivered after the turn yields).
			//    Cmd/Ctrl+Enter (accelerated) uses the OPPOSITE behavior
			//    (dsh parity: "Cmd/Ctrl+Enter 使用另一行为").
			//  - Plain Enter when idle is a normal prompt (streamingBehavior:
			//    steer covers the race).
			//  - "/queue <msg>" / "=> <msg>" → followUp explicitly.
			let payload = trimmed;
			const effectiveBusy = accelerated ? (busyEnter === "queue" ? "steer" : "queue") : busyEnter;
			let delivery: "steer" | "followUp" | undefined = working
				? effectiveBusy === "queue"
					? "followUp"
					: "steer"
				: undefined;
			const queueMatch = /^\/queue\s+(.+)$/s.exec(trimmed);
			const arrowMatch = /^=>\s+(.+)$/s.exec(trimmed);
			if (queueMatch) {
				payload = queueMatch[1].trim();
				delivery = "followUp";
			} else if (arrowMatch) {
				payload = arrowMatch[1].trim();
				delivery = "followUp";
			} else if (trimmed === "/queue") {
				setText("");
				return;
			} else if (
				trimmed.startsWith("/") &&
				!trimmed.startsWith("//") &&
				quotes.length === 0 &&
				attachments.length === 0
			) {
				// Slash command (TUI parity): execute via the daemon's builtin
				// registry. "//" escapes to literal text — the doubled slash
				// parses to no command, the daemon returns consumed:false and
				// we fall through to a normal send below. Close the completion
				// menu now — the RPC round-trip takes longer than the menu's
				// exit animation, and leaving it up reads as "Enter did nothing".
				setSlashOpen(false);
				runSlash(trimmed);
				return;
			} else if (
				trimmed.startsWith("!") &&
				(trimmed.startsWith("!!") ? trimmed.slice(2) : trimmed.slice(1)).trim().length > 0 &&
				quotes.length === 0 &&
				attachments.length === 0
			) {
				// Bash command (TUI !/!! parity): "!cmd" runs the shell command
				// with its output kept in the model context; "!!cmd" excludes
				// it. A bare "!" (or "!!") falls through to a normal send.
				setSlashOpen(false);
				runBash(trimmed);
				return;
			}
			if (!payload && attachments.length === 0) return;
			// Armed goal (openchamber parity): the sent message becomes the
			// objective — no popup dialog. The daemon creates the goal from the
			// prompt text; the chip confirms via the modes poll.
			if (goalArmed && payload && rpc && sessionId) {
				void rpc
					.request("session.setGoal", { sessionId, objective: payload })
					.then(res => setModes(res as typeof modes))
					.catch(() => {});
				setGoalArmed(false);
			}
			const quotePrefix =
				quotes.length > 0 ? `${quotes.map(q => `> ${q.split("\n").join("\n> ")}`).join("\n\n")}\n\n` : "";
			onSend(
				quotePrefix ? `${quotePrefix}${payload}`.trim() : payload,
				attachments.map(a => ({
					type: "image" as const,
					data: a.dataUrl.split(",")[1] ?? "",
					mimeType: a.mimeType,
				})),
				// Working → steer (TUI Enter parity: processed immediately);
				// "/queue"/"=>" → followUp (after the current turn yields).
				delivery,
			);
			if (quotes.length > 0) {
				handledQuoteCountRef.current = 0;
				onQuotesChange([]);
			}
			setText("");
			setAttachments([]);
			setEnhance("idle");
			// Clear re-measures: the controlled value="", onChange never fires for
			// the programmatic clear, so the stretched inline height would stick
			// (send with a multi-line draft leaves the box tall). rAF runs after
			// React commits the empty value.
			requestAnimationFrame(() => autosize(taRef.current));
			sfxFor("send");
			tapFeedback();
		},
		[
			text,
			onSend,
			attachments,
			working,
			goalArmed,
			rpc,
			sessionId,
			quotes,
			onQuotesChange,
			busyEnter,
			openUsagePanel,
			openContextPanel,
		],
	);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		// IME composition: every key (including the confirming Enter) belongs
		// to the editor — never run completion or submit while composing.
		if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) {
			return;
		}
		// Attachment keyboard flow (WeChat parity): Backspace/Delete on an
		// empty input removes the last image chip; a select-all delete marks
		// the input as being cleared so onChange empties attachments too.
		if (e.key === "Backspace" || e.key === "Delete") {
			const ta = taRef.current;
			if (ta) {
				if (ta.value.length === 0 && attachments.length > 0) {
					e.preventDefault();
					setAttachments(prev => prev.slice(0, -1));
					return;
				}
				if (ta.selectionStart === 0 && ta.selectionEnd === ta.value.length && ta.value.length > 0) {
					clearAllRef.current = true;
				}
			}
		}
		if (slashOpen && slashFilter.length > 0) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSlashIdx(v => (v + 1) % slashFilter.length);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setSlashIdx(v => (v - 1 + slashFilter.length) % slashFilter.length);
				return;
			}
			if (e.key === "Enter") {
				e.preventDefault();
				const pick = slashFilter[slashIdx];
				if (pick) insertSlash(pick.name);
				return;
			}
			if (e.key === "Escape") {
				setSlashOpen(false);
				return;
			}
		}
		if (atOpen && atFilter.length > 0) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setAtIdx(v => (v + 1) % atFilter.length);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setAtIdx(v => (v - 1 + atFilter.length) % atFilter.length);
				return;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				const pick = atFilter[atIdx];
				if (pick) insertAt(pick.path);
				return;
			}
			if (e.key === "Escape") {
				setAtOpen(false);
				return;
			}
		}
		if (hashOpen && hashFilter.length > 0) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setHashIdx(v => (v + 1) % hashFilter.length);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setHashIdx(v => (v - 1 + hashFilter.length) % hashFilter.length);
				return;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				const pick = hashFilter[hashIdx];
				if (pick) insertHash(pick.id);
				return;
			}
			if (e.key === "Escape") {
				setHashOpen(false);
				return;
			}
		}
		// Cmd/Ctrl+Enter (dsh parity): send with the OPPOSITE busy behavior
		// of the configured plain-Enter mode.
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && !composingRef.current) {
			e.preventDefault();
			send(true);
			return;
		}
		if (shouldSubmitOnEnter(e, composingRef.current)) {
			e.preventDefault();
			send();
		}
	};

	const canSend = text.trim().length > 0;

	const runEnhance = useCallback((): void => {
		if (!canSend || enhance === "enhancing") return;
		setEnhance("enhancing");
		void enhancePrompt(text, rpc, sessionId)
			.then(enhanced => {
				setText(enhanced);
				// The rewritten prompt is typically longer — re-measure (the
				// enhanced value lands via state, not onChange, so autosize
				// never ran).
				requestAnimationFrame(() => autosize(taRef.current));
				setEnhance("enhanced");
				sfxFor("first");
			})
			.catch(() => setEnhance("idle"));
	}, [canSend, enhance, text]);

	// Enhanced state decays back to idle once the user edits the prompt.
	useEffect(() => {
		// text.length is only a re-run trigger (any edit decays the state).
		void text.length;
		if (enhance === "enhanced") setEnhance("idle");
	}, [enhance, text.length]);

	// ZCode 引用回复 / Cmd+L 追加引用: quoted texts render as cards above
	// the input (not raw `> ` text pasted into the box). The count guard
	// runs the focus effect exactly once per newly appended quote; cards
	// stay until the message is sent or closed individually.
	const handledQuoteCountRef = useRef(0);
	useEffect(() => {
		if (quotes.length === 0 || handledQuoteCountRef.current === quotes.length) return;
		handledQuoteCountRef.current = quotes.length;
		requestAnimationFrame(() => {
			taRef.current?.focus();
			autosize(taRef.current);
		});
	}, [quotes]);

	// User-message edit: replace composer text (TUI /retry-edit parity),
	// exactly once per incoming edit.
	const handledEditRef = useRef<string | null>(null);
	useEffect(() => {
		if (pendingEdit == null || handledEditRef.current === pendingEdit) return;
		handledEditRef.current = pendingEdit;
		setText(pendingEdit);
		requestAnimationFrame(() => {
			taRef.current?.focus();
			autosize(taRef.current);
		});
		onEditConsumed?.();
	}, [pendingEdit, onEditConsumed]);

	// Keep the textarea aware of focus mode (autosize defers to flex fill).
	useEffect(() => {
		const ta = taRef.current;
		if (!ta) return;
		ta.dataset.focused = focused ? "1" : "0";
		autosize(ta);
	}, [focused]);

	return (
		<div
			className={`gui-composer${focused ? " gui-composer--focused" : ""}`}
			ref={el => {
				quotaAnchorRef(el);
				contextAnchorRef(el);
			}}
		>
			{/* GUI-native /usage result — floating card above the composer
			 * (user direction: query results belong near the input, not a
			 * modal dialog). Portaled + fixed so the surface can't clip it. */}
			{renderQuotaMenu(
				<UsagePanelCard data={usagePanel.data} loading={usagePanel.loading} onClose={closeUsagePanel} />,
			)}
			{/* GUI-native /context — categorized context-window card above
			 * the composer (TUI /context panel parity), floating like /usage. */}
			{contextPanel
				? renderContextMenu(
						<ContextUsageCard
							data={contextPanel.data}
							loading={contextPanel.loading}
							onClose={() => setContextPanel(s => (s ? { ...s, open: false } : s))}
						/>,
					)
				: null}
			{/* TUI widget/selector parity panels (DialogFrame portals to
			 * document.body; mounted here, not conditionally, so the exit
			 * animation plays — open flags drive them). */}
			<AutoresearchPanel open={arPanel} onClose={closeArPanel} rpc={rpc} cwd={cwd} />
			<DebugToolsPanel open={debugPanel} onClose={closeDebugPanel} rpc={rpc} sessionId={sessionId} />
			{/* Goal detail card — anchored floating panel under the goal chip
			 * (same shape as the quota/context cards): full objective, usage/
			 * budget, and lifecycle actions, opened from the chip. */}
			{goalOpen
				? renderGoalMenu(
						<GoalDetailCard
							rpc={rpc}
							sessionId={sessionId}
							onClose={() => setGoalOpen(false)}
							onChanged={refreshModes}
						/>,
					)
				: null}
			{/* Plan review panel (TUI plan-approval overlay parity): plan file +
			 * approve/refine/exit, anchored under the plan chip. */}
			{planOpen
				? renderPlanMenu(
						<PlanPanel
							rpc={rpc}
							sessionId={sessionId}
							onClose={() => setPlanOpen(false)}
							onChanged={refreshModes}
						/>,
					)
				: null}
			{/* Agent status line — hangs ABOVE the input card, outside the
			 * frame (user: the thinking state belongs here, not inside
			 * the input, not duplicated in the transcript): braille
			 * spinner or orb + label on one line. Shows 思考中… while
			 * working and briefly 思考完毕 when the turn ends. While the
			 * context is being compacted it is replaced by the compaction
			 * line (spinner + 停止 button) — compaction runs between
			 * turns, so the two never overlap. */}
			{compacting ? (
				<CompactionStatusLine onCancel={cancelCompaction} />
			) : (
				<AgentStatusLine working={working} sessionKey={sessionId || undefined} {...readStatusPrefs()} />
			)}
			<ComposerFrame
				flipAnchor="session"
				onAnnotated={text => {
					setText(prev => (prev ? `${prev}\n${text}` : text));
					requestAnimationFrame(() => autosize(taRef.current));
				}}
				// openchamber parity: the selection-capture module excludes
				// selections inside the composer (Cmd/Ctrl+L must not re-quote
				// what is being typed).
				chatInput
				pet={
					pet.enabled && pet.mode === "input" ? (
						<PetSprite mood={petMood ?? "rest"} pet={pet.pet} size={30} />
					) : null
				}
				// Agent-working glow (user: welcome shows the beam on focus,
				// the session composer shows it while the agent works).
				hero
				heroActive={working}
				enhancing={enhance === "enhancing"}
				attachments={attachments}
				onRemoveAttachment={id => setAttachments(prev => prev.filter(p => p.id !== id))}
				// Status row ABOVE the input (kimi-code parity): todo progress
				// and the editable pending-queue live here — plan/goal mode
				// chips sit in the button row next to the thinking selector.
				// Renders whenever ANY of them is present.
				statusRow={
					composerDockItems.length > 0 ||
					(modes && (todoTotal > 0 || (working && queued != null && queued.count > 0))) ||
					activeTask ? (
						<div className="gui-composer-dock">
							{composerDockItems.length > 0 && (
								<SlotComponentHost rpc={rpc} slot={COMPOSER_DOCK_SLOT} sessionId={sessionId} cwd={cwd} />
							)}
							{((modes && (todoTotal > 0 || (working && queued != null && queued.count > 0))) || activeTask) && (
								<div className="gui-mode-row gui-mode-row--status">
									{activeTask && (
										<SwarmChip
											open={swarmOpen}
											onToggle={() => setSwarmOpen(v => !v)}
											anchorRef={swarmAnchorRef}
											menu={renderSwarmMenu(
												<div className="gui-swarm-popup-card" role="region" aria-label={t("swarm members")}>
													<SwarmCardPreview
														details={
															(activeTask.partialResult as { details?: unknown } | null | undefined)
																?.details
														}
														host={swarmHost}
													/>
												</div>,
											)}
										/>
									)}
									{todoTotal > 0 && (
										<TodoChip
											open={todoOpen}
											onToggle={() => setTodoOpen(v => !v)}
											anchorRef={todoAnchorRef}
											done={todoDone}
											total={todoTotal}
											title={todo.map(p => `${p.name} ${p.done}/${p.total}`).join(" · ")}
										/>
									)}
									{renderTodoMenu(
										<TodoPanel
											phases={todo}
											onOp={todoOp}
											appendText={appendText}
											onAppendChange={setAppendText}
										/>,
									)}
									{/* Pending-message queue (TUI /queue parity): editable list
									 * above the input — 取回 pops the newest queued message
									 * back into the editor. */}
									{working && queued && queued.count > 0 && (
										<>
											<QueueToggleChip
												open={queueOpen}
												onToggle={() => setQueueOpen(v => !v)}
												anchorRef={queueAnchorRef}
												count={queued.count}
											/>
											{renderQueueMenu(
												<QueuePanel
													queued={queued}
													onSend={sendQueued}
													onPop={popQueued}
													onClear={clearQueued}
												/>,
											)}
										</>
									)}
								</div>
							)}
						</div>
					) : null
				}
				footerLeft={
					<>
						{/* composer.left 座位槽(DSH conversation.input.left 对齐):
						 * 扩展声明 composer.left 槽位即注入工具栏左端。 */}
						<SlotComponentHost rpc={rpc} slot={COMPOSER_LEFT_SLOT} sessionId={sessionId} cwd={cwd} />
						<AttachMenu
							goalMode={modes?.goalMode?.enabled === true || goalArmed}
							planMode={modes?.planMode === true}
							onToggleGoal={toggleGoalMode}
							onTogglePlan={togglePlanMode}
							onGuidedGoal={() => {
								// TUI /guided-goal parity: the agent interviews
								// the user in chat, then creates the goal. The
								// current draft rides along as the rough
								// objective when present.
								if (!rpc || !sessionId) return;
								const objective = text.trim() || undefined;
								void rpc.request("session.goal", { sessionId, op: "guided", objective }).catch(() => {});
							}}
							onPickImages={files => void addImageFiles(files)}
							onInsert={token => {
								const ta = taRef.current;
								if (!ta) return;
								ta.focus();
								const start = ta.selectionStart ?? text.length;
								const end = ta.selectionEnd ?? text.length;
								ta.setRangeText(token, start, end, "end");
								setText(ta.value);
								autosize(ta);
							}}
						/>
						{/* 会话扩展状态卡(DSH Cordis Plugin 卡片参考吸收):运行中扩展数 +
						 * 浮窗状态列表。 */}
						{!welcome && <ExtensionStatusCard rpc={rpc} />}
						{/* Pending-message queue chip (TUI /queue parity): visible
						 * while the agent works and messages are queued behind
						 * the current turn; hover shows the queued texts. */}
						{working && queued && queued.count > 0 && (
							<QueueChip count={queued.count} title={[...queued.steering, ...queued.followUp].join("\n")} />
						)}
						{/* Focus mode sits between the attach menu and the model
						 * selector (openchamber ComposerFooter order). */}
						{onToggleFocus && <FocusButton focused={focused ?? false} onPress={onToggleFocus} />}
						{!welcome &&
							sessionModeLabel &&
							(onSessionModeChange && modeOptions ? (
								<SessionModeChip
									label={sessionModeLabel}
									modes={modeOptions}
									currentId={sessionModeId ?? null}
									onSelect={onSessionModeChange}
								/>
							) : (
								<span className="gui-mode-label" title={t("modes title")}>
									{sessionModeLabel}
								</span>
							))}
						<ModelSelector
							rpc={rpc}
							sessionId={sessionId}
							presetId={presetModelId}
							currentModelId={contextUsage?.model ?? null}
							allowSetDefault
							onSelect={id => {
								if (id) onModelChange?.(id);
								// The daemon finished the switch before this
								// fires — refresh the ring/card immediately so
								// they show the new model's window without
								// waiting for the next 3s poll.
								refreshUsage();
							}}
						/>
						{onSetThinking && (
							<ThinkingSelector
								value={thinkingLevel}
								onChange={onSetThinking}
								ceiling={thinkingCeiling}
								efforts={thinkingEfforts}
							/>
						)}
						{/* Mode chips sit IN the button row, right of the thinking
						 * selector (not above the input): plan/goal state is one
						 * of the composer's toggles. */}
						<div ref={goalAnchorRef}>
							{(modes?.goalMode?.enabled === true || modes?.goalMode?.status === "paused" || goalArmed) && (
								<GoalChip
									armed={goalArmed}
									paused={modes?.goalMode?.enabled === false}
									objective={modes?.goalMode?.objective ?? ""}
									onToggle={toggleGoalMode}
									onOpen={() => setGoalOpen(true)}
								/>
							)}
						</div>
						{modes?.planMode === true && (
							<div ref={planAnchorRef}>
								<PlanChip onOpen={() => setPlanOpen(true)} />
							</div>
						)}
						{canSend && (
							<EnhanceButton
								state={enhance}
								onToggle={() => {
									if (enhance === "enhancing") return;
									if (enhance === "enhanced") {
										setEnhance("idle");
										return;
									}
									runEnhance();
								}}
							/>
						)}
					</>
				}
				footerRight={
					<>
						{/* composer.right 座位槽(DSH conversation.input.right 对齐):
						 * 扩展声明 composer.right 槽位即注入工具栏右端。 */}
						<SlotComponentHost rpc={rpc} slot={COMPOSER_RIGHT_SLOT} sessionId={sessionId} cwd={cwd} />
						{contextUsage != null && (
							<ContextRing
								percent={contextUsage.percent}
								tokens={contextUsage.tokens}
								contextWindow={contextUsage.contextWindow}
								onCompact={compactContext}
								compacting={compacting}
								compactFailed={compactFailed}
								snapcompact={contextUsage.snapcompact ?? null}
								fetchQuota={fetchUsageQuota}
							/>
						)}
						<VoiceButton
							state={dictating ? (transcribing ? "transcribing" : "recording") : "idle"}
							seconds={voiceSeconds}
							level={voiceLevel}
							onToggle={() => {
								if (dictating) {
									stopDict.current?.();
									setDictating(false);
									setTranscribing(false);
									return;
								}
								const stop = startDictation(
									transcript => {
										setText(prev => (prev ? `${prev} ${transcript}` : transcript));
										requestAnimationFrame(() => autosize(taRef.current));
										setDictating(false);
										setTranscribing(false);
									},
									() => {
										setDictating(false);
										setTranscribing(false);
									},
									rpc,
									activity => {
										if (activity.phase === "recording") {
											setVoiceSeconds(activity.seconds);
											setVoiceLevel(activity.level);
											setTranscribing(false);
										} else if (activity.phase === "transcribing") {
											setTranscribing(true);
										}
									},
								);
								stopDict.current = stop;
								if (stop) {
									setDictating(true);
									setVoiceSeconds(0);
									setVoiceLevel(0);
								}
							}}
						/>
						{working && (
							<StopButton
								onPress={() => {
									tapFeedback(2);
									onStop();
								}}
							/>
						)}
						{!working && <RetryButton busy={retryBusy} none={retryNone} onPress={retryLastTurn} />}
						<SendButton
							canSend={canSend}
							busy={enhance === "enhancing"}
							working={working}
							onPress={() => send()}
						/>
					</>
				}
			>
				{slashNotice && <SlashNotice level={slashNotice.level} text={slashNotice.text} />}
				{magicKeywords.enabled && (
					<MagicKeywordTip
						text={text}
						enabled={{
							ultrathink: magicKeywords.ultrathink,
							orchestrate: magicKeywords.orchestrate,
							workflow: magicKeywords.workflow,
						}}
					/>
				)}
				{quotes.length > 0 && (
					<QuoteCards
						quotes={quotes}
						onRemove={i => {
							handledQuoteCountRef.current = 0;
							onQuotesChange(quotes.filter((_, j) => j !== i));
						}}
					/>
				)}
				<textarea
					ref={el => {
						taRef.current = el;
						menuAnchorRef(el);
					}}
					value={text}
					rows={MIN_ROWS}
					onPaste={onPaste}
					onDrop={onDrop}
					onChange={e => {
						setText(e.target.value);
						if (clearAllRef.current) {
							clearAllRef.current = false;
							if (e.target.value === "") setAttachments([]);
						}
						onSlashInput(e.target.value);
						onAtInput(e.target.value);
						onHashInput(e.target.value);
						autosize(taRef.current);
					}}
					onCompositionStart={() => {
						composingRef.current = true;
					}}
					onCompositionEnd={() => {
						// Deferred a tick: WebKit dispatches the confirming Enter
						// after compositionend, when isComposing is already false.
						setTimeout(() => {
							composingRef.current = false;
						}, 0);
					}}
					onKeyDown={onKeyDown}
					placeholder={
						working
							? t("agent working — send steers the agent now, /queue waits for the turn to end…")
							: t("ask anything, / for commands, @ for context…")
					}
					spellCheck={spellcheckEnabled()}
					autoComplete="off"
				/>
				{renderFloatMenu(
					<CompletionMenus
						slashOpen={slashOpen}
						slashItems={slashFilter}
						slashIdx={slashIdx}
						onPickSlash={insertSlash}
						atOpen={atOpen}
						atEntries={atFilter}
						atIdx={atIdx}
						onPickAt={insertAt}
						hashOpen={hashOpen}
						hashSessions={hashFilter}
						hashIdx={hashIdx}
						hashLabel={hashLabel}
						onPickHash={insertHash}
					/>,
				)}
			</ComposerFrame>
		</div>
	);
}
