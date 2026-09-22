import type { KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n/index.js";
import { ComposerFrame } from "../lib/composer-frame";
import { type ContextBreakdownView, isContextCommand } from "../lib/context-command";
import { tapFeedback } from "../lib/haptic";
import type { PetMood, PetState } from "../lib/pet";
import type { RpcClient } from "../lib/rpc";
import { sfxFor } from "../lib/sfx";
import { eventMatches } from "../lib/shortcut-registry";
import type { SketchScene } from "../lib/sketch-scene";
import {
	COMPOSER_DOCK_SLOT,
	COMPOSER_LEFT_SLOT,
	COMPOSER_RIGHT_SLOT,
	SlotComponentHost,
	useSlotComponents,
} from "../lib/slot-host";
import { isAutoresearchCommand, isDebugCommand, isUsageCommand } from "../lib/usage-command";
import { useFloatingMenu } from "../lib/use-floating-menu";
import type { SttSubmitTrigger } from "../lib/voice";
import { AttachMenu } from "./AttachMenu";
import { AutoresearchPanel } from "./AutoresearchPanel";
import { ContextRing, type SnapcompactSavingsView, type UsageQuotaView, type UsageSummaryView } from "./ContextRing";
import {
	EnhanceButton,
	type EnhanceState,
	FocusButton,
	RetryButton,
	SendOrStopButton,
	VoiceButton,
	VoiceStatusStrip,
} from "./composer/action-buttons";
import { CompactionStatusLine } from "./composer/agent-status-line";
import { ApprovalModeButton } from "./composer/approval-mode-button";
import { CompletionMenus, SlashNotice } from "./composer/completion-menus";
import { ContextUsageCard } from "./composer/context-dialog";
import { DESIGN_STYLES, DesignStyleSelect } from "./composer/design-styles";
import { GoalDetailCard } from "./composer/goal-detail-card";
import { ComposerHighlight } from "./composer/input-highlight";
import { type LongPasteAction, LongPasteDialog } from "./composer/long-paste-dialog";
import { MagicKeywordTip } from "./composer/magic-keyword-tip";
import { GoalChip, PlanChip } from "./composer/mode-chips";
import { PlanPanel } from "./composer/plan-panel";
import { QueuePanel } from "./composer/queue-panel";
import { QuoteCards } from "./composer/quote-cards";
import { SessionModeToggles } from "./composer/session-mode-toggles";
import { SlashCommandTip } from "./composer/slash-command-tip";
import { QueueToggleChip, SwarmChip, TodoChip } from "./composer/status-chips";
import { SwarmCardPreview } from "./composer/swarm-card-preview";
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
import {
	attachmentsFromWireImages,
	dataUrlToFile,
	markSketchChip,
	nextSketchFileName,
	uploadAttachmentFiles,
	useAttachments,
} from "./composer/use-attachments";
import { useCompletion } from "./composer/use-completion";
import { useDictation } from "./composer/use-dictation";
import { useDraftPersistence } from "./composer/use-draft-persistence";
import { useInputHistory } from "./composer/use-input-history";
import { isLongPastedText, useLongTextPaste } from "./composer/use-long-text-paste";
import { useModes } from "./composer/use-modes";
import { autosize, MIN_ROWS } from "./composer-autosize";
import { DebugToolsPanel } from "./DebugToolsPanel";
import { ExtensionStatusCard } from "./ExtensionStatusCard";
import { ModelThinkingCapsule } from "./ModelThinkingCapsule";
import { PetSprite, usePet } from "./PetSprite";
import { SketchPad } from "./SketchPad";
import type { ThinkingLevel } from "./ThinkingSelector";

// Design style chips (设计稿 08) live in composer/design-styles.tsx —
// shared with the welcome empty-state composer (same chips, same
// brief-update protocol).

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
	/** The 31-state session reading (pet.ts PetState). Carried alongside
	 *  `petMood` rather than replacing it: the mood still selects the
	 *  spritesheet row and the CSS material class, the state selects the
	 *  face, the body motion and the effects layer. */
	petState?: PetState | null;
	onSend(
		text: string,
		images?: { type: "image"; data: string; mimeType: string }[],
		deliverAs?: "prompt" | "steer" | "followUp" | "continue",
	): void;
	onStop(): void;
	rpc: RpcClient;
	sessionId: string;
	/** Session workspace root — feeds "@" file/folder completion. */
	cwd?: string;
	/** Current session thinking effort (snap.state.thinkingLevel). */
	thinkingLevel?: string | null;
	/** Configured selector state (auto vs pinned) — menu highlight. */
	thinkingConfigLevel?: string | null;
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
	/** 添加新提供商 menu action — opens the settings providers page. */
	onAddProvider?(): void;
	/** Model preselect carried from the welcome composer. */
	presetModelId?: string | null;
	/** welcome 空态(会话态不传)。 */
	welcome?: boolean;
	/** Focus mode (openchamber ⌘⇧E): the composer fills the surface. */
	focused?: boolean;
	onToggleFocus?(): void;
	/** /btw 旁路提问 (TUI parity): intercept the slash command and hand the
	 *  question to the caller (ChatView shows BtwFloatingCard) instead of
	 *  sending it to the agent (whose btw is TUI-only). */
	onBtw?(question: string): void;
	/** Live `task` tool running in this session (ChatView passes the last
	 *  active task tool's partialResult) — drives the temporary swarm status
	 *  chip above the input. Clicking the chip opens the frosted floating
	 *  member grid (avatar + progress), kimiwork parity. null → no chip. */
	activeTask?: { partialResult?: unknown } | null;
	/** Host for the floating member grid (agent trajectory drill-down). */
	swarmHost?: import("@musepi/client-core").ToolRenderHost;
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
	petState,
	onSend,
	onStop,
	rpc,
	sessionId,
	cwd,
	thinkingLevel,
	thinkingConfigLevel,
	onSetThinking,
	onModelChange,
	onAddProvider,
	thinkingCeiling,
	thinkingEfforts,
	quotes,
	onQuotesChange,
	pendingEdit,
	onEditConsumed,
	presetModelId,
	focused,
	onToggleFocus,
	onBtw,
	activeTask,
	swarmHost,
	welcome,
}: ComposerProps): ReactNode {
	const pet = usePet();
	// composer 座位槽(DSH conversation.input.dock/left/right 对齐):
	// dock = 输入卡上方行;left/right = 底部工具栏两端。list 语义 ——
	// 扩展声明 composer.dock/left/right 槽位即注入组件。
	const composerDockItems = useSlotComponents(rpc, COMPOSER_DOCK_SLOT);
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
	const { attachments, setAttachments, addFiles, onPaste, onDragOver, onDrop } = useAttachments(rpc);
	// SketchPad (Codex 绘画 parity): open from the attach menu, from clicking
	// a sketch chip (re-edit), or from an image lightbox's edit button
	// (musepi-gui-sketch-open, wired by ChatView). editId targets an existing
	// chip — finishing replaces it in place instead of adding a new one.
	const [sketch, setSketch] = useState<{
		open: boolean;
		editId: number | null;
		initial: string | null;
		scene: SketchScene | null;
	}>({
		open: false,
		editId: null,
		initial: null,
		scene: null,
	});
	useEffect(() => {
		const onOpen = (e: Event): void => {
			const detail = (e as CustomEvent<{ dataUrl?: string }>).detail;
			const dataUrl = detail?.dataUrl;
			if (typeof dataUrl !== "string" || dataUrl.length === 0) return;
			// A lightbox image carries no scene: the board mounts the picture
			// itself, and finishing mints a chip (with a scene of its own).
			setSketch({ open: true, editId: null, initial: dataUrl, scene: null });
		};
		window.addEventListener("musepi-gui-sketch-open", onOpen);
		return () => window.removeEventListener("musepi-gui-sketch-open", onOpen);
	}, []);
	const closeSketch = useCallback((): void => {
		setSketch(prev => ({ open: false, editId: null, initial: null, scene: null }));
	}, []);

	// kimicode 截屏 parity ("+" 菜单 / ⇧⌘S): grab the primary display through
	// the main process, then open the annotate board ON the shot — the flow
	// is capture → markup → chip, so a bare "paste my screen" never lands.
	// Both the menu item and the shortcut registry dispatch the same event.
	const openCapture = useCallback((): void => {
		const api = (
			window as unknown as { electronAPI?: { captureScreen?: () => Promise<{ dataUrl?: string; error?: string }> } }
		).electronAPI;
		if (!api?.captureScreen) return;
		void api.captureScreen().then(res => {
			if (res.dataUrl) setSketch({ open: true, editId: null, initial: res.dataUrl, scene: null });
		});
	}, []);
	useEffect(() => {
		const onCapture = (): void => openCapture();
		window.addEventListener("musepi-gui-capture-screen", onCapture);
		return () => window.removeEventListener("musepi-gui-capture-screen", onCapture);
	}, [openCapture]);
	const onSketchDone = useCallback(
		(dataUrl: string, scene: SketchScene): void => {
			const editId = sketch.editId;
			closeSketch();
			if (editId !== null) {
				// Re-edit: swap the chip's pixels in place (position, size and
				// the rest of the draft survive). `sketch` must survive the
				// spread too, or the chip stops reopening the board after the
				// first re-edit — this branch is reached precisely because the
				// chip carries the flag. `sketchScene` is replaced with the
				// board's current strokes, so the NEXT click still reopens the
				// objects rather than a raster of everything drawn so far.
				setAttachments(prev =>
					prev.map(a =>
						a.id === editId
							? {
									...a,
									dataUrl,
									mimeType: dataUrl.slice(5, dataUrl.indexOf(";")) || a.mimeType,
									size: Math.round((dataUrl.length - dataUrl.indexOf(",")) * 0.75),
									sketch: true,
									sketchScene: scene,
								}
							: a,
					),
				);
				return;
			}
			// Board-drawn chips are identified by NAME (see nextSketchFileName):
			// the name has to be unique per finish, and `sketch-` alone is not.
			const fileName = nextSketchFileName();
			void (async () => {
				await addFiles([dataUrlToFile(dataUrl, fileName)]);
				// Mark the fresh chip so clicking it reopens the board, and
				// hang the scene on it — that is what turns the click into
				// "keep editing A0" instead of "paste A1 as a picture".
				// This must run AFTER addFiles settles: addFiles awaits the
				// daemon settings read before appending, and marking first
				// meant mapping the pre-add (empty) array — the flag was
				// dropped and the chip fell back to the plain image preview
				// ("clicking it just previews the picture").
				setAttachments(prev => markSketchChip(prev, fileName, scene));
			})();
		},
		[sketch.editId, closeSketch, setAttachments, addFiles],
	);
	const { pending: pendingPaste, requestPaste: requestLongPaste, dismiss: dismissLongPaste } = useLongTextPaste();

	// Trailing "+" card in the attachment row (composer-frame): opens the
	// all-types picker directly, skipping the attach menu.
	const anyPickRef = useRef<HTMLInputElement | null>(null);

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
		slashCmds,
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
	useDraftPersistence({ sessionId, rpc, text, setText, attachments, setAttachments });
	const { history, historyIndex, draftBackupRef, setHistoryIndex, pushHistory } = useInputHistory(cwd);
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
	// ── Design-session style chips (设计稿 08) ────────────────────────────
	// session.modes.modeId === "design" gates the row; picking a style lands
	// the brief-update sentence in the composer (edit & send, per the design
	// brief protocol — the agent keeps the brief in-session).
	const isDesignSession = modes?.modeId === "design";
	const [designStyle, setDesignStyle] = useState<string | null>(null);
	const pickDesignStyle = useCallback(
		(id: string | null): void => {
			setDesignStyle(id);
			if (!id) return;
			const style = DESIGN_STYLES.find(s => s.id === id);
			if (!style) return;
			const sentence = t("design style brief update {style}", { style: t(style.labelKey) });
			setText(prev => (prev && prev.trim().length > 0 ? `${prev.trimEnd()}\n${sentence}` : sentence));
			requestAnimationFrame(() => autosize(taRef.current));
			taRef.current?.focus();
		},
		[setText],
	);

	// ── Context-window usage (usage ring) ─────────────────────────────────
	const [contextUsage, setContextUsage] = useState<{
		tokens: number;
		contextWindow: number;
		percent: number;
		model?: string | null;
		snapcompact?: SnapcompactSavingsView | null;
		breakdown?: ContextBreakdownView | null;
		usage?: UsageSummaryView | null;
		thresholdTokens?: number | null;
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
				usage?: UsageSummaryView | null;
				autoCompactBufferTokens?: number;
				freeTokens?: number;
				thresholdTokens?: number | null;
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
				setContextUsage(prev => {
					if (!usage || !prev) return usage;
					// The cost / cache-hit block moves independently of the
					// token counts, so it is part of the identity too —
					// otherwise the spend line freezes until the next
					// context-window change.
					const usageSame =
						prev.usage?.cost === usage.usage?.cost &&
						prev.usage?.cacheRead === usage.usage?.cacheRead &&
						prev.usage?.cacheHitRate === usage.usage?.cacheHitRate;
					return prev.tokens === usage.tokens &&
						prev.percent === usage.percent &&
						prev.contextWindow === usage.contextWindow &&
						prev.model === usage.model &&
						prev.thresholdTokens === usage.thresholdTokens &&
						usageSame &&
						prev.snapcompact?.savedTokens === usage.snapcompact?.savedTokens
						? prev
						: usage;
				});
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
			usage?: UsageSummaryView | null;
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
				usage?: UsageSummaryView | null;
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
			if (e.key !== "Escape") return;
			// Claim the key (lib/escape-stop): an open popover owns Escape,
			// and unclaimed Escape interrupts the running turn.
			e.preventDefault();
			setUsagePanel(s => ({ ...s, open: false }));
			setContextPanel(s => (s ? { ...s, open: false } : s));
			setGoalOpen(false);
			setPlanOpen(false);
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
	// Dictation submit trigger (settings.stt.submitTrigger, TUI parity):
	// whether finishing a dictation auto-sends the transcript instead of
	// leaving it in the draft box.
	const [sttSubmitTrigger, setSttSubmitTrigger] = useState<SttSubmitTrigger>("never");
	useEffect(() => {
		if (!rpc) return;
		const load = (): void => {
			void rpc
				.request<Record<string, unknown> | null>("settings.get", { keys: ["stt.submitTrigger"] })
				.then(v => {
					const t = v?.["stt.submitTrigger"];
					if (typeof t === "string" && t !== "never") setSttSubmitTrigger(t as SttSubmitTrigger);
				})
				.catch(() => {});
		};
		load();
		window.addEventListener("omp-settings-changed", load);
		return () => window.removeEventListener("omp-settings-changed", load);
	}, [rpc]);
	// Voice dictation (extracted: composer/use-dictation): one phase state owns
	// recording → transcribing → insert/error. The transcription wait now keeps
	// its feedback (strip + spinner) until the text actually lands, mic press
	// during transcription cancels, and unmount drops the in-flight session.
	const dictation = useDictation({
		rpc,
		sttSubmitTrigger,
		onSubmit: onSend,
		onInsert: transcript => {
			setText(prev => (prev ? `${prev} ${transcript}` : transcript));
			requestAnimationFrame(() => autosize(taRef.current));
		},
	});
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
	// 取回: pop a queued message back into the editor (TUI Alt+Up parity)
	// so the user can edit before re-sending. With group+text it pops THAT
	// item (queue panel per-item 撤回/编辑); without, the newest one.
	const popQueued = useCallback(
		(group?: "steering" | "followUp", text?: string): Promise<void> => {
			if (!rpc || !sessionId) return Promise.resolve();
			return rpc
				.request<{ text: string; images?: { type: string; data: string; mimeType: string }[] } | null>(
					"session.queuedPop",
					{ sessionId, group, text },
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
					// 取回 must bring the ATTACHMENTS back too, not just the
					// text: the daemon returns the queued images with the
					// popped message and dropping them forced the user to
					// re-attach before every re-send.
					const restored = attachmentsFromWireImages(res?.images);
					if (restored.length > 0) setAttachments(prev => [...prev, ...restored]);
					// Optimistic removal — the next poll confirms.
					if (group && text) {
						setQueued(prev =>
							prev
								? {
										...prev,
										count: Math.max(0, prev.count - 1),
										[group]: prev[group].filter(m => m !== text),
									}
								: prev,
						);
					} else {
						setQueued(prev => (prev && prev.count > 0 ? { ...prev, count: prev.count - 1 } : prev));
					}
				})
				.catch(() => {});
		},
		[rpc, sessionId],
	);
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
	// 队列行 ✎编辑:同一个 daemon 出口(queuedPop),只是把载荷送进输入框
	// 而不是丢弃 —— 用户落地即可改字、改附件,再发一次。附件同样要回来,
	// 否则"编辑"会变成"编辑并丢图"。
	const editQueued = useCallback(
		(group: "steering" | "followUp", text: string): void => {
			void popQueued(group, text);
		},
		[popQueued],
	);
	// 队列行 🗑删除:仍然走 queuedPop(队列表没有独立的 remove RPC),但把
	// 弹出的载荷直接丢掉 —— 文本不回输入框、附件不回芯片。乐观移除 + 下一
	// 次轮询确认。
	const deleteQueued = useCallback(
		(group: "steering" | "followUp", text: string): void => {
			if (!rpc || !sessionId) return;
			void rpc
				.request("session.queuedPop", { sessionId, group, text })
				.then(() => {
					setQueued(prev =>
						prev
							? {
									...prev,
									count: Math.max(0, prev.count - 1),
									[group]: prev[group].filter(m => m !== text),
								}
							: prev,
					);
				})
				.catch(() => {});
		},
		[rpc, sessionId],
	);
	// Immediate snapshot refresh — called right after a busy-time send so an
	// enqueued message shows in the chip/panel NOW instead of on the next
	// 3s poll tick.
	const refreshQueued = useCallback((): void => {
		if (!rpc || !sessionId) return;
		void rpc
			.request<{ count: number; steering: string[]; followUp: string[] }>("session.queued", { sessionId })
			.then(res => {
				setQueued(prev =>
					prev &&
					prev.count === res?.count &&
					prev.steering.length === res?.steering.length &&
					prev.followUp.length === res?.followUp.length
						? prev
						: (res ?? prev),
				);
			})
			.catch(() => {});
	}, [rpc, sessionId]);
	// 立即发出: pull one queued message out and inject it as an immediate
	// steer (TUI 引导消息回车即发 parity). Drop the row from this group
	// locally, then re-read the authoritative snapshot — the daemon placed
	// the item at the head of the steer queue, so the panel shows where it
	// actually sits until the agent takes it at the next injection boundary.
	// Without the refresh the panel kept the optimistic guess until the 3s
	// poll and the click read as inert.
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
					refreshQueued();
				})
				.catch(() => {});
		},
		[rpc, sessionId, refreshQueued],
	);
	const reorderQueued = useCallback(
		(group: "steering" | "followUp", from: string, to: string): Promise<void> => {
			if (!rpc || !sessionId || from === to) return Promise.resolve();
			// Optimistic local reorder so the row follows the cursor; the
			// daemon is authoritative and the next poll confirms.
			setQueued(prev =>
				prev
					? {
							...prev,
							[group]: (() => {
								const next = [...prev[group]];
								const fi = next.indexOf(from);
								const ti = next.indexOf(to);
								if (fi === -1 || ti === -1) return next;
								const [moved] = next.splice(fi, 1);
								next.splice(ti, 0, moved);
								return next;
							})(),
						}
					: prev,
			);
			return rpc
				.request("session.queuedReorder", { sessionId, group, from, to })
				.then(() => refreshQueued())
				.catch(() => refreshQueued());
		},
		[rpc, sessionId, refreshQueued],
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
	const [slashNotice, setSlashNotice] = useState<{ level: "info" | "error"; text: string; markdown?: boolean } | null>(
		null,
	);
	const slashNoticeTimerRef = useRef<Timer | null>(null);
	const showSlashNotice = useCallback((level: "info" | "error", text: string, markdown = false): void => {
		setSlashNotice({ level, text, markdown });
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
						if (line) showSlashNotice("info", line, true);
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

	// Guided goal (TUI /guided-goal parity): one path for the typed
	// "/guided-goal [objective]" command AND the + menu entry. Assembles the
	// rough objective exactly like a normal send (quotes → "> " prefix, file
	// chips → uploaded workspace refs, images → wire parts) so nothing staged
	// in the composer is lost, then fires the guided RPC. The draft survives
	// a failed start — clearing happens only after the daemon accepts, and
	// the daemon's pre-check rejections (plan/vibe/goal states) surface with
	// their wording in the slash notice.
	const startGuidedGoal = useCallback(
		(objective: string): void => {
			if (!rpc || !sessionId) return;
			const imageParts = attachments
				.filter(a => a.kind !== "file")
				.map(a => ({
					type: "image" as const,
					data: a.dataUrl.split(",")[1] ?? "",
					mimeType: a.mimeType,
				}));
			const fileChips = attachments.filter(a => a.kind === "file");
			const quotePrefix =
				quotes.length > 0 ? `${quotes.map(q => `> ${q.split("\n").join("\n> ")}`).join("\n\n")}\n\n` : "";
			const baseObjective = `${quotePrefix}${objective}`.trim();
			void (async () => {
				let refs: string[] = [];
				if (fileChips.length > 0) {
					setAttachments(prev => prev.map(a => (a.kind === "file" ? { ...a, uploading: true } : a)));
					try {
						refs = await uploadAttachmentFiles(rpc, cwd, fileChips);
					} catch (err) {
						setAttachments(prev => prev.map(a => (a.kind === "file" ? { ...a, uploading: false } : a)));
						showSlashNotice(
							"error",
							`${t("attachment upload failed")}${err instanceof Error && err.message ? `: ${err.message}` : ""}`,
						);
						return;
					}
				}
				const fullObjective = refs.length > 0 ? `${refs.join("\n")}\n\n${baseObjective}`.trim() : baseObjective;
				try {
					await rpc.request("session.goal", {
						sessionId,
						op: "guided",
						objective: fullObjective || null,
						...(imageParts.length > 0 ? { images: imageParts } : {}),
					});
				} catch (err) {
					showSlashNotice(
						"error",
						`${t("guided goal failed")}${err instanceof Error && err.message ? `: ${err.message}` : ""}`,
					);
					return;
				}
				handledQuoteCountRef.current = 0;
				onQuotesChange([]);
				setText("");
				setAttachments([]);
				requestAnimationFrame(() => autosize(taRef.current));
				sfxFor("send");
				tapFeedback();
			})();
		},
		[rpc, sessionId, attachments, quotes, cwd, onQuotesChange, setText, showSlashNotice],
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
			// GUI-native /btw: side question in a floating card (TUI parity —
			// the TUI command is TUI-only, so intercept like /usage).
			const btwMatch = /^\/btw(?:\s+(.+))?$/s.exec(trimmed);
			if (btwMatch) {
				const question = (btwMatch[1] ?? "").trim();
				if (!question) {
					showSlashNotice("error", "Usage: /btw <question>");
					return;
				}
				onBtw?.(question);
				setText("");
				sfxFor("send");
				return;
			}
			// GUI-native /guided-goal (TUI parity): the typed command starts
			// the guided interview with the inline args as the rough
			// objective. Intercepted BEFORE the slash dispatch (which reports
			// it tui-only) and before the no-attachments guard, so staged
			// quotes/images/file chips ride along exactly like a send.
			const ggMatch = /^\/guided-goal(?:\s+([\s\S]+))?$/.exec(trimmed);
			if (ggMatch) {
				startGuidedGoal((ggMatch[1] ?? "").trim());
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
			const finalMsg = quotePrefix ? `${quotePrefix}${payload}`.trim() : payload;
			// TUI "." / "c" continue-shortcut parity: a bare dot or c (no
			// quote/attachment) is the "continue working" signal — delivered
			// as a hidden synthetic directive, not a visible user message.
			const isContinueShortcut =
				(finalMsg === "." || finalMsg === "c") && quotes.length === 0 && attachments.length === 0;
			// Record the submitted prompt in the recall ring (TUI history
			// parity): the exact message that lands on the wire, so ArrowUp
			// recovers it verbatim. Consecutive repeats are deduped.
			const imageParts = attachments
				.filter(a => a.kind !== "file")
				.map(a => ({
					type: "image" as const,
					data: a.dataUrl.split(",")[1] ?? "",
					mimeType: a.mimeType,
				}));
			const fileChips = attachments.filter(a => a.kind === "file");
			// Shared send tail: everything after the wire send (quote cards
			// clear, queue chip refresh, composer reset) — both the plain
			// path and the file-upload path run this once.
			const finishSend = (): void => {
				if (quotes.length > 0) {
					handledQuoteCountRef.current = 0;
					onQuotesChange([]);
				}
				// Busy-time send just enqueued (steer/followUp) — surface it in the
				// queue chip/panel immediately instead of waiting for the next
				// poll tick; the delayed re-check settles daemon-side async.
				if (working || delivery) {
					refreshQueued();
					setTimeout(refreshQueued, 400);
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
			};
			if (fileChips.length > 0) {
				// File attachments (fs.write channel): write every non-image chip
				// into the session workspace (base64) BEFORE the message goes
				// out, then reference the workspace paths in the prompt so the
				// agent can open them with its file tools. Any failure aborts
				// the send (chips stay, a notice explains) — a message whose
				// attachments never landed would just confuse the agent.
				// (Same helper the empty-state composer uses post-create.)
				void (async () => {
					setAttachments(prev => prev.map(a => (a.kind === "file" ? { ...a, uploading: true } : a)));
					let refs: string[];
					try {
						refs = await uploadAttachmentFiles(rpc, cwd, fileChips);
					} catch (err) {
						setAttachments(prev => prev.map(a => (a.kind === "file" ? { ...a, uploading: false } : a)));
						showSlashNotice(
							"error",
							`${t("attachment upload failed")}${err instanceof Error && err.message ? `: ${err.message}` : ""}`,
						);
						return;
					}
					const wireText = refs.length > 0 ? `${refs.join("\n")}\n\n${finalMsg}`.trim() : finalMsg;
					pushHistory(wireText);
					onSend(wireText, imageParts, delivery);
					finishSend();
				})();
				return;
			}
			pushHistory(finalMsg);
			onSend(
				finalMsg,
				imageParts,
				// Working → steer (TUI Enter parity: processed immediately);
				// "/queue"/"=>" → followUp (after the current turn yields);
				// "." / "c" → continue (hidden synthetic resume, TUI parity).
				isContinueShortcut ? "continue" : delivery,
			);
			finishSend();
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
			openArPanel,
			openDebugPanel,
			openContextPanel,
			onBtw,
			showSlashNotice,
			refreshQueued,
			pushHistory,
			startGuidedGoal,
		],
	);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		// Self-healing composition latch (see the textarea's onBlur/onFocus):
		// Chromium tags every key INSIDE a live composition with keyCode 229,
		// so a keydown that is neither 229 nor marked composing means the latch
		// went stale — an aborted composition (window switch, IME cancel, Esc)
		// never fires compositionend and used to leave it true forever, which
		// returned early below for the rest of the app's lifetime: Enter sent
		// nothing while the mouse-only Send button kept working. Enter stays
		// exempt because WebKit dispatches the confirming Enter keyCode 13
		// AFTER compositionend, where the latch must still hold.
		if (composingRef.current && !e.nativeEvent.isComposing && e.keyCode !== 229 && e.key !== "Enter") {
			composingRef.current = false;
		}
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
		// Input-history navigation (TUI editor parity): with the completion
		// menus closed, ArrowUp recalls older submissions when the caret is at
		// the start (or the box is empty); ArrowDown walks back toward the
		// present, restoring the in-progress draft at the end. The menus above
		// return early, so Arrow keys there never reach the history ring.
		if (e.key === "ArrowUp") {
			const ta = taRef.current;
			const atStart = !ta || (ta.selectionStart === 0 && ta.selectionEnd === 0) || text.length === 0;
			if (historyIndex === null) {
				if (atStart && history.length > 0) {
					if (text !== "") draftBackupRef.current = text;
					setHistoryIndex(0);
					setText(history[0] ?? "");
					e.preventDefault();
					requestAnimationFrame(() => autosize(taRef.current));
					return;
				}
			} else if (historyIndex < history.length - 1) {
				setHistoryIndex(historyIndex + 1);
				setText(history[historyIndex + 1] ?? "");
				e.preventDefault();
				requestAnimationFrame(() => autosize(taRef.current));
				return;
			}
		} else if (e.key === "ArrowDown" && historyIndex !== null) {
			if (historyIndex === 0) {
				setHistoryIndex(null);
				setText(draftBackupRef.current);
				e.preventDefault();
				requestAnimationFrame(() => autosize(taRef.current));
				return;
			}
			setHistoryIndex(historyIndex - 1);
			setText(history[historyIndex - 1] ?? "");
			e.preventDefault();
			requestAnimationFrame(() => autosize(taRef.current));
			return;
		}
		// Cmd/Ctrl+Enter (dsh parity): send with the OPPOSITE busy behavior
		// of the configured plain-Enter mode.
		if (e.key === "Enter" && eventMatches(e, "send") && !e.shiftKey && !e.altKey && !composingRef.current) {
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

	// Value-driven autosize fallback (long-paste choose, undo dock, /retry
	// edit, element-picker insert, queue pop…): programmatic setText calls
	// bypass the textarea onChange, so the box must re-measure after every
	// draft commit — not just keystrokes. Typing paths already autosize in
	// onChange; the duplicate call is a no-op at identical heights.
	useEffect(() => {
		const raf = requestAnimationFrame(() => autosize(taRef.current));
		return () => cancelAnimationFrame(raf);
	}, [text]);

	// User-message edit: replace composer text (TUI /retry-edit parity),
	// exactly once per incoming edit.
	//
	// The guard resets when the request clears (the parent nulls `pendingEdit`
	// on consume), so a SECOND edit of the SAME message still lands. Comparing
	// only by value made that a permanent no-op: the text was identical, so
	// `handledEditRef` kept matching and every later 编辑 on that message
	// silently did nothing — the draft stayed wherever it was.
	const handledEditRef = useRef<string | null>(null);
	useEffect(() => {
		if (pendingEdit == null) {
			handledEditRef.current = null;
			return;
		}
		if (handledEditRef.current === pendingEdit) return;
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
			{/* Agent status is carried by the send button itself (三合一). The separate
			 * status line is gone; only the compaction spinner remains while compacting. */}
			{compacting && <CompactionStatusLine onCancel={cancelCompaction} />}
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
					pet.enabled && pet.mode === "input"
						? ({ hovered, reaction }) => (
								// Poking the pet is a local, momentary override of the
								// agent-derived mood: it never touches the session state,
								// and it always falls back to the real mood on release.
								//
								// `size` is only the fallback box — the docked footprint
								// comes from `.gui-composer-pet`'s container clamp, so the
								// face never falls below legibility and the pet never
								// outgrows the input's edge. See PetSprite: the call site
								// must NOT size the builtin SVG, because an inline style
								// outranks that clamp.
								//
								// Reactions: every poke plays a random pick from the FULL
								// interaction set, never the same one twice in a row (see
								// ComposerPetState.reaction). Hover stays a mood because
								// it is ambient, not a reaction.
								<PetSprite
									mood={hovered ? "hover" : (petMood ?? "rest")}
									// The state is dropped while hovered: hover is a
									// pointer state, and showing a session's thinking
									// lights under a hover lift reads as two things
									// happening at once.
									state={hovered ? null : (petState ?? null)}
									// The docked pet is clamped to 34–46px
									// (.gui-composer-pet) — the bottom of the "full"
									// tier, where every effect still resolves (the
									// smallest ribbon is ~2.4px tall there).
									tier="full"
									pet={pet.pet}
									size={30}
									gloss={pet.decor.gloss}
									accessory={pet.decor.accessory}
									interaction={reaction}
								/>
							)
						: null
				}
				// Agent-working glow (user: welcome shows the beam on focus,
				// the session composer shows it while the agent works).
				hero
				heroActive={working}
				enhancing={enhance === "enhancing"}
				attachments={attachments}
				onRemoveAttachment={id => setAttachments(prev => prev.filter(p => p.id !== id))}
				onEditSketch={id => {
					const chip = attachments.find(x => x.id === id);
					if (!chip) return;
					// A chip with a scene reopens its STROKES (A0) — every
					// object stays editable. Only a scene-less chip (restored
					// draft, old data) falls back to mounting its PNG.
					setSketch({
						open: true,
						editId: id,
						initial: chip.sketchScene ? null : chip.dataUrl,
						scene: chip.sketchScene ?? null,
					});
				}}
				onEditImage={src => setSketch({ open: true, editId: null, initial: src, scene: null })}
				onAddAttachment={() => anyPickRef.current?.click()}
				// Todo/queue chips + extension dock hang ABOVE the input card
				// (user direction: the status row belongs above the input,
				// not inside the framed box).
				aboveRow={
					<div className="gui-composer-above">
						{composerDockItems.length > 0 ||
						(modes && (todoTotal > 0 || (working && queued != null && queued.count > 0))) ||
						activeTask ? (
							<div className="gui-composer-dock">
								{composerDockItems.length > 0 && (
									<SlotComponentHost rpc={rpc} slot={COMPOSER_DOCK_SLOT} sessionId={sessionId} cwd={cwd} />
								)}
								{((modes && (todoTotal > 0 || (working && queued != null && queued.count > 0))) ||
									activeTask) && (
									<div className="gui-mode-row gui-mode-row--status">
										{activeTask && (
											<SwarmChip
												open={swarmOpen}
												onToggle={() => setSwarmOpen(v => !v)}
												anchorRef={swarmAnchorRef}
												menu={renderSwarmMenu(
													<div
														className="gui-swarm-popup-card"
														role="region"
														aria-label={t("swarm members")}
													>
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
														onEdit={editQueued}
														onDelete={deleteQueued}
														onClear={clearQueued}
														onReorder={reorderQueued}
													/>,
												)}
											</>
										)}
									</div>
								)}
							</div>
						) : null}
					</div>
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
								// TUI /guided-goal parity: the agent interviews the
								// user in chat, then creates the goal. The current
								// draft — plus any staged quotes/attachments — rides
								// along as the rough objective via the shared
								// startGuidedGoal path (the typed /guided-goal
								// command lands there too); a failed start keeps
								// the draft and surfaces the daemon's wording.
								startGuidedGoal(text.trim());
							}}
							onPickImages={files => void addFiles(files)}
							onPickFiles={files => void addFiles(files)}
							onSketch={() => setSketch({ open: true, editId: null, initial: null, scene: null })}
							onCaptureScreen={openCapture}
							onInsert={token => {
								const ta = taRef.current;
								if (!ta) return;
								ta.focus();
								const start = ta.selectionStart ?? text.length;
								const end = ta.selectionEnd ?? text.length;
								ta.setRangeText(token, start, end, "end");
								const next = ta.value;
								setText(next);
								autosize(ta);
								// The completion panels are driven off textarea onChange,
								// which a programmatic setRangeText never fires — so
								// "+ → insert command" landed a bare "/" with no menu.
								// Re-run the same parsers the change handler uses.
								onSlashInput(next);
								onAtInput(next);
								onHashInput(next);
							}}
						/>
						{/* 会话扩展状态卡(DSH Cordis Plugin 卡片参考吸收):运行中扩展数 +
						 * 浮窗状态列表。 */}
						{!welcome && <ExtensionStatusCard rpc={rpc} />}
						{/* (The interactive 队列 toggle chip lives in the status dock
						 * above — the old informational toolbar chip was a duplicate
						 * badge and is gone.) */}
						{/* Focus mode sits between the attach menu and the model
						 * selector (openchamber ComposerFooter order). */}
						{onToggleFocus && <FocusButton focused={focused ?? false} onPress={onToggleFocus} />}
						<ModelThinkingCapsule
							rpc={rpc}
							sessionId={sessionId}
							presetModelId={presetModelId}
							currentModelId={contextUsage?.model ?? null}
							thinkingLevel={thinkingLevel}
							thinkingConfigLevel={thinkingConfigLevel}
							thinkingCeiling={thinkingCeiling}
							thinkingEfforts={thinkingEfforts}
							allowSetDefault
							onAddProvider={onAddProvider}
							onModelSelect={id => {
								if (id) onModelChange?.(id);
								// The daemon finished the switch before this
								// fires — refresh the ring/card immediately so
								// they show the new model's window without
								// waiting for the next 3s poll.
								refreshUsage();
							}}
							onSetThinking={onSetThinking}
						/>
						{/* Design-style select (设计稿 08 composer 风格选择, WorkBuddy
						 * footer-pill parity): pick a style baseline → the
						 * brief-update text lands in the composer to edit & send. */}
						{isDesignSession && <DesignStyleSelect selected={designStyle} onPick={pickDesignStyle} />}
						{/* Session mode toggles (TUI /fast /computer /vision /prewalk
						 * parity): a compact popover in the action row, session-only
						 * (hidden in the welcome scene). */}
						{!welcome && sessionId ? <SessionModeToggles rpc={rpc} sessionId={sessionId} /> : null}
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
						{/* Approval mode (openchamber input permission-picker parity):
						 * the daemon re-reads tools.approvalMode on every tool call. */}
						<ApprovalModeButton rpc={rpc} />
						{contextUsage != null && (
							<ContextRing
								percent={contextUsage.percent}
								tokens={contextUsage.tokens}
								contextWindow={contextUsage.contextWindow}
								thresholdTokens={contextUsage.thresholdTokens ?? null}
								onCompact={compactContext}
								compacting={compacting}
								compactFailed={compactFailed}
								snapcompact={contextUsage.snapcompact ?? null}
								usage={contextUsage.usage ?? null}
								fetchQuota={fetchUsageQuota}
							/>
						)}
						{/* Compact motion-only mic control; the live waveform, clock
						 * and phase copy live in the in-input VoiceStatusStrip. */}
						<VoiceButton state={dictation.phase} onToggle={dictation.toggle} />
						{/* 三合一 send control (user direction, opendesign parity):
						 * idle → send; working → the button itself displays the
						 * live agent state (braille + accent shimmer), hover
						 * reveals the stop glyph and click aborts the turn. */}
						{!working && <RetryButton busy={retryBusy} none={retryNone} onPress={retryLastTurn} />}
						<SendOrStopButton
							canSend={canSend}
							busy={enhance === "enhancing"}
							working={working}
							onPress={() => send()}
							onStop={() => {
								tapFeedback(2);
								onStop();
							}}
						/>
					</>
				}
			>
				{dictation.phase !== "idle" && (
					<VoiceStatusStrip phase={dictation.phase} seconds={dictation.seconds} level={dictation.level} />
				)}
				{dictation.error && (
					<div className="gui-voice-error" role="status" aria-live="polite">
						<span className="gui-voice-error-dot" aria-hidden />
						<span className="min-w-0 flex-1">{dictation.error}</span>
						<span className="gui-voice-error-hint">{t("voice esc to cancel")}</span>
					</div>
				)}
				{slashNotice && (
					<SlashNotice level={slashNotice.level} text={slashNotice.text} markdown={slashNotice.markdown} />
				)}
				<SlashCommandTip text={text} commands={slashCmds} />
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
				{pendingPaste && (
					<LongPasteDialog
						lineCount={pendingPaste.lineCount}
						charCount={pendingPaste.charCount}
						onAction={(action: LongPasteAction) => {
							const ta = taRef.current;
							if (!ta) {
								dismissLongPaste();
								return;
							}
							const start = ta.selectionStart ?? ta.value.length;
							const end = ta.selectionEnd ?? ta.value.length;
							if (action === "file") {
								// Unified attachment flow (composer file chips): the
								// paste becomes a markdown FILE CHIP in the attachment
								// row — send-time uploads it into <cwd>/attachments/
								// and references it, same as any picked file. A no-cwd
								// session fails visibly at send (inline notice) instead
								// of the old silent inline fallback.
								const file = new File([pendingPaste.text], `paste-${Date.now()}.md`, {
									type: "text/markdown",
								});
								void addFiles([file]);
								dismissLongPaste();
								return;
							}
							const insertion =
								action === "code-block"
									? `\`\`\`\n${pendingPaste.text}\n\`\`\``
									: action === "attachment"
										? `<attachment>\n${pendingPaste.text}\n</attachment>`
										: pendingPaste.text;
							const newText = ta.value.slice(0, start) + insertion + ta.value.slice(end);
							setText(newText);
							requestAnimationFrame(() =>
								ta.setSelectionRange(start + insertion.length, start + insertion.length),
							);
							dismissLongPaste();
						}}
						onDismiss={dismissLongPaste}
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
				{/* Attachment-row "+" card target: all-types picker (openchamber
				 *  parity — no accept restriction; files ride via fs.write). */}
				<input
					ref={anyPickRef}
					type="file"
					multiple
					hidden
					onChange={e => {
						const files = e.target.files ? [...e.target.files] : [];
						if (files.length > 0) void addFiles(files);
						e.target.value = "";
					}}
				/>
				<div className="gui-ta-stack">
					<ComposerHighlight text={text} className="gui-ta-highlight--session" />
					<textarea
						ref={el => {
							taRef.current = el;
							menuAnchorRef(el);
						}}
						value={text}
						rows={MIN_ROWS}
						onScroll={e => {
							// Mirror the textarea's scroll onto the highlight overlay
							// (previousElementSibling inside the shared stack) so the
							// painted tokens track the caret when the draft overflows.
							const overlay = e.currentTarget.previousElementSibling as HTMLElement | null;
							if (overlay) overlay.scrollTop = e.currentTarget.scrollTop;
						}}
						onPaste={e => {
							onPaste(e);
							if (e.defaultPrevented) return;
							const pastedText = e.clipboardData.getData("text");
							if (isLongPastedText(pastedText)) {
								e.preventDefault();
								requestLongPaste(pastedText);
							}
						}}
						onDragOver={onDragOver}
						onDrop={onDrop}
						onChange={e => {
							setText(e.target.value);
							// A genuine keystroke that edits the box exits input-history
							// browsing (programmatic history recall sets state, never
							// fires onChange — so browse stays until the user edits).
							if (historyIndex !== null) setHistoryIndex(null);
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
						onCompositionUpdate={() => {
							composingRef.current = true;
						}}
						onCompositionEnd={() => {
							// Deferred a tick: WebKit dispatches the confirming Enter
							// after compositionend, when isComposing is already false.
							setTimeout(() => {
								composingRef.current = false;
							}, 0);
						}}
						onBlur={() => {
							// A composition can end WITHOUT compositionend — an IME
							// cancel, a window switch, Esc, a renderer reload. Losing
							// focus always terminates it, so this is the safe reset
							// for the latch that would otherwise stay true forever
							// (Enter silently stops sending until restart).
							composingRef.current = false;
						}}
						onFocus={() => {
							// Nothing can still be composing when focus arrives.
							composingRef.current = false;
						}}
						onKeyDown={onKeyDown}
						placeholder={
							working
								? t("agent working — send steers the agent now, /queue waits for the turn to end…")
								: isDesignSession
									? t("design empty placeholder")
									: t("ask anything, / for commands, @ for context…")
						}
						spellCheck={spellcheckEnabled()}
						autoComplete="off"
					/>
				</div>
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
			{sketch.open && (
				<SketchPad
					initialImage={sketch.initial}
					initialScene={sketch.scene}
					onClose={closeSketch}
					onDone={onSketchDone}
				/>
			)}
		</div>
	);
}
