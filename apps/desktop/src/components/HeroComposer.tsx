import { BlurText, type ComposerEditorHandle, composerPlaceholder, t } from "@musepi/client-core";
import { ANNOTATION_ATTACH_EVENT, type AnnotationAttachDetail } from "@musepi/client-core/src/annotation";
import {
	composeDisplayContextPrompt,
	createChatQuoteContext,
	type DisplayContext,
	type MessageDisplayContext,
	messageDisplayContext,
} from "@musepi/client-core/src/messages/display-context";
import { Plus as PlusIcon, X as XIcon } from "lucide";
import { MorphIcon } from "morphicons/react";
import type { CSSProperties, FormEvent, ReactNode } from "react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComposerAttachRef } from "../lib/composer-attach";
import { ComposerFrame } from "../lib/composer-frame";
import { isContextCommand } from "../lib/context-command";
import { templateTabForChip } from "../lib/creation";
import { projectName } from "../lib/electron";
import { type ModeLabelEntry, resolveModeDescription, resolveModeLabel } from "../lib/mode-label";
import { projectLabels } from "../lib/project-label";
import type { RpcClient } from "../lib/rpc";
import { onSettingsChanged } from "../lib/settings-events";
import { sfxFor } from "../lib/sfx";
import { modLabel } from "../lib/shortcuts";
import type { SketchScene } from "../lib/sketch-scene";
import {
	COMPOSER_INPUT_DOCK_SLOT,
	HERO_AGENT_PRESET_SLOT,
	HERO_BRAND_MARK_SLOT,
	HERO_FRAME_SLOT,
	HERO_OPTIONS_SLOT,
	HERO_WORKSPACE_SLOT,
	SlotComponentHost,
} from "../lib/slot-host";
import {
	loadSuggestions,
	resolveSuggestion,
	type StoredSuggestion,
	SUGGESTIONS_CHANGED_EVENT,
	SUGGESTIONS_COLLAPSED_COUNT,
} from "../lib/suggestions";
import { clampThinkingChipLevel } from "../lib/thinking-chip";
import { isUsageCommand } from "../lib/usage-command";
import { useFloatingMenu } from "../lib/use-floating-menu";
import type { SttSubmitTrigger } from "../lib/voice";
import { WelcomeBackdrop } from "../lib/welcome-backdrop";
import {
	readWelcomeGreeting,
	resolveWelcomeGreeting,
	WELCOME_GREETING_CHANGED_EVENT,
	WELCOME_GREETING_STORAGE_KEY,
} from "../lib/welcome-greeting";
import { Icon } from "../vendor/oc-icons";
import { AttachMenu } from "./AttachMenu";
import { CompanionArt, useCompanionArt } from "./CompanionArt";
import {
	type CreationMessage,
	CreationModeRow,
	type CreationRailHandle,
	type CreationRailState,
} from "./CreationModeRow";
import { FocusButton, VoiceButton } from "./composer/action-buttons";
import { ApprovalModeButton } from "./composer/approval-mode-button";
import { attachmentChipActions } from "./composer/chip-actions";
import { CompletionMenus } from "./composer/completion-menus";
import { ConnectorChip, ConnectorPanel, nextSelection, useConnectors } from "./composer/connector-panel";
import { DesignStyleSelect } from "./composer/design-styles";
import { DesignSystemRail } from "./composer/design-system-rail";
import { ComposerEditorStack } from "./composer/editor-stack";
import { insertComposerToken } from "./composer/insert-token";
import { LongPasteDialog } from "./composer/long-paste-dialog";
import {
	deleteMentionTokenAfter,
	deleteMentionTokenBefore,
	expandMentionTokens,
	resolveMentionChip,
} from "./composer/mention-token";
import { QuoteCards } from "./composer/quote-cards";
import { StartFromPicker } from "./composer/start-from-picker";
import { type ComposerSendPayload, useComposerSurface } from "./composer/surface";
import { TemplateRail } from "./composer/template-rail";
import {
	attachmentFiles,
	attachmentImageParts,
	attachmentVideoSelection,
	type ComposerAttachment,
	dataUrlToFile,
	markSketchChip,
	nextSketchFileName,
	useAttachments,
} from "./composer/use-attachments";
import { useCompletion } from "./composer/use-completion";
import { useComposerIntake } from "./composer/use-composer-intake";
import { useComposerMarks } from "./composer/use-composer-marks";
import { useDesignSystems } from "./composer/use-design-systems";
import { useDictation } from "./composer/use-dictation";
import { attachPaste, isLongPastedText, saveEditedPaste, useLongTextPaste } from "./composer/use-long-text-paste";
import { VoiceOverlays } from "./composer/voice-overlays";
import { useVoiceSetupGate } from "./composer/voice-setup";
import { autosize } from "./composer-autosize";
import { HeightMorph } from "./HeightMorph";
import { ModelThinkingCapsule } from "./ModelThinkingCapsule";
import { ONBOARDING_PROVIDER_STEP } from "./OnboardingOverlay";
import { type ReminderRow, RemindersPanel } from "./RemindersPanel";
import { Reveal } from "./Reveal";
import { ScreenshotEditorDialog } from "./ScreenshotEditorDialog";
import {
	fmtQuotaDuration,
	type UsageActiveAccountView,
	type UsageDisabledCredentialView,
	UsageGapLines,
	UsageProviderSection,
	type UsageReloginDeadlineView,
	type UsageReportsData,
	type UsageReportView,
	type UsageUnreportedAccountView,
} from "./SessionComposer";
import { SketchPad } from "./SketchPad";
import type { ThinkingLevel } from "./ThinkingSelector";

/** Time-aware greeting: seven brackets — 清晨 / 早上 / 中午 /
 * 下午 / 晚上 / 深夜. Each bracket carries its own tone so the welcome
 * reads less canned. */
function greeting(hour: number): string {
	if (hour < 5) return t("settings.lateTakeCare");
	if (hour < 8) return t("settings.earlyMorning");
	if (hour < 12) return t("settings.goodMorning");
	if (hour < 14) return t("settings.goodNoon");
	if (hour < 18) return t("settings.goodAfternoon");
	if (hour < 22) return t("settings.goodEvening");
	return t("settings.lateTakeCare");
}

/** Static tip shown under the composer. Keys are translated at render time
 * (t is locale-aware), so a locale switch updates the tip line without a reload. */
// English keys double as the en-US fallback (the i18n map only carries
// zh-CN); zh translations live in guest-client/src/i18n/zh-CN.ts.
const TIP_KEYS = [
	"settings.tryCommandsContext",
	"settings.pressNStartNewWithMod",
	"settings.askAgentExplainFile",
	"settings.approvalCardsAppearTool",
	"settings.dictateMicButtonComposer",
	"settings.annotateImagesBeforeSending",
	"settings.scheduleIdleWindowTasks",
	"settings.typeAutoresearchRunExperiments",
	"settings.favoriteModelsPinTop",
	"settings.planModeMakesAgent",
	"settings.goalModeTurnsYour",
	"settings.pausedSessionsSurviveDaemon",
	"settings.pickPresetModeNew",
	"settings.customizeScrollbarSkinAppearance",
] as const;

/** Empty-state chips ARE the session composer's chips: resizing, dedupe and
 *  paste/drop intake live in `useAttachments`. The draft path only differs in
 *  when file bytes leave the renderer — no session exists yet, so the raw
 *  handles ride in memory until the host writes them into the session this
 *  first prompt creates (`stageFiles: false`). */
type WelcomeAttachment = ComposerAttachment;

/**
 * Empty-state composer: large centered input with a
 * border-beam accent, a faint brand watermark, a time-aware greeting, and a
 * static tip line.
 *
 * ONE composer, two states: the attachment surface here is the session
 * composer's, verbatim — same chips, same attach menu (images / sketch /
 * files), same click-to-extend board. The empty state used to ship a
 * reduced copy (images only, no file entry, chips that could not be
 * reopened), which read as an unfinished feature rather than a state.
 */
export function HeroComposer({
	onSubmit,
	busy,
	rpc,
	onAddProvider,
	project,
	onProject,
	focused,
	onToggleFocus,
	presetModelId,
	presetThinkingLevel,
	reminders,
	onSelectReminder,
	onMarkAllRead,
	/** 预设(mode)chip(项目行旁):欢迎页选择,新会话创建时应用。 */
	modes,
	agentPreset,
	onModeChange,
	designSubmit,
	placeholder,
	attachApiRef,
	initialDraft,
	onDraftChange,
	attachmentsApi,
}: {
	/** First prompt; the model/thinking choices made in the composer are
	 *  carried along so the new session starts with them. planMode/goalMode
	 *  ride along when the corresponding mode chip is armed — the mode is
	 *  applied to the session this first prompt creates (goal: the prompt
	 *  text becomes the objective). */
	onSubmit(
		text: string,
		opts?: {
			thinkingLevel?: ThinkingLevel | null;
			modelId?: string | null;
			images?: { type: "image"; data: string; mimeType: string }[];
			displayContext?: MessageDisplayContext;
			/** Non-image chips picked in the empty state. The welcome surface
			 *  has no session (and therefore no workspace) yet, so the host
			 *  resolves the project — or reports that one is needed — when the
			 *  session it creates is ready. Without this the file entry would
			 *  have to be hidden, which is exactly the empty/session asymmetry
			 *  we are removing. */
			files?: File[];
			/** Path-backed video chips: native `video` parts for the first send. */
			videos?: { type: "video"; mimeType: string; url?: string; data?: string }[];
			planMode?: boolean;
			goalMode?: boolean;
			/** Guided goal (TUI /guided-goal parity): the host creates the
			 *  session and fires `session.goal op:"guided"` instead of sending
			 *  the text as a first message; `text` is the rough objective. */
			guidedGoal?: boolean;
		},
	): Promise<void> | void;
	busy?: boolean;
	/** Daemon client for the session-less model catalog (preselect). */
	rpc: RpcClient;
	/** 添加新提供商 menu action — opens the settings providers page. */
	onAddProvider?(): void;
	/** Current project (workspace folder), if any. */
	project?: string | null;
	/** 添加项目 / 远程连接 / 不在项目中 project actions. */
	/** 添加项目 / 远程连接 / 不在项目中 project actions, or an already
	 *  saved workspace path (picked from the saved-workspaces list). */
	onProject?(action: "add" | "remote" | "none" | string): void;
	/** Focus mode (⌘⇧E): the composer fills the surface. */
	focused?: boolean;
	onToggleFocus?(): void;
	/** Daemon-settings default model (modelRoles.default; refreshed live via
	 *  the musepi-gui-default-model-changed event) — preselects the model
	 *  button over the localStorage fallback. Resting state only: an
	 *  explicit pick (modelTouched) overrides it for the next new session. */
	presetModelId?: string | null;
	/** Daemon-settings thinking default (modelRoles.default suffix, else
	 *  settings.defaultThinkingLevel incl. auto) — boot snapshot replacing
	 *  the old localStorage mirror (musepi-gui-default-thinking removed). */
	presetThinkingLevel?: ThinkingLevel | null | undefined;
	/** Welcome-scene reminders (kimi 实时提醒 parity): background-working +
	 *  completed-unread sessions rendered below the composer. */
	reminders?: readonly ReminderRow[];
	onSelectReminder?(sessionId: string): void;
	onMarkAllRead?(): void;
	/** 预设(mode)chip 选项(项目行旁)。 */
	modes?: ModeLabelEntry[] | null;
	agentPreset?: string | null;
	onModeChange?(id: string | null): void;
	/** M3.7a design 模式内联形态(v2 修订,§2.4):mode chip 选中「设计」时
	 *  类型 chip 排直接渲染在本 composer 上方一行,发送走
	 *  session.create + projectMetadata 管线;未传则不渲染模式页。 */
	designSubmit?(metadata: Record<string, unknown>, message?: CreationMessage): Promise<boolean>;
	/** placeholder 覆盖(模式页按选中的类型 chip 变化)。 */
	placeholder?: string;
	/** Chat drop-anchor handoff: the anchor stages OS files here. */
	attachApiRef?: ComposerAttachRef;
	/** Draft handed over by the entry (see `Composer`). */
	initialDraft?: string;
	onDraftChange?(text: string): void;
	/** Attachment intake owned by the entry (see `Composer`). A direct mount
	 *  without it keeps its own state, so the skin stays self-contained. */
	attachmentsApi?: ReturnType<typeof useAttachments>;
}): ReactNode {
	const pet = useCompanionArt();
	// Declared at the top so dictation (which paints the live transcript into
	// the editor) and the completion hook share one handle.
	const taRef = useRef<ComposerEditorHandle | null>(null);
	const [text, setText] = useState(initialDraft ?? "");
	// Report every change up to the entry so a mode flip keeps the draft.
	useEffect(() => {
		onDraftChange?.(text);
	}, [text, onDraftChange]);
	// Hour-of-day clock: re-renders only when the greeting bracket flips
	// (早上好→下午好…), so the TextMorph greeting rolls over at the
	// boundary instead of freezing at mount time.
	const [hour, setHour] = useState(() => new Date().getHours());
	useEffect(() => {
		const id = window.setInterval(() => {
			const h = new Date().getHours();
			setHour(prev => (prev === h ? prev : h));
		}, 60_000);
		return () => window.clearInterval(id);
	}, []);
	// GUI-native /usage (empty state): no session yet, but /usage is NOT
	// model-bound (TUI parity) — the data is every account across every
	// provider, so the panel fetches the same global view the session
	// composer shows (usage.reports is session-optional on the daemon).
	// /context IS session-bound, so it stays a "start a conversation" note.
	const [usagePanel, setUsagePanel] = useState<{
		open: boolean;
		loading: boolean;
		data: UsageReportsData | null;
	}>({ open: false, loading: false, data: null });
	const [contextNote, setContextNote] = useState(false);
	// Floating card above the composer (query results near the input, not
	// a modal dialog — same direction as the session Composer).
	// No className on the floating shell — card styles live on the inner
	// .gui-quota-panel div (a className here double-draws the rounded card).
	const quotaOpen = usagePanel.open || contextNote;
	const { anchorRef: quotaAnchorRef, renderMenu: renderQuotaMenu } = useFloatingMenu(
		quotaOpen,
		open => {
			if (open) return;
			setUsagePanel(s => ({ ...s, open: false }));
			setContextNote(false);
		},
		{
			align: "right",
		},
	);

	// Connector picker (M4 P1): the welcome surface has NO session yet
	// (startNewTask 把 store 清空,会话在首条消息发送时才创建),所以走
	// daemon 的 cwd 回退拿服务器清单 + 健康态;勾选没有会话头可写,以
	// cwd 为键暂存 pending,会话创建后由 useConnectors 写回(与状态面板
	// 的连接器 section 同一条数据面,两种实现并存)。
	const [connectorsOpen, setConnectorsOpen] = useState(false);
	const { anchorRef: connectorsAnchorRef, renderMenu: renderConnectorsMenu } = useFloatingMenu(
		connectorsOpen,
		setConnectorsOpen,
		{ className: "gui-connector-popup" },
	);
	const {
		snapshot: connectorSnapshot,
		loadFailed: connectorsLoadFailed,
		setSelection: setConnectorSelection,
	} = useConnectors(rpc, null, project ?? null);
	const connectorServers = connectorSnapshot?.servers ?? [];
	const connectorChosen = connectorSnapshot
		? connectorServers.filter(s => connectorSnapshot.selected === null || connectorSnapshot.selected.includes(s.name))
				.length
		: 0;
	// Centered dialog + veil (same as the session Composer — a floating
	// layer over the composer card read as nested rounded cards).
	useEffect(() => {
		if (!quotaOpen) return;
		const onKey = (e: globalThis.KeyboardEvent): void => {
			if (e.key === "Escape") {
				setUsagePanel(s => ({ ...s, open: false }));
				setContextNote(false);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [quotaOpen]);
	// Global selection append (Cmd/Ctrl+L): any
	// non-composer selection lands here through the shared window event,
	// exactly like the session Composer's handler.
	useEffect(() => {
		const onInsert = (e: Event): void => {
			const detail = (e as CustomEvent<{ text?: string }>).detail;
			const insertion = detail?.text;
			if (!insertion) return;
			setText(prev => (prev.length === 0 ? insertion : `${prev}\n${insertion}`));
			requestAnimationFrame(() => autosize(taRef.current));
			requestAnimationFrame(() => taRef.current?.focus());
		};
		window.addEventListener("musepi-gui-insert-text", onInsert);
		return () => window.removeEventListener("musepi-gui-insert-text", onInsert);
	}, []);
	// Quoted selections and annotations share the session composer's context chips.
	const [quotes, setQuotes] = useState<DisplayContext[]>([]);
	useEffect(() => {
		const onQuoteAppend = (e: Event): void => {
			const detail = (e as CustomEvent<{ text?: string; messageId?: string; displayContext?: DisplayContext }>)
				.detail;
			if (detail?.displayContext) {
				setQuotes(current => [...current, detail.displayContext!]);
				requestAnimationFrame(() => autosize(taRef.current));
				requestAnimationFrame(() => taRef.current?.focus());
				return;
			}
			if (!detail?.text) return;
			const context = createChatQuoteContext({ messageId: detail.messageId, quote: detail.text });
			setQuotes(current =>
				current.some(item => item.kind === "chat-quote" && item.quote === detail.text)
					? current
					: [...current, context],
			);
			requestAnimationFrame(() => autosize(taRef.current));
			requestAnimationFrame(() => taRef.current?.focus());
		};
		window.addEventListener("musepi-gui-quote-append", onQuoteAppend);
		return () => window.removeEventListener("musepi-gui-quote-append", onQuoteAppend);
	}, []);
	const { requestPaste } = useLongTextPaste(text => {
		attachPaste({ text, addFiles, setAttachments });
	});
	const [editingPaste, setEditingPaste] = useState<{ id: number; text: string } | null>(null);
	const onEditPaste = (id: number): void => {
		const a = attachments.find(x => x.id === id);
		if (a?.editText !== undefined) setEditingPaste({ id, text: a.editText });
	};
	// The entry owns the intake in the app; a direct mount (tests, alternate
	// hosts) keeps its own so this component never requires the entry.
	const surface = useComposerSurface();
	// One send contract (ADR 0004): the entry dispatches to whichever variant's
	// handler is live; a direct mount keeps calling onSubmit itself.
	const send = (value: string, payload: ComposerSendPayload = {}) =>
		surface?.send ? surface.send(value, payload) : onSubmit(value, payload as never);
	const localIntake = useAttachments(rpc, { stageFiles: false });
	const { attachments, setAttachments, addFiles } = surface?.intake ?? attachmentsApi ?? localIntake;
	const { marks, resolveMention } = useComposerMarks(text, attachments, rpc);
	// Armed plan/goal: one tap arms the mode chip —
	// NO popup dialog and NO session creation, so the welcome input keeps
	// its shape. The first sent message applies the mode (goal: the
	// message text becomes the objective; plan: session opens in plan
	// mode). A second tap disarms.
	const [planArmed, setPlanArmed] = useState(false);
	const [goalArmed, setGoalArmed] = useState(false);
	const [guidedArmed, setGuidedArmed] = useState(false);
	/** Attach chip clicked → open the same attach menu the paperclip opens
	 *  (the frame owns no picker of its own; the menu does). */
	const openAttachMenu = useRef<(() => void) | null>(null);
	// Sketch board (Codex 绘画 parity): welcome-side sketching rides the same
	// image-attachment pipeline (no workspace needed). `initial` mounts an
	// image from the lightbox edit action as the base layer; `editId` targets
	// an existing chip so finishing replaces it in place (session-composer
	// parity — an extended board must not pile up a second chip).
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
	const [shotSrc, setShotSrc] = useState<string | null>(null);

	// kimicode 截屏 parity ("+" 菜单 / ⇧⌘S): capture the primary display via
	// the main process, then open the annotate board ON the shot — capture →
	// markup → chip, same flow as the session composer (the PNG rides the
	// normal image-attachment pipeline, no workspace needed).
	const openCapture = useCallback((): void => {
		const api = (
			window as unknown as { electronAPI?: { captureScreen?: () => Promise<{ dataUrl?: string; error?: string }> } }
		).electronAPI;
		if (!api?.captureScreen) return;
		void api.captureScreen().then(res => {
			if (res.dataUrl) setShotSrc(res.dataUrl);
		});
	}, []);
	useEffect(() => {
		const onCapture = (): void => openCapture();
		window.addEventListener("musepi-gui-capture-screen", onCapture);
		return () => window.removeEventListener("musepi-gui-capture-screen", onCapture);
	}, [openCapture]);

	// Voice dictation (session-composer parity): the welcome composer's tips
	// advertise the mic button, so the empty state must actually ship one.
	// Local STT via the daemon — the shared use-dictation phase state, so the
	// transcription wait keeps its feedback here exactly like in-session.
	// Dictation submit trigger (settings.stt.submitTrigger, TUI parity): whether
	// finishing a dictation auto-sends the transcript instead of filling the draft.
	// Same load carries stt.enabled (TUI parity): settings.get omits it while
	// unconfigured (schema default false is TUI opt-in semantics), so the mic
	// stays enabled unless the user explicitly turned speech input off.
	const [sttSubmitTrigger, setSttSubmitTrigger] = useState<SttSubmitTrigger>("never");
	const [sttEnabled, setSttEnabled] = useState(true);
	useEffect(() => {
		const load = (): void => {
			void rpc
				.request<Record<string, unknown> | null>("settings.get", { keys: ["stt.submitTrigger", "stt.enabled"] })
				.then(v => {
					setSttEnabled(v?.["stt.enabled"] !== false);
					const t = v?.["stt.submitTrigger"];
					if (typeof t === "string" && t !== "never") setSttSubmitTrigger(t as SttSubmitTrigger);
				})
				.catch(() => {});
		};
		load();
		return onSettingsChanged(load);
	}, [rpc]);
	const dictation = useDictation({
		rpc,
		sttSubmitTrigger,
		enabled: sttEnabled,
		editor: taRef,
		onSubmit: text => {
			// Welcome parity: the auto-send path trims before firing (a
			// transcript that is only a "submit" tail sends nothing).
			const trimmed = text.trim();
			if (trimmed) sendText(trimmed);
		},
		onInsert: transcript => {
			setText(prev => (prev ? `${prev} ${transcript}` : transcript));
			requestAnimationFrame(() => autosize(taRef.current));
		},
	});
	// First-use voice guide (session-composer parity): the welcome mic opens the
	// download-then-dictate dialog instead of firing a bare transcribe RPC.
	const voiceSetup = useVoiceSetupGate({ rpc, onProceed: dictation.toggle, enabled: sttEnabled });
	// The desktop pet's quick bar asks for dictation through this same gate, so
	// the welcome state answers the capsule exactly like an open session does.
	useEffect(() => {
		const onDictate = (): void => {
			void voiceSetup.onToggle();
		};
		window.addEventListener("musepi-gui-dictate-start", onDictate);
		return () => window.removeEventListener("musepi-gui-dictate-start", onDictate);
	}, [voiceSetup]);
	// 上手就绪态（setup.status，欢迎页状态感知空态）：null = 未加载；
	// true = 模型未配置 → 渲染恢复引导卡。刷新源 = 挂载 + onboarding 内
	// 供应商动作广播（musepi-gui-providers-changed）+ onboarding 完成 +
	// settings 变更 + 窗口重新聚焦（OAuth 浏览器跳转回来）。RPC 不可达时
	// fail-open（不显示卡片，不拦输入）——就绪态是引导，不是门禁。
	const [modelMissing, setModelMissing] = useState<boolean | null>(null);
	useEffect(() => {
		let cancelled = false;
		const load = (): void => {
			void rpc
				.request<{ model?: "ready" | "none" } | null>("setup.status", {})
				.then(status => {
					if (!cancelled) setModelMissing(status?.model === "none");
				})
				.catch(() => {
					if (!cancelled) setModelMissing(false);
				});
		};
		load();
		const reload = (): void => load();
		window.addEventListener("musepi-gui-providers-changed", reload);
		window.addEventListener("musepi-onboarding-finished", reload);
		const offSettings = onSettingsChanged(reload);
		window.addEventListener("focus", reload);
		return () => {
			cancelled = true;
			window.removeEventListener("musepi-gui-providers-changed", reload);
			window.removeEventListener("musepi-onboarding-finished", reload);
			offSettings();
			window.removeEventListener("focus", reload);
		};
	}, [rpc]);
	// Thinking preselect: the boot snapshot (modelRoles.default suffix →
	// defaultThinkingLevel) may arrive after first paint — apply it until the
	// user touches the selector. undefined = no snapshot yet.
	const thinkingTouched = useRef(false);
	// 占位起点:模型的真实 ladder 到达后由 reconcile effect 落到支持的档位,
	// 而不是把这个值直接当作「中」显示。
	const [thinking, setThinking] = useState<ThinkingLevel | null>("medium");
	useEffect(() => {
		if (presetThinkingLevel !== undefined && !thinkingTouched.current) setThinking(presetThinkingLevel);
	}, [presetThinkingLevel]);
	// Preselect the settings-configured default model when present; the user
	// can still switch freely before the first prompt.
	const [modelId, setModelId] = useState<string | null>(() => {
		try {
			return localStorage.getItem("musepi-gui-default-model");
		} catch {
			return null;
		}
	});
	// A real pick (onSelect) wins at create time: presetModelId (the app's
	// DEFAULT/memory snapshot) is non-null whenever a DEFAULT is configured
	// or any session was opened, so `presetModelId ?? modelId` would silently
	// drop an explicit welcome selection and the new session would run the
	// DEFAULT while the selector highlighted the picked model.
	const modelTouched = useRef(false);
	// Current model's exact thinking ladder (models.detail → getSupported
	// efforts): the selector shows off/auto + the model's real rungs, and
	// re-queries when the selection changes.
	const [thinkingEfforts, setThinkingEfforts] = useState<string[] | null>(null);
	/** 选中模型自己的默认档位(catalog `thinking.defaultLevel`):模型声明了就用它,
	 *  没声明才回落到全局默认。切换模型必须重新取,否则胶囊挂着上一个模型的值。 */
	const [thinkingModelDefault, setThinkingModelDefault] = useState<ThinkingLevel | null>(null);
	const effectiveModelId = presetModelId ?? modelId;
	// The ladder must follow the model the session will actually run: a real
	// pick (modelTouched) beats the DEFAULT/session snapshot — the same
	// precedence as session.create's modelId below. The ref is set before
	// setModelId re-renders, so reading it here tracks the pick.
	const ladderModelId = modelTouched.current ? modelId : effectiveModelId;
	useEffect(() => {
		// 换模型 = 换 ladder + 换默认:上一个模型的 ladder 不能拿来收紧新模型,
		// 用户在上一个模型上的显式选择也不代表新模型(默认值重新接管)。
		setThinkingEfforts(null);
		setThinkingModelDefault(null);
		thinkingTouched.current = false;
		if (!rpc || !ladderModelId) return;
		let cancelled = false;
		void rpc
			.request<{ efforts?: string[]; defaultLevel?: string | null } | null>("models.detail", { id: ladderModelId })
			.then(detail => {
				if (cancelled) return;
				// null = id not resolved (e.g. provider-qualified selector the
				// daemon couldn't match) → full ladder; a resolved model with
				// empty efforts genuinely has no controllable surface → off+auto.
				setThinkingEfforts(detail === null ? null : detail.efforts?.length ? detail.efforts : []);
				setThinkingModelDefault((detail?.defaultLevel ?? null) as ThinkingLevel | null);
			})
			.catch(() => {
				if (!cancelled) setThinkingEfforts(null);
			});
		return () => {
			cancelled = true;
		};
	}, [rpc, ladderModelId]);
	// 胶囊绝不该显示当前模型没有的档位;新模型先落到它自己的默认档位
	// (catalog defaultLevel → 全局默认 → 第一档)。ladder 未到时不动,避免首帧
	// 闪一下兜底值。
	useEffect(() => {
		if (thinkingEfforts === null) return;
		setThinking(prev => {
			const preferred = thinkingTouched.current
				? prev
				: ((thinkingModelDefault ?? presetThinkingLevel ?? prev) as ThinkingLevel | null);
			const next = clampThinkingChipLevel(preferred, thinkingEfforts) as ThinkingLevel | null;
			return next === prev ? prev : next;
		});
	}, [thinkingEfforts, thinkingModelDefault, presetThinkingLevel]);
	const [tipKey] = useState<(typeof TIP_KEYS)[number]>(() => TIP_KEYS[Math.floor(Math.random() * TIP_KEYS.length)]!);
	// Git branch selector: current branch +
	// local branch list for the active project; hidden outside a repo.
	const [branchInfo, setBranchInfo] = useState<{ current: string | null; branches: string[] } | null>(null);
	const [branchOpen, setBranchOpen] = useState(false);

	useEffect(() => {
		if (!rpc || !project) {
			setBranchInfo(null);
			return;
		}
		let cancelled = false;
		const load = (): void => {
			void rpc
				.request<{ current: string | null; branches: string[] } | { error: string }>("git.branches", {
					cwd: project,
				})
				.then(res => {
					if (cancelled || !res || "error" in res) {
						if (!cancelled && (!res || "error" in res)) setBranchInfo(null);
						return;
					}
					setBranchInfo(res);
				})
				.catch(() => {
					if (!cancelled) setBranchInfo(null);
				});
		};
		load();
		const onProjectChange = (): void => load();
		window.addEventListener("musepi-gui-project-added", onProjectChange);
		return () => {
			cancelled = true;
			window.removeEventListener("musepi-gui-project-added", onProjectChange);
		};
	}, [rpc, project]);
	const [switchingBranch, setSwitchingBranch] = useState(false);
	const switchBranch = useCallback(
		async (branch: string): Promise<void> => {
			if (!rpc || !project || switchingBranch) return;
			setSwitchingBranch(true);
			try {
				const res = (await rpc.request("git.checkout", { cwd: project, branch })) as
					| { ok: boolean; error?: string }
					| undefined;
				if (res && "error" in res && res.error) {
					window.dispatchEvent(new CustomEvent("musepi-gui-toast", { detail: res.error }));
				} else if (res?.ok) {
					setBranchInfo(prev => (prev ? { ...prev, current: branch } : prev));
					setBranchOpen(false);
				}
			} catch {
				// rpc error → silent (daemon offline)
			} finally {
				setSwitchingBranch(false);
			}
		},
		[rpc, project, switchingBranch],
	);
	// Draft suggestions: user-curated
	// via 设置 → 预设提示词 (lib/suggestions — localStorage + change event);
	// builtins fall back to the i18n-keyed defaults. Collapsed shows the
	// first 8 chips; + expands with a staggered blur-in and morphs into ✕;
	// a 自定义补充 chip jumps to the settings section.
	const [suggestions, setSuggestions] = useState<StoredSuggestion[]>(() => loadSuggestions());
	// Active preset mode: the welcome default is always a real mode ("work")
	// — there is no "no preset" state anymore, so null never
	// reaches the UI (chip label / active check / session create all use
	// this normalized id).
	const activeModeId = agentPreset ?? "work";
	useEffect(() => {
		const reload = (): void => setSuggestions(loadSuggestions());
		window.addEventListener(SUGGESTIONS_CHANGED_EVENT, reload);
		window.addEventListener("storage", reload);
		return () => {
			window.removeEventListener(SUGGESTIONS_CHANGED_EVENT, reload);
			window.removeEventListener("storage", reload);
		};
	}, []);
	const [showMore, setShowMore] = useState(false);
	// One commit per expand/collapse, not a staged re-reveal. Each prior
	// stage (one chip per 90ms) retargeted the height tween mid-flight, so the
	// container stopped, restarted and settled repeatedly — read as jitter.
	// Extras now mount together and keep their per-chip CSS stagger; the
	// container morph runs once through HeightMorph.
	const [collapsing, setCollapsing] = useState(false);
	const collapseTimerRef = useRef<number | null>(null);
	useEffect(
		() => () => {
			if (collapseTimerRef.current) clearTimeout(collapseTimerRef.current);
		},
		[],
	);
	const expandSuggestions = (): void => {
		if (showMore || collapsing) return;
		setShowMore(true);
	};
	const collapseSuggestions = (): void => {
		if (!showMore || collapsing) return;
		setCollapsing(true);
		// Let the extra chips fade out, then unmount them in one commit;
		// HeightMorph eases the container from the expanded height to the
		// collapsed height in that same commit.
		collapseTimerRef.current = window.setTimeout(() => {
			collapseTimerRef.current = null;
			setCollapsing(false);
			setShowMore(false);
		}, 150);
	};
	// Chips shown: base 8 always; extras stay mounted during the collapse
	// fade-out so the container only morphs once they are gone.
	const visibleSuggestions = showMore || collapsing ? suggestions : suggestions.slice(0, SUGGESTIONS_COLLAPSED_COUNT);
	const applySuggestion = (prompt: string): void => {
		setText(prompt);
		requestAnimationFrame(() => autosize(taRef.current));
		requestAnimationFrame(() => taRef.current?.focus());
	};
	const [welcomeGreeting, setWelcomeGreeting] = useState(readWelcomeGreeting);
	useEffect(() => {
		const onChanged = (event: Event): void => {
			if (event.type === "storage" && (event as StorageEvent).key !== WELCOME_GREETING_STORAGE_KEY) return;
			setWelcomeGreeting(readWelcomeGreeting());
		};
		window.addEventListener(WELCOME_GREETING_CHANGED_EVENT, onChanged);
		window.addEventListener("storage", onChanged);
		return () => {
			window.removeEventListener(WELCOME_GREETING_CHANGED_EVENT, onChanged);
			window.removeEventListener("storage", onChanged);
		};
	}, []);
	// / @ # completion (composer parity) — the same controller the session
	// composer uses (composer/use-completion). The empty state differs only in
	// what it can resolve: there is no session id yet, so the selected
	// project's remembered roots stand in for the session's directories.
	const [completionExtraRoots, setCompletionExtraRoots] = useState<string[]>([]);
	useEffect(() => {
		let cancelled = false;
		setCompletionExtraRoots([]);
		if (!rpc || !project) return;
		void rpc
			.request<{ workspaces?: Array<{ root: string; additionalDirs?: string[] }> }>("workspace.list", {})
			.then(list => {
				if (cancelled) return;
				setCompletionExtraRoots(list?.workspaces?.find(row => row.root === project)?.additionalDirs ?? []);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [rpc, project]);
	const {
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
		atQuery,
		onAtInput,
		insertAt,
	} = useCompletion({
		rpc,
		cwd: project ?? undefined,
		sessionId: null,
		extraRoots: completionExtraRoots,
		// The empty state lists the shallow tree only; a session's @ panel
		// reaches any depth.
		atMaxDepth: 2,
		setText,
		editorRef: taRef,
	});
	const [projOpen, setProjOpen] = useState(false);
	const [presetOpen, setPresetOpen] = useState(false);
	// Saved workspaces (sidebar 项目 tab parity): every folder the app
	// knows (musepi-gui-projects localStorage — seeded from session cwds and
	// grown by folder picks), so the workspace picker lists them for
	// one-tap switching instead of only offering 添加项目/远程连接.
	const [savedProjects, setSavedProjects] = useState<string[]>(() => {
		try {
			const raw = localStorage.getItem("musepi-gui-projects");
			const parsed: unknown = raw ? JSON.parse(raw) : [];
			return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
		} catch {
			return [];
		}
	});
	// Issue #15: two saved workspaces can share a folder name — widen the
	// LABEL (`a/demo`) while the path stays the identity.
	const savedLabels = useMemo(() => projectLabels(savedProjects), [savedProjects]);
	// Keep the picker list in sync with the sidebar: folder picks dispatch
	// musepi-gui-project-added, and other windows (mini chat) write storage.
	useEffect(() => {
		const refresh = (): void => {
			try {
				const raw = localStorage.getItem("musepi-gui-projects");
				const parsed: unknown = raw ? JSON.parse(raw) : [];
				setSavedProjects(Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : []);
			} catch {
				setSavedProjects([]);
			}
		};
		window.addEventListener("musepi-gui-project-added", refresh);
		window.addEventListener("storage", refresh);
		return () => {
			window.removeEventListener("musepi-gui-project-added", refresh);
			window.removeEventListener("storage", refresh);
		};
	}, []);
	// The beam is a page-entrance accent, not a focus effect: it runs once for
	// three seconds when the welcome page mounts, then stops so the heavy conic
	// repaint ends. Focusing the input must not restart it. Focus
	// (distraction-free) mode never shows it — the input should be the only
	// thing on screen.
	const [beamOn, setBeamOn] = useState(false);
	useEffect(() => {
		if (focused) return;
		setBeamOn(true);
		const timer = window.setTimeout(() => setBeamOn(false), 3000);
		return () => window.clearTimeout(timer);
		// Mount only: re-running on focus-mode toggles would restart the sweep.
	}, []);
	useEffect(() => {
		if (focused) setBeamOn(false);
	}, [focused]);
	// Portaled workspace-picker popup (model/thinking selector parity): the
	// frosted glass samples real content behind it, and the exit animates.
	// Single-layer: className carries the visual (gui-proj-menu), the hook
	// provides portal + position + animation (Pop parity — no nested Pop).
	const { anchorRef: projAnchorRef, renderMenu: renderProjMenu } = useFloatingMenu(projOpen, setProjOpen, {
		className: "gui-proj-menu",
	});
	// 预设(mode)选择菜单:与项目选择同款浮层样式。
	const { anchorRef: presetAnchorRef, renderMenu: renderPresetMenu } = useFloatingMenu(presetOpen, setPresetOpen, {
		className: "gui-proj-menu",
	});
	const { anchorRef: branchAnchorRef, renderMenu: renderBranchMenu } = useFloatingMenu(branchOpen, setBranchOpen, {
		className: "gui-proj-menu",
	});
	// / @ # completion preview (composer parity): one floating menu for all
	// three triggers, portaled so the glass samples real content behind it.
	const compOpen = slashOpen || atOpen;
	const { anchorRef: compAnchorRef, renderMenu: renderCompMenu } = useFloatingMenu(compOpen, open => {
		if (open) return;
		setSlashOpen(false);
		setAtOpen(false);
	});
	// Only one completion menu is mounted at a time (conditional render), so
	// a single ref tracks whichever is open. The menu scrolls internally
	// (max-height 300px, overflow-y auto) — keep the active row in view
	// while arrow-navigating.
	const formRef = useRef<HTMLFormElement | null>(null);
	// Select-all + delete clears text AND attachments together (consumed
	// by onChange once the textarea reports the emptied value).
	const clearAllRef = useRef(false);
	const intake = useComposerIntake({
		editor: taRef,
		attachments,
		addFiles,
		setAttachments,
		setText,
		clearAllRef,
		autosize: () => autosize(taRef.current),
		onLongPaste: (pastedText, event) => {
			if (!isLongPastedText(pastedText)) return false;
			event.preventDefault();
			requestPaste(pastedText);
			return true;
		},
		onValueChange: value => {
			onSlashInput(value);
			onAtInput(value);
		},
		onMentionClick: start => {
			const ta = taRef.current;
			if (!ta) return;
			ta.focus();
			ta.setSelectionRange(start, start);
		},
	});
	// Value-driven autosize fallback (long-paste choose, quote append,
	// /retry edit…): programmatic setText bypasses onChange, so the box
	// re-measures after every draft commit — not just keystrokes.
	useEffect(() => {
		const raf = requestAnimationFrame(() => autosize(taRef.current));
		return () => cancelAnimationFrame(raf);
	}, [text]);

	// ── M3.7a design 模式内联形态(v2 修订,§2.2/§2.3)──────────────────────
	// mode chip 选中「设计」时类型 chip 排落在本 composer 上方一行:
	// CreationModeRow 拥有「类型选择 → projectMetadata」的编译与模板
	// rail,通过 onStateChange 上报 placeholder/template/busy,通过 onReady
	// 交出发送句柄——发送钩子改走 session.create + projectMetadata 管线。
	const designActive = activeModeId === "design" && designSubmit !== undefined;
	const [railState, setRailState] = useState<CreationRailState | null>(null);
	// The chosen shape. Mirrors the draft field CreationModeRow owns — this
	// copy is what the picker (rendered below, above the input) reads, so
	// picking does not need a round trip through the draft before the card
	// highlights.
	const [startFrom, setStartFrom] = useState<string | null>(null);
	const railRef = useRef<CreationRailHandle | null>(null);
	const designTemplate = designActive && railState?.template === true;
	// 模板 rail 自建会话期的 busy(TemplateRail 经 onBusyChange 上报),
	// 与 railState.busy 同一语义:发送期禁按。
	const [templateBusy, setTemplateBusy] = useState(false);
	const canSend = (text.trim().length > 0 || quotes.length > 0) && !busy && !railState?.busy && !templateBusy;
	// 素材策略行 + 「高级 ▸」折叠区的 portal 插槽(M3.7c §4):designActive 时
	// 挂在 composer 下方、设计体系 rail 之下(§2.2 信息架构最底行);callback
	// ref 喂 state——CreationModeRow 依元素存在与否渲染 portal,收起即卸载。
	const [assetSlot, setAssetSlot] = useState<HTMLElement | null>(null);

	// ── Design empty state (设计稿 08 → M3.7b §3): preset armed to "design" ──
	// The welcome composer mirrors the session composer's design select;
	// the pick lands in the creation draft instead of a composer sentence:
	// designSystemId rides session.create's projectMetadata (设计体系轴生效
	// 链路，选中才带键，null/跟随既有不覆盖 M3.1 占位)。预览 rail 与
	// 本胶囊同源 systems/selected（§3.3）。
	const isDesignArmed = activeModeId === "design";
	const designSystems = useDesignSystems(rpc);
	const [designStyle, setDesignStyle] = useState<string | null>(null);
	const pickDesignStyle = useCallback((id: string | null): void => {
		setDesignStyle(id);
	}, []);

	// Focus-mode size morph. CSS transitions don't play reliably here
	// (flex display change + the pin/reflow dance), so the morph runs on
	// the Web Animations API: from the current height AND width to the
	// inner column's size (open: fills the surface) or the content size
	// (closed: back to the 560px column). Inline styles are set to the
	// targets immediately; the running animation overrides them visually
	// (CSS animations beat normal declarations). Width is released on
	// finish (w-full matches both targets); height only when closing —
	// open must stay pinned to keep the fill.
	const morphed = useRef(false);
	const morphVer = useRef(0);
	// Size captured during render — the DOM still carries the PREVIOUS
	// layout at that point (React commits after the render phase), so the
	// morph can start from the pre-toggle size. Reading it in the effect
	// would already see the post-toggle layout (the inner column snaps to
	// max-width:none) and the width animation would never play.
	const prevSize = useRef<{ w: number; h: number; top: number } | null>(null);
	const formEl = formRef.current;
	if (formEl) {
		const r = formEl.getBoundingClientRect();
		prevSize.current = { w: r.width, h: r.height, top: r.top };
	}
	// Layout effect (not useEffect): the morph must pin the from-size and
	// start the WAAPI animation BEFORE the browser paints the commit state.
	// A passive effect runs after paint — for the expand direction the
	// commit already switched .gui-welcome-inner to max-width:none, so the
	// browser would paint one frame at full width (158×960 observed), then
	// the pin snaps back to 123×560 and the morph re-grows it — a flash →
	// snap-back → grow stutter that the collapse direction never shows
	// (there the pinned height survives the commit, so the first painted
	// frame is already the morph's from-frame).
	useLayoutEffect(() => {
		const form = formRef.current;
		if (!form) return;
		if (!morphed.current) {
			// First run: settle the textarea (still at the rows=3 markup
			// default — the autosize effect runs after this one) and release
			// any pinned sizes. No morph: the initial size IS the autosized
			// content size, and morphing from the rows=3 height would play a
			// shrink animation on mount.
			morphed.current = true;
			autosize(taRef.current);
			form.style.width = "";
			form.style.height = "";
			return;
		}
		const prev = prevSize.current;
		const fromW = prev ? prev.w : form.getBoundingClientRect().width;
		const fromH = prev ? prev.h : form.getBoundingClientRect().height;
		let targetW: number;
		let targetH: number;
		if (focused) {
			const inner = form.parentElement;
			targetW = inner?.getBoundingClientRect().width ?? fromW;
			targetH = inner?.getBoundingClientRect().height ?? fromH;
		} else {
			// Settle the textarea to its content height FIRST — the autosize
			// effect runs after this one (declaration order), and measuring
			// with the stale focused height (100% of a content-sized wrap
			// resolves back to rows=3) would mis-target the collapse.
			autosize(taRef.current);
			// Measure the unpinned content size (scrollHeight returns the
			// element's own size while the pinned inline styles are set;
			// same-frame restore, no visual flash).
			const prevH = form.style.height;
			const prevW = form.style.width;
			form.style.height = "";
			form.style.width = "";
			void form.offsetHeight;
			const c = form.getBoundingClientRect();
			targetH = c.height;
			targetW = c.width;
			form.style.height = prevH;
			form.style.width = prevW;
		}
		if (Math.abs(fromW - targetW) < 1 && Math.abs(fromH - targetH) < 1) {
			// No size change (e.g. the initial mount) — nothing to morph.
			form.style.width = "";
			form.style.height = "";
			return;
		}
		form.style.height = `${targetH}px`;
		form.style.width = `${targetW}px`;
		form.classList.add("gui-morphing");
		void form.offsetHeight;
		// The morph-window layout seats the form at its STEADY-STATE top
		// (focused: the inner column top; closed: below the re-shown brand
		// rows). A plain size animation would paint frame 1 there and read
		// as "the composer jumps first, then grows". translateY(eases to 0)
		// seats frame 1 at the true pre-toggle top (prevSize.top) — both
		// edges travel the curve, the bottom gutter included.
		const layoutTop = form.getBoundingClientRect().top;
		const preTop = prev ? prev.top : null;
		const dy = preTop !== null ? preTop - layoutTop : 0;
		const fromTx = Math.abs(dy) >= 1 ? `translateY(${dy}px)` : "none";
		const anim = form.animate(
			[
				{ height: `${fromH}px`, width: `${fromW}px`, transform: fromTx },
				{ height: `${targetH}px`, width: `${targetW}px`, transform: "none" },
			],
			{ duration: 280, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
		);
		// Release the pinned sizes once the morph settles. The finish event
		// is unreliable (headless Chromium never dispatches it, and a
		// cancelled animation won't fire it), so a versioned timer backs it
		// up — a newer morph bumps the version and supersedes the cleanup.
		// Width is always safe to release (w-full matches both targets);
		// height only when closed (open must stay pinned to keep the fill).
		const ver = ++morphVer.current;
		const release = (): void => {
			if (morphVer.current !== ver) return;
			form.classList.remove("gui-morphing");
			form.style.width = "";
			if (!focused) form.style.height = "";
		};
		anim.addEventListener("finish", release);
		setTimeout(release, 320);
	}, [focused]);

	// Autosize the textarea on mount (same behavior as the session
	// composer): the initial height IS the autosized content height, so
	// typing the first lines never resizes the card — only exceeding the
	// row cap grows it. Every keystroke autosizes synchronously in
	// onChange (mirroring Composer), and the focus morph settles it
	// explicitly when leaving focus mode.
	useEffect(() => {
		autosize(taRef.current);
	}, []);

	// Annotation screenshots use the ordinary attachment pipeline; their text
	// stays in display context until send.
	const addFilesForAnnotationRef = useRef(addFiles);
	addFilesForAnnotationRef.current = addFiles;
	// Publish the intake to the chat-level drop anchor (session composer
	// parity): a drop over the welcome card stages these same chips.
	useEffect(() => {
		if (!attachApiRef) return;
		const api = { addFiles: (files: File[]) => addFilesForAnnotationRef.current(files) };
		attachApiRef.current = api;
		return () => {
			if (attachApiRef.current === api) attachApiRef.current = null;
		};
	}, [attachApiRef]);
	useEffect(() => {
		const onAttach = (e: Event): void => {
			const detail = (e as CustomEvent<AnnotationAttachDetail>).detail;
			if (!detail?.displayContext) return;
			setQuotes(current => [...current, detail.displayContext]);
			if (detail.image) void addFilesForAnnotationRef.current([detail.image]);
			requestAnimationFrame(() => autosize(taRef.current));
			requestAnimationFrame(() => taRef.current?.focus());
		};
		window.addEventListener(ANNOTATION_ATTACH_EVENT, onAttach);
		return () => window.removeEventListener(ANNOTATION_ATTACH_EVENT, onAttach);
	}, []);

	// Board → chip, one path for every entry point (attach menu, chip click,
	// lightbox edit). `sketch.editId` decides whether this extends an existing
	// chip or mints one — the session composer's rule, so a board opened from a
	// chip never leaves a duplicate behind.
	const onSketchDone = (dataUrl: string, scene: SketchScene): void => {
		const editId = sketch.editId;
		setSketch({ open: false, editId: null, initial: null, scene: null });
		if (editId !== null) {
			setAttachments(prev =>
				prev.map(a =>
					a.id === editId
						? {
								...a,
								dataUrl,
								mimeType: dataUrl.slice(5, dataUrl.indexOf(";")) || a.mimeType,
								size: Math.round((dataUrl.length - dataUrl.indexOf(",")) * 0.75),
								sketch: true,
								// The board's current strokes: the next click
								// reopens the objects, not a raster of them.
								sketchScene: scene,
							}
						: a,
				),
			);
			return;
		}
		const fileName = nextSketchFileName();
		void (async () => {
			await addFiles([dataUrlToFile(dataUrl, fileName)]);
			// AFTER the add settles: addFiles awaits the settings read before
			// appending, so marking first would map the pre-add array and drop
			// the flag (the chip would then open the plain preview).
			setAttachments(prev => markSketchChip(prev, fileName, scene));
		})();
	};

	// Send a trimmed prompt (shared by form submit and voice-dictation
	// auto-submit): carries the welcome preselects (model/thinking) and armed
	// modes into the session this first prompt creates.
	const sendText = (trimmed: string): void => {
		// Attachment mentions (session-composer parity): expand before the
		// quote prefix so the references ride the first prompt too.
		const expanded = expandMentionTokens(trimmed, attachments);
		const payload = composeDisplayContextPrompt(quotes, expanded);
		// M3.7a 内联形态:design 模式发送改走 session.create + projectMetadata
		// 管线(§2.4)——快照草稿先行,clear 交给结果:失败回填输入,成功由
		// rail 收起模式页(mode chip 复位 work)。
		if (designActive && railRef.current && !designTemplate) {
			const prevText = text;
			const prevQuotes = quotes;
			const prevAttachments = attachments;
			setText("");
			setQuotes([]);
			setAttachments([]);
			requestAnimationFrame(() => autosize(taRef.current));
			sfxFor("first");
			// Same beam drop as the plain submit path — see the note there.
			setBeamOn(false);
			void railRef.current
				.submit(payload, {
					thinkingLevel: thinking,
					modelId: modelTouched.current ? modelId : effectiveModelId,
					// Chip order IS the send order (drag-reorder moves chips in
					// the state array; these projections follow it).
					images: attachmentImageParts(prevAttachments),
					files: attachmentFiles(prevAttachments),
					displayContext: messageDisplayContext(prevQuotes),
				})
				.then(ok => {
					if (!ok) {
						setText(prevText);
						setQuotes(prevQuotes);
						setAttachments(prevAttachments);
						requestAnimationFrame(() => autosize(taRef.current));
					}
				});
			return;
		}
		setText("");
		setQuotes([]);
		setAttachments([]);
		// Re-measure after the programmatic clear (onChange doesn't fire).
		requestAnimationFrame(() => autosize(taRef.current));
		sfxFor("first");
		// End the entrance beam the moment the prompt leaves: it must not ride
		// the welcome→session FLIP morph spinning (the per-frame conic repaints
		// compete with the morph). The leaving-scene freeze in gui-chat.css
		// covers the overlap window; this makes the beam's display window end at
		// send, not at unmount.
		setBeamOn(false);
		// Armed modes apply to the session this first prompt creates; the
		// armed chips reset either way (goal needs text to be an objective).
		const applyGoal = goalArmed && trimmed.length > 0;
		// Guided goal rides on this first prompt instead of firing the
		// interview on the menu click: the user writes the objective, sends,
		// and the interview starts from that message.
		const applyGuided = guidedArmed && trimmed.length > 0;
		setGuidedArmed(false);
		setGoalArmed(false);
		setPlanArmed(false);
		const videos = attachmentVideoSelection(attachments);
		void send(payload, {
			thinkingLevel: thinking,
			// modelId is the provider/id composite after a pick (setModelId above);
			// session.create forwards it as modelPattern, which resolves exactly
			// via the daemon's provider reference match — no bare-id ambiguity.
			modelId: modelTouched.current ? modelId : effectiveModelId,
			// Chip order IS the send order (drag-reorder moves chips in the
			// state array; these projections follow it).
			images: attachmentImageParts(attachments),
			displayContext: messageDisplayContext(quotes),
			// Non-image chips (the attach menu's file entry). The host owns the
			// workspace decision: it writes these into the session it creates,
			// or asks for a project when there is none.
			files: attachmentFiles(attachments.filter(a => !videos.chipIds.has(a.id))),
			videos: videos.parts,
			planMode: planArmed,
			goalMode: applyGoal,
			guidedGoal: applyGuided,
		});
	};

	const submit = (e: FormEvent<HTMLFormElement>): void => {
		e.preventDefault();
		const trimmed = text.trim();
		if ((!trimmed && quotes.length === 0 && attachments.length === 0) || busy) return;
		// GUI-native /usage (empty state): no session, but /usage is NOT
		// model-bound — fetch the global quota view session-less instead of
		// submitting the command (the agent's reply would be TUI ANSI text).
		if (isUsageCommand(trimmed)) {
			setText("");
			setContextNote(false);
			setUsagePanel({ open: true, loading: true, data: null });
			sfxFor("send");
			void rpc
				.request<{
					reports: UsageReportView[];
					activeAccount?: UsageActiveAccountView | null;
					unreportedAccounts?: UsageUnreportedAccountView[];
					disabledCredentials?: UsageDisabledCredentialView[];
					reloginDeadlines?: UsageReloginDeadlineView[];
				}>("usage.reports", {})
				.then(res => {
					setUsagePanel(s =>
						s.open
							? {
									open: true,
									loading: false,
									data: {
										reports: res?.reports ?? [],
										activeAccount: res?.activeAccount ?? null,
										unreportedAccounts: res?.unreportedAccounts ?? [],
										disabledCredentials: res?.disabledCredentials ?? [],
										reloginDeadlines: res?.reloginDeadlines ?? [],
										fetchedAt: Date.now(),
									},
								}
							: s,
					);
				})
				.catch(() => {
					setUsagePanel(s => (s.open ? { open: true, loading: false, data: null } : s));
				});
			return;
		}
		// /context IS session-bound — empty state shows a note, not data.
		if (isContextCommand(trimmed)) {
			setText("");
			setUsagePanel(s => ({ ...s, open: false }));
			setContextNote(true);
			sfxFor("send");
			return;
		}
		sendText(trimmed);
	};

	const heroBody = (
		<>
			<div className="relative z-10 flex w-full max-w-[720px] flex-col items-center gui-welcome-inner">
				{/* Workspace picker: dropdown list attached
				 * right above the input — current project, open folder, remote. */}
				<div className="gui-brand mb-2 flex items-center gap-2">
					<SlotComponentHost
						rpc={rpc}
						slot={HERO_BRAND_MARK_SLOT}
						cwd={project ?? undefined}
						fallback={<span className="gui-brand-mark">π</span>}
					/>
					<BlurText text={t("settings.musepi")} className="text-[22px] font-bold" />
				</div>
				<p className="gui-welcome-greet pointer-events-none mb-4">
					<BlurText text={resolveWelcomeGreeting(welcomeGreeting, greeting(hour))} stepMs={38} />
				</p>
				{/* 恢复引导卡（就绪态 P0）：模型未配置时在输入框上方提示，
				 * 一键跳引导的服务商配置步（musepi-open-onboarding detail.step，
				 * OnboardingOverlay 支持可选定位）。ready 时零渲染——就绪态是
				 * 引导不是门禁，专注模式下也不显示（输入优先）。 */}
				{modelMissing && !focused && (
					<div className="gui-welcome-setup mb-3" role="status">
						<div className="gui-welcome-setup-text">
							<span className="gui-welcome-setup-title">{t("general.setUpModelStart")}</span>
							<span className="gui-welcome-setup-desc">{t("general.connectProviderAdd.info")}</span>
						</div>
						<button
							type="button"
							className="gui-btn gui-btn-primary gui-welcome-setup-btn"
							onClick={() =>
								window.dispatchEvent(
									new CustomEvent("musepi-open-onboarding", { detail: { step: ONBOARDING_PROVIDER_STEP } }),
								)
							}
						>
							{t("general.addModel")}
						</button>
					</div>
				)}
				{/* M3.7a design 模式内联形态(v2 修订):类型 chip 排直接落在
				 * 工作区 chip 排上方一行,无弹层/无第二输入框。opendesign 铁律:
				 * composer 是创建页永久锚点——template chip 选中时输入框常驻,
				 * 模板 rail 落在 composer 下方(见 form 之后的 TemplateRail)。
				 * 进出场走 Reveal(高度 240ms + 淡出 160ms + 内层位移,
				 * gui-creation-reveal),收起的退场动画播完前保持挂载,
				 * 草稿/句柄不因收起丢失。 */}
				<Reveal open={designActive} className="gui-creation-reveal w-full">
					<CreationModeRow
						rpc={rpc}
						active={designActive}
						project={project ?? null}
						assetSlot={assetSlot}
						// 发送只在 designActive 时可达(§2.4 发送钩子由 composer
						// 的 designActive 分支调用),designSubmit 缺省时兜底 false。
						// 设计体系轴(M3.7b §3):选中体系的 id 在这里落进
						// projectMetadata——只在选中时覆盖 designSystemId 键,
						// 未选中保持 buildProjectMetadata 的 M3.1 占位(null)。
						onSubmit={(metadata, message) => {
							const withDesign = designStyle ? { ...metadata, designSystemId: designStyle } : metadata;
							return designSubmit ? designSubmit(withDesign, message) : Promise.resolve(false);
						}}
						onClose={() => onModeChange?.("work")}
						onStartFromChange={id => {
							setStartFrom(id);
							railRef.current?.setStartFrom(id);
						}}
						onStateChange={setRailState}
						onReady={handle => {
							railRef.current = handle;
						}}
					/>
				</Reveal>
				{/* Project target — an independent row above the composer,
				 * left-aligned. */}
				{onProject && (
					<div className="gui-project-row mb-2 flex w-full min-w-0 items-center gap-1.5 px-0.5">
						<SlotComponentHost
							rpc={rpc}
							slot={HERO_WORKSPACE_SLOT}
							cwd={project ?? undefined}
							fallback={
								<div className="relative z-20" ref={projAnchorRef}>
									<button
										type="button"
										className="gui-project-chip"
										onClick={() => setProjOpen(v => !v)}
										aria-label={t("settings.currentProject")}
									>
										<Icon name="folder" className="h-3.5 w-3.5" />
										<span className="max-w-[200px] truncate">
											{project
												? (savedLabels.get(project) ?? projectName(project))
												: t("settings.notProject")}
										</span>
										<Icon name="arrow-down-s" className="h-3 w-3 opacity-60" />
									</button>
									{renderProjMenu(
										<>
											{project && (
												<button
													type="button"
													className="gui-view-opt gui-view-opt--active"
													onClick={() => setProjOpen(false)}
												>
													<Icon name="folder" className="h-3.5 w-3.5" />
													<span className="min-w-0 flex-1 truncate">
														{savedLabels.get(project) ?? projectName(project)}
													</span>
													<Icon name="check" className="h-3 w-3 flex-shrink-0" />
												</button>
											)}
											{/* Saved workspaces (sidebar 项目 tab parity): every folder
											 * the app knows, one tap to switch. Current project is
											 * already listed above with the check — skip it here. */}
											{savedProjects.filter(p => p !== project).length > 0 && (
												<>
													<div className="gui-proj-menu-label">{t("settings.savedWorkspaces")}</div>
													{savedProjects
														.filter(p => p !== project)
														.map(p => (
															<button
																key={p}
																type="button"
																className="gui-view-opt"
																title={p}
																onClick={() => {
																	setProjOpen(false);
																	onProject?.(p);
																}}
															>
																<Icon name="folder" className="h-3.5 w-3.5" />
																<span className="min-w-0 flex-1 truncate">
																	{savedLabels.get(p) ?? projectName(p)}
																</span>
															</button>
														))}
													<div className="gui-proj-menu-sep" />
												</>
											)}
											<button
												type="button"
												className="gui-view-opt"
												onClick={() => {
													setProjOpen(false);
													onProject("add");
												}}
											>
												<Icon name="folder-add" className="h-3.5 w-3.5" />
												<span>{t("settings.addProject")}</span>
											</button>
											<button
												type="button"
												className="gui-view-opt"
												onClick={() => {
													setProjOpen(false);
													onProject("remote");
												}}
											>
												<Icon name="server" className="h-3.5 w-3.5" />
												<span>{t("settings.remoteConnection")}</span>
											</button>
											{project && (
												<button
													type="button"
													className="gui-view-opt"
													onClick={() => {
														setProjOpen(false);
														onProject("none");
													}}
												>
													<Icon name="folder" className="h-3.5 w-3.5" />
													<span>{t("settings.notProject")}</span>
												</button>
											)}
										</>,
									)}
								</div>
							}
						/>
						{/* 预设(mode)chip:与项目 chip 并排一行,
						 * 新会话创建时应用。样式与项目选择同款(按钮 + 浮层菜单)。 */}
						<SlotComponentHost
							rpc={rpc}
							slot={HERO_AGENT_PRESET_SLOT}
							cwd={project ?? undefined}
							fallback={
								modes ? (
									<div className="relative z-20 flex-shrink-0" ref={presetAnchorRef}>
										<button
											type="button"
											className="gui-project-chip"
											onClick={() => setPresetOpen(v => !v)}
											aria-label={t("settings.modesTitle")}
										>
											<Icon name="stack" className="h-3.5 w-3.5" />
											<span className="max-w-[160px] truncate">{resolveModeLabel(activeModeId, modes)}</span>
											<Icon name="arrow-down-s" className="h-3 w-3 opacity-60" />
										</button>
										{renderPresetMenu(
											<>
												{/* 无"默认(无预设)":agentPreset 恒非 null(默认 work),
												 * 每次新建都带一个预设。 */}
												{modes.map(m => {
													const desc = resolveModeDescription(m.id);
													return (
														<button
															key={m.id}
															type="button"
															className={`gui-view-opt${activeModeId === m.id ? " gui-view-opt--active" : ""}${desc ? " gui-view-opt--desc" : ""}`}
															onClick={() => {
																onModeChange?.(m.id);
																setPresetOpen(false);
															}}
														>
															<span className="min-w-0 flex-1 truncate">
																{resolveModeLabel(m.id, modes)}
															</span>
															{activeModeId === m.id && (
																<Icon name="check" className="h-3 w-3 flex-shrink-0" />
															)}
															{desc && <span className="gui-view-opt-desc">{desc}</span>}
														</button>
													);
												})}
											</>,
										)}
									</div>
								) : null
							}
						/>
						{branchInfo && (
							<div className="relative z-20" ref={branchAnchorRef}>
								<button
									type="button"
									className="gui-project-chip"
									onClick={() => setBranchOpen(v => !v)}
									aria-label={t("general.gitBranch")}
									title={t("general.gitBranch")}
								>
									<Icon name="git-branch" className="h-3.5 w-3.5" />
									<span className="max-w-[160px] truncate">{branchInfo.current ?? "—"}</span>
									<Icon name="arrow-down-s" className="h-3 w-3 opacity-60" />
								</button>
								{renderBranchMenu(
									branchInfo.branches.map(b => (
										<button
											key={b}
											type="button"
											className={`gui-view-opt${b === branchInfo.current ? " gui-view-opt--active" : ""}`}
											disabled={switchingBranch}
											onClick={() => {
												if (b === branchInfo.current) {
													setBranchOpen(false);
													return;
												}
												void switchBranch(b);
											}}
										>
											<Icon name="git-branch" className="h-3.5 w-3.5" />
											<span className="min-w-0 flex-1 truncate">{b}</span>
											{b === branchInfo.current && <Icon name="check" className="h-3 w-3 flex-shrink-0" />}
										</button>
									)),
								)}
							</div>
						)}
					</div>
				)}
				{/* composer 是创建页的永久锚点(opendesign 铁律):任何 chip
				 * 选中态下输入框都保持可见可用——template chip 选中时模板 rail
				 * 在 composer 下方展开(见 form 之后的 TemplateRail),输入框
				 * 不再被替换/卸载,草稿跨 chip 切换存活。 */}
				{/* Start-from picker (open-design StartFromPicker): which shape
				 *  this creation begins from. Sits directly above the input —
				 *  it is a decision made before writing, so it belongs with the
				 *  input rather than up among the type chips, where it read as a
				 *  layer squeezed between two chip rows. Hidden unless the
				 *  design mode is armed; choosing nothing is a decision too, and
				 *  that is the blank option inside this radio group. */}
				{designActive && rpc && railState ? (
					<div className="w-full px-0.5 pb-2">
						<StartFromPicker
							rpc={rpc}
							value={startFrom}
							onChange={setStartFrom}
							tab={templateTabForChip(railState.chip)}
						/>
					</div>
				) : null}
				<form ref={formRef} className="gui-welcome-form relative w-full" onSubmit={submit}>
					<ComposerFrame
						className="gui-welcome-input"
						hero
						heroActive={beamOn}
						chatInput
						onEditTextAttachment={onEditPaste}
						pet={
							pet.enabled && pet.mode === "input"
								? ({ hovered, hopping }) => (
										<CompanionArt
											mood={hopping ? "dragging" : hovered ? "hover" : "rest"}
											art={pet.art}
											size={34}
											gloss={pet.decor.gloss}
											accessory={pet.decor.accessory}
										/>
									)
								: null
						}
						attachments={attachments}
						aboveRow={
							<>
								{/* conversation.input.dock 座位槽：输入卡上方整行（队列/待办）。 */}
								<SlotComponentHost rpc={rpc} slot={COMPOSER_INPUT_DOCK_SLOT} cwd={project ?? undefined} />
								{connectorServers.length > 0 ? (
									<div className="gui-composer-above">
										<div className="gui-composer-dock">
											<ConnectorChip
												open={connectorsOpen}
												onToggle={() => setConnectorsOpen(v => !v)}
												anchorRef={connectorsAnchorRef}
												serverCount={connectorServers.length}
												chosenCount={connectorChosen}
												menu={renderConnectorsMenu(
													<ConnectorPanel
														snapshot={connectorSnapshot}
														loadFailed={connectorsLoadFailed}
														onToggleServer={name =>
															connectorSnapshot &&
															setConnectorSelection(nextSelection(connectorSnapshot, name))
														}
														onToggleServers={names =>
															setConnectorSelection(
																names.length === connectorSnapshot?.servers.length ? null : names,
															)
														}
														onSelectAll={() => setConnectorSelection([])}
														onUseAll={() => setConnectorSelection(null)}
													/>,
												)}
											/>
										</div>
									</div>
								) : null}
							</>
						}
						{...attachmentChipActions({
							attachments,
							setAttachments,
							setText,
							editorRef: taRef,
							setSketch,
							openAddMenu: () => openAttachMenu.current?.(),
						})}
						footerLeft={
							<>
								<AttachMenu
									onReady={open => {
										openAttachMenu.current = open;
									}}
									goalMode={goalArmed}
									planMode={planArmed}
									guidedMode={guidedArmed}
									// Welcome toggles ARM the mode chip only — no popup
									// dialog, no session creation (the input keeps its
									// shape). The first sent message applies the mode
									// to the session it creates.
									onToggleGoal={() => setGoalArmed(v => !v)}
									onTogglePlan={() => setPlanArmed(v => !v)}
									// Guided goal needs a live session (the interview runs
									// Guided goal is ARMED here, not started: the row used to create
									// a session and fire the hidden interview kickoff immediately,
									// which read as "click = a message I did not write". The user
									// writes the objective and sends; that first prompt carries
									// guidedGoal so the daemon opens the interview from it.
									onGuidedGoal={() => {
										sfxFor("first");
										setGuidedArmed(true);
										setGoalArmed(false);
										setPlanArmed(false);
										requestAnimationFrame(() => taRef.current?.focus());
									}}
									onPickImages={files => void addFiles(files)}
									// Same entry set as the session composer: the empty
									// state is not a reduced product. File chips wait in
									// state until the session this prompt creates exists.
									onPickFiles={files => void addFiles(files)}
									onSketch={() => setSketch({ open: true, editId: null, initial: null, scene: null })}
									onCaptureScreen={openCapture}
									// Welcome = no session workspace: without rpc/cwd the
									//「＋」sub-pickers stay hidden (M2-2.6 spec), so only
									// the focus hand-back is wired here.
									onFocusComposer={() => taRef.current?.focus()}
									onInsert={token => insertComposerToken(taRef.current, token, setText)}
								/>
								{/* Focus mode sits between the attach menu and the model
								 * selector — between the attach menu and the model selector. */}
								{onToggleFocus && <FocusButton focused={focused ?? false} onPress={onToggleFocus} />}
								<ModelThinkingCapsule
									rpc={rpc}
									sessionId={null}
									presetModelId={presetModelId ?? modelId}
									thinkingLevel={thinking}
									thinkingEfforts={thinkingEfforts}
									allowSetDefault
									onAddProvider={onAddProvider}
									onModelSelect={(v, provider) => {
										modelTouched.current = true;
										// Provider/id composite, never the bare id: two
										// providers serve the same id (opencode-go vs
										// opencode-zen deepseek-v4-flash), and a bare id
										// reaching session.create's modelPattern would let
										// daemon-side preference ranking pick the wrong
										// provider (or silently fall back to DEFAULT on a
										// resolution miss).
										setModelId(provider ? `${provider}/${v}` : v);
									}}
									onSetThinking={v => {
										thinkingTouched.current = true;
										setThinking(v);
									}}
								/>
								{/* Design style select (M3.7b §3, WorkBuddy footer-pill
								 * parity): the pick lands in the creation draft
								 * (designSystemId → projectMetadata), same source as
								 * the preview rail below the composer. */}
								{isDesignArmed && (
									<DesignStyleSelect systems={designSystems} selected={designStyle} onPick={pickDesignStyle} />
								)}
								{/* Armed mode chips (plan/goal): shown IN the button row
								 * right of the thinking selector so the armed state is
								 * visible without opening the attach menu. */}
								{goalArmed && (
									<button
										type="button"
										className="gui-mode-chip gui-mode-chip--armed"
										title={t("general.nextMessageBecomesGoal")}
										onClick={() => setGoalArmed(false)}
									>
										<Icon name="target" className="h-3 w-3" />
										<span>{t("general.goal")}</span>
									</button>
								)}
								{planArmed && (
									<button
										type="button"
										className="gui-mode-chip gui-mode-chip--armed"
										title={t("general.planMode")}
										onClick={() => setPlanArmed(false)}
									>
										<Icon name="compass-3" className="h-3 w-3" />
										<span>{t("tools.plan")}</span>
									</button>
								)}
								{guidedArmed && (
									<button
										type="button"
										className="gui-mode-chip gui-mode-chip--armed"
										title={t("general.guidedGoalModeHint")}
										onClick={() => setGuidedArmed(false)}
									>
										<Icon name="chat-1" className="h-3 w-3" />
										<span>{t("general.guidedGoalMode")}</span>
									</button>
								)}
							</>
						}
						footerRight={
							<>
								{/* Approval mode — a global setting, so it works session-less. */}
								<ApprovalModeButton rpc={rpc} />
								{/* Mic: a state icon only. The clock, the level and the phase
								 * all live in the in-input dictation strip. */}
								<VoiceButton
									state={dictation.phase}
									disabled={!sttEnabled}
									onToggle={() => void voiceSetup.onToggle()}
								/>
								<button
									type="submit"
									ref={quotaAnchorRef}
									className="gui-send-btn"
									disabled={!canSend}
									aria-label={t("settings.sendMessage")}
								>
									<Icon name="send-plane" className="h-3.5 w-3.5" />
								</button>
							</>
						}
					>
						<VoiceOverlays dictation={dictation} dialog={voiceSetup.dialog} />
						<div className="gui-welcome-ta-wrap flex items-start gap-1.5">
							{quotes.length > 0 && (
								<div className="gui-welcome-quotes">
									<QuoteCards
										contexts={quotes}
										onRemove={index => setQuotes(current => current.filter((_, i) => i !== index))}
										onChange={(index, context) =>
											setQuotes(current => current.map((item, i) => (i === index ? context : item)))
										}
									/>
								</div>
							)}
							{renderCompMenu(
								<CompletionMenus
									slashOpen={slashOpen}
									slashItems={slashFilter}
									slashIdx={slashIdx}
									onPickSlash={insertSlash}
									atOpen={atOpen}
									atEntries={atFilter}
									atIdx={atIdx}
									atQuery={atQuery}
									onPickAt={insertAt}
								/>,
							)}

							{editingPaste && (
								<LongPasteDialog
									lineCount={editingPaste.text.split(String.fromCharCode(10)).length}
									charCount={editingPaste.text.length}
									text={editingPaste.text}
									onSave={text => {
										saveEditedPaste({ id: editingPaste.id, text, attachments, setAttachments, rpc });
										setEditingPaste(null);
									}}
									onDismiss={() => setEditingPaste(null)}
								/>
							)}
							<ComposerEditorStack
								editorRef={el => {
									taRef.current = el;
									compAnchorRef(el?.dom ?? null);
								}}
								value={text}
								variant="welcome"
								className="gui-composer-editor gui-composer-editor--welcome"
								focused={focused}
								autoFocus
								onPaste={intake.onPaste}
								onDragOver={intake.onDragOver}
								onDrop={intake.onDrop}
								onChange={intake.onChange}
								onKeyDown={e => {
									// IME composition: the confirming Enter commits the
									// candidate text — never submit while composing.
									if (e.isComposing || e.keyCode === 229) return;
									// Attachment keyboard flow (WeChat parity): Backspace/
									// Delete on an empty input removes the last image chip;
									// a select-all delete empties attachments too.
									if (e.key === "Backspace" || e.key === "Delete") {
										const ta = taRef.current;
										if (ta) {
											// Mention tokens are atoms: one key removes the whole
											// `@图片N` (and its trailing space); unresolved
											// `@名字` stays prose.
											if (ta.selectionStart === ta.selectionEnd) {
												const live = (name: string): boolean =>
													resolveMentionChip(name, attachments) !== null;
												const edit =
													e.key === "Backspace"
														? deleteMentionTokenBefore(ta.value, ta.selectionStart, live)
														: deleteMentionTokenAfter(ta.value, ta.selectionStart, live);
												if (edit) {
													e.preventDefault();
													setText(edit.next);
													const caret = edit.caret;
													requestAnimationFrame(() => taRef.current?.setSelectionRange(caret, caret));
													return;
												}
											}
											if (ta.value.length === 0 && attachments.length > 0) {
												e.preventDefault();
												setAttachments(prev => prev.slice(0, -1));
												return;
											}
											if (
												ta.selectionStart === 0 &&
												ta.selectionEnd === ta.value.length &&
												ta.value.length > 0
											) {
												clearAllRef.current = true;
											}
										}
									}
									const menus: {
										open: boolean;
										list: unknown[];
										idx: number;
										setIdx: (n: number) => void;
										insert: () => void;
									}[] = [
										{
											open: slashOpen,
											list: slashFilter,
											idx: slashIdx,
											setIdx: setSlashIdx,
											insert: () => slashFilter[slashIdx] && insertSlash(slashFilter[slashIdx]!.name),
										},
										{
											open: atOpen,
											list: atFilter,
											idx: atIdx,
											setIdx: setAtIdx,
											insert: () => atFilter[atIdx] && insertAt(atFilter[atIdx]!),
										},
									];
									for (const m of menus) {
										if (!m.open || m.list.length === 0) continue;
										if (e.key === "ArrowDown") {
											e.preventDefault();
											m.setIdx((m.idx + 1) % m.list.length);
											return;
										}
										if (e.key === "ArrowUp") {
											e.preventDefault();
											m.setIdx((m.idx - 1 + m.list.length) % m.list.length);
											return;
										}
										if (e.key === "Enter" || e.key === "Tab") {
											e.preventDefault();
											m.insert();
											return;
										}
										if (e.key === "Escape") {
											e.preventDefault();
											setSlashOpen(false);
											setAtOpen(false);
											return;
										}
									}
									if (e.key === "Enter" && !e.shiftKey) {
										e.preventDefault();
										submit(e as unknown as FormEvent<HTMLFormElement>);
									}
								}}
								placeholder={
									// Dictating means "speak": the state line says so, and a
									// "what you could type" hint under it competes with it.
									dictation.phase !== "idle"
										? ""
										: (placeholder ??
											composerPlaceholder({
												surface: "welcome",
												working: busy === true,
												attachmentCount: attachments.length,
												designPlaceholder:
													designActive && railState?.placeholder
														? railState.placeholder
														: isDesignArmed
															? t("composer.designEmptyPlaceholder")
															: null,
											}))
								}
								spellCheck={(() => {
									try {
										return localStorage.getItem("musepi-gui-chat-spellcheck") === "1";
									} catch {
										return false;
									}
								})()}
								marks={marks}
								resolveMention={resolveMention}
								onMentionClick={intake.onMentionClick}
							/>
						</div>
					</ComposerFrame>
				</form>
				{/* 模板 rail（template chip 的内容区，§3.4 机制不变）：composer
				 * 下方、设计体系 rail 上方内联展开（与 DesignSystemRail 同层
				 * 同构）。opendesign 铁律——composer 是创建页永久锚点，选中
				 * template chip 只展开本 rail，输入框纹丝不动；展开把下方内容
				 * 下推，不做位移动画。进出场走 Reveal（高度 240ms + 淡出 160ms
				 * + 内层位移，gui-creation-reveal），gui-motion-off /
				 * prefers-reduced-motion 归零；节点常驻，草稿不因切换丢失。 */}
				<Reveal open={designTemplate} className="gui-creation-reveal w-full">
					<TemplateRail
						rpc={rpc}
						active={designTemplate}
						// 点模板行 = 带模板快照建会话（createFromTemplate 语义不变）；
						// 设计体系轴（M3.7b §3）与 chip 排发送同源：选中体系的 id 在这里
						// 落进 projectMetadata，未选中不覆盖快照里的键。
						onCreate={metadata => {
							const withDesign = designStyle ? { ...metadata, designSystemId: designStyle } : metadata;
							return designSubmit ? designSubmit(withDesign) : Promise.resolve(false);
						}}
						// 创建成功 → mode chip 复位 work（与原 createFromTemplate 的
						// onClose 收尾一致）。
						onCreated={() => onModeChange?.("work")}
						onBusyChange={setTemplateBusy}
						// 「空白起步」等价路径：聚焦 composer，直接输入发送即可建会话。
						onBlankStart={() => taRef.current?.focus()}
					/>
				</Reveal>
				{/* 设计体系预览 rail（M3.7b §3.3）：design armed 时落在 composer
				 * 下方——120×72 色卡+名称卡横排，选中与风格胶囊同源 state；
				 * 左右边缘羽化与入场 stagger 见 design-system-rail.tsx。 */}
				{isDesignArmed && (
					<DesignSystemRail systems={designSystems} selected={designStyle} onPick={pickDesignStyle} />
				)}
				{/* 素材策略行 + 「高级 ▸」折叠区（M3.7c §4）的 portal 插槽：composer
				 *  下方、设计体系 rail 之下（§2.2 信息架构最底行）。空容器，内容由
				 *  CreationModeRow 经 portal 渲染（草稿单一所有权在 chip 排侧）。 */}
				{designActive && (
					<div ref={setAssetSlot} className="gui-creation-assetslot w-full" data-testid="gui-creation-assetslot" />
				)}
				{/* Static tip; t() runs at render time so locale switches land immediately. */}
				<p key={tipKey} className="gui-tip mt-5 text-[14px] text-[var(--color-text-faint)]">
					{t(tipKey).replace("{mod}", modLabel()).replace("⌘", modLabel())}
				</p>
				{/* Suggestion chips: one tap
				 * fills the composer; the user hits Enter to send. */}
				<HeightMorph
					morphKey={`${showMore ? "open" : "closed"}:${suggestions.length}`}
					className="gui-suggest-reveal mt-4"
					fade={false}
				>
					<div className="gui-suggest">
						{visibleSuggestions.map((s, i) => {
							const r = resolveSuggestion(s);
							const extra = i >= SUGGESTIONS_COLLAPSED_COUNT;
							const chipCls = extra
								? `gui-suggest-chip${collapsing ? " gui-suggest-chip--leaving" : " gui-suggest-chip--expand"}`
								: "gui-suggest-chip";
							return (
								<button
									key={`${i}-${r.label}`}
									type="button"
									className={chipCls}
									style={
										extra && !collapsing
											? ({
													animationDelay: `${(i - SUGGESTIONS_COLLAPSED_COUNT) * 40}ms`,
												} as CSSProperties)
											: undefined
									}
									onClick={() => applySuggestion(r.prompt)}
								>
									<span>{r.label}</span>
								</button>
							);
						})}
						{/* conversation.hero.options 座位槽：快捷选项行追加的 list 席位。 */}
						<SlotComponentHost rpc={rpc} slot={HERO_OPTIONS_SLOT} cwd={project ?? undefined} />
						{showMore && (
							<button
								type="button"
								className={`gui-suggest-chip gui-suggest-chip--manage${collapsing ? " gui-suggest-chip--leaving" : " gui-suggest-chip--expand"}`}
								style={{ animationDelay: "60ms" }}
								onClick={() =>
									window.dispatchEvent(
										new CustomEvent("musepi-gui-open-settings-section", { detail: "suggestions" }),
									)
								}
							>
								<span>{t("general.customSupplement")}</span>
							</button>
						)}
						<button
							type="button"
							className="gui-suggest-chip gui-suggest-chip--more"
							title={showMore ? t("general.collapseSuggestions") : t("general.moreSuggestions")}
							aria-label={showMore ? t("general.collapseSuggestions") : t("general.moreSuggestions")}
							onClick={showMore ? collapseSuggestions : expandSuggestions}
						>
							<MorphIcon icon={showMore ? XIcon : PlusIcon} size={13} spring="snappy" />
						</button>
					</div>
				</HeightMorph>
				{/* Real-time reminders (kimi 实时提醒 parity): background-working
				 * sessions (进行中) + completed-but-unread ones below the empty
				 * composer; click opens the session, 一键已读 clears unread. */}
				{reminders && reminders.length > 0 && (
					<RemindersPanel
						reminders={reminders}
						onSelect={onSelectReminder ?? (() => {})}
						onMarkAllRead={onMarkAllRead ?? (() => {})}
					/>
				)}
			</div>
		</>
	);
	return (
		/* Scene content only — the surrounding rounded surface belongs to
		 * ChatView, which renders both the welcome and in-session scenes
		 * inside one container. Focus mode (⌘⇧E) expands the composer to
		 * fill the surface: brand/greeting/tips hide
		 * and the input grows. */
		<>
			{renderQuotaMenu(
				<div className="gui-quota-panel" role="dialog" aria-label={t("general.subscriptionUsage")}>
					<button
						type="button"
						className="gui-quota-close"
						onClick={() => {
							setUsagePanel(s => ({ ...s, open: false }));
							setContextNote(false);
						}}
						aria-label={t("settings.close")}
					>
						<Icon name="close" className="h-3.5 w-3.5" />
					</button>
					{contextNote ? (
						<>
							<div className="gui-quota-title">{t("general.contextUsage")}</div>
							<div className="gui-quota-note">{t("general.contextUsageUnavailable")}</div>
						</>
					) : usagePanel.loading ? (
						<>
							<div className="gui-quota-title">{t("general.subscriptionUsage")}</div>
							<div className="gui-quota-note">…</div>
						</>
					) : usagePanel.data &&
						(usagePanel.data.reports.length > 0 ||
							usagePanel.data.unreportedAccounts.length > 0 ||
							usagePanel.data.disabledCredentials.length > 0 ||
							usagePanel.data.reloginDeadlines.length > 0) ? (
						<>
							<div className="gui-quota-title">
								{t("general.subscriptionUsage")}
								{usagePanel.data.fetchedAt
									? ` · ${t("general.usageAgoWithTime", { time: fmtQuotaDuration(Date.now() - usagePanel.data.fetchedAt) })}`
									: null}
							</div>
							<div className="gui-usage-reports">
								{(() => {
									const data = usagePanel.data!;
									const providers = [
										...new Set([
											...data.reports.map(report => report.provider),
											...data.unreportedAccounts.map(account => account.provider),
											...data.disabledCredentials.map(credential => credential.provider),
											...data.reloginDeadlines.map(deadline => deadline.provider),
										]),
									];
									return providers.map(provider => {
										const reports = data.reports.filter(report => report.provider === provider);
										return (
											<Fragment key={provider}>
												{reports.length > 0 && (
													<UsageProviderSection reports={reports} activeAccount={data.activeAccount} />
												)}
												<UsageGapLines provider={provider} data={data} />
											</Fragment>
										);
									});
								})()}
							</div>
						</>
					) : (
						<>
							<div className="gui-quota-title">{t("general.subscriptionUsage")}</div>
							<div className="gui-quota-note">{t("general.noSubscriptionUsageReported")}</div>
						</>
					)}
				</div>,
			)}
			<div
				className="gui-welcome relative flex h-full flex-1 flex-col items-center justify-center overflow-hidden px-8"
				data-focused={focused ? "1" : undefined}
			>
				<SlotComponentHost
					rpc={rpc}
					slot={HERO_FRAME_SLOT}
					cwd={project ?? undefined}
					fallback={
						<>
							<WelcomeBackdrop />
							{heroBody}
						</>
					}
				>
					{heroBody}
				</SlotComponentHost>
			</div>
			{sketch.open && (
				<SketchPad
					initialImage={sketch.initial}
					initialScene={sketch.scene}
					onClose={() => setSketch({ open: false, editId: null, initial: null, scene: null })}
					onDone={onSketchDone}
				/>
			)}
			<ScreenshotEditorDialog
				open={shotSrc !== null}
				src={shotSrc}
				onConfirm={dataUrl => {
					setShotSrc(null);
					void addFiles([dataUrlToFile(dataUrl, "screenshot.png")]);
				}}
				onCancel={() => setShotSrc(null)}
			/>
		</>
	);
}
