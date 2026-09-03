import { t } from "@musepi/desktop-web";
import { Plus as PlusIcon, X as XIcon } from "lucide";
import { X } from "lucide-react";
import { MorphIcon } from "morphicons/react";
import type { CSSProperties, FormEvent, ReactNode } from "react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ComposerFrame } from "../lib/composer-frame";
import { isContextCommand } from "../lib/context-command";
import { projectName } from "../lib/electron";
import { readAutoResizeImages, readFileAsDataURL, resizeImageDataUrl } from "../lib/image-resize";
import { dispatchNotification } from "../lib/notify";
import type { RpcClient } from "../lib/rpc";
import { sfxFor } from "../lib/sfx";
import { modLabel } from "../lib/shortcuts";
import { rankSlashEntries } from "../lib/slash-rank";
import {
	loadSuggestions,
	resolveSuggestion,
	type StoredSuggestion,
	SUGGESTIONS_CHANGED_EVENT,
	SUGGESTIONS_COLLAPSED_COUNT,
} from "../lib/suggestions";
import { isUsageCommand } from "../lib/usage-command";
import { useFloatingMenu } from "../lib/use-floating-menu";
import { evaluateSubmitTrigger, type SttSubmitTrigger, startDictation } from "../lib/voice";
import { Icon } from "../vendor/oc-icons";
import { AttachMenu } from "./AttachMenu";
import { BlurText } from "./BlurText";
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
} from "./Composer";
import { VoiceButton } from "./composer/action-buttons";
import { LongPasteDialog } from "./composer/long-paste-dialog";
import { isLongPastedText, useLongTextPaste } from "./composer/use-long-text-paste";
import { autosize } from "./composer-autosize";
import { DotMatrixMark } from "./DotMatrixMark";
import { ModelThinkingCapsule } from "./ModelThinkingCapsule";
import { PetSprite, usePet } from "./PetSprite";
import { type ReminderRow, RemindersPanel } from "./RemindersPanel";
import { type SlashEntry, SlashRow } from "./SlashRow";
import type { ThinkingLevel } from "./ThinkingSelector";

/** Time-aware greeting (ZCode-style): seven brackets — 清晨 / 早上 / 中午 /
 * 下午 / 晚上 / 深夜. Each bracket carries its own tone so the welcome
 * reads less canned. */
function greeting(hour: number): string {
	if (hour < 5) return t("it is late, take care");
	if (hour < 8) return t("early morning");
	if (hour < 12) return t("good morning");
	if (hour < 14) return t("good noon");
	if (hour < 18) return t("good afternoon");
	if (hour < 22) return t("good evening");
	return t("it is late, take care");
}

/** Rotating tips shown under the composer (splash/shimmer refresh). Keys are
 * translated at render time (t is locale-aware), so a locale switch updates
 * the tip line without a reload. */
// English keys double as the en-US fallback (the i18n map only carries
// zh-CN); zh translations live in desktop-web/src/i18n/zh-CN.ts.
const TIP_KEYS = [
	"try / for commands and @ for context",
	"press {mod}N to start a new session",
	"ask the agent to explain a file with @",
	"approval cards appear when a tool needs your ok",
	"dictate with the mic button in the composer",
	"annotate images before sending them",
	"schedule idle-window tasks from the task center",
	"type /autoresearch to run experiments",
	"favorite models pin to the top of the model picker",
	"plan mode makes the agent outline before editing",
	"goal mode turns your next message into a goal",
	"paused sessions survive daemon restarts",
	"pick a preset mode for the new session",
	"customize the scrollbar skin in appearance settings",
] as const;

/** Pick a random tip key, avoiding the current one. */
function nextTip(current: (typeof TIP_KEYS)[number]): (typeof TIP_KEYS)[number] {
	const pool = TIP_KEYS.filter(x => x !== current);
	return pool[Math.floor(Math.random() * pool.length)] ?? TIP_KEYS[0]!;
}

/**
 * Empty-state composer (opencode/ZCode style): large centered input with a
 * border-beam accent, a faint brand watermark, a time-aware greeting, and a
 * rotating tip line that refreshes with a shimmer.
 */
export function WelcomeComposer({
	onSubmit,
	busy,
	rpc,
	project,
	onProject,
	focused,
	onToggleFocus,
	presetModelId,
	presetThinkingLevel,
	reminders,
	onSelectReminder,
	onMarkAllRead,
	/** 预设(mode)chip(项目行旁,DSH hero 对齐):欢迎页选择,新会话创建时应用。 */
	modes,
	modeId,
	onModeChange,
}: {
	/** First prompt; the model/thinking choices made in the composer are
	 *  carried along so the new session starts with them. planMode/goalMode
	 *  ride along when the corresponding mode chip is armed — the mode is
	 *  applied to the session this first prompt creates (goal: the prompt
	 *  text becomes the objective, openchamber parity). */
	onSubmit(
		text: string,
		opts?: {
			thinkingLevel?: ThinkingLevel | null;
			modelId?: string | null;
			images?: { type: "image"; data: string; mimeType: string }[];
			planMode?: boolean;
			goalMode?: boolean;
		},
	): Promise<void> | void;
	busy?: boolean;
	/** Daemon client for the session-less model catalog (preselect). */
	rpc: RpcClient;
	/** Current project (workspace folder), if any. */
	project?: string | null;
	/** 打开文件夹 / 远程连接 / 不在项目中 project actions. */
	/** 打开文件夹 / 远程连接 / 不在项目中 project actions, or an already
	 *  saved workspace path (picked from the saved-workspaces list). */
	onProject?(action: "folder" | "remote" | "none" | string): void;
	/** Focus mode (openchamber ⌘⇧E): the composer fills the surface. */
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
	modes?: { id: string; label: string }[] | null;
	modeId?: string | null;
	onModeChange?(id: string | null): void;
}): ReactNode {
	const pet = usePet();
	const [text, setText] = useState("");
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
	// Global selection append (Cmd/Ctrl+L, openchamber parity): any
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
	// Cmd/Ctrl+L quote cards (same style as the session Composer): quoted
	// selections render as cards above the input and are sent as `> …`
	// markdown in front of the prompt.
	const [quotes, setQuotes] = useState<string[]>([]);
	useEffect(() => {
		const onQuoteAppend = (e: Event): void => {
			const detail = (e as CustomEvent<{ text?: string }>).detail;
			const text = detail?.text;
			if (!text) return;
			setQuotes(q => (q.includes(text) ? q : [...q, text]));
			requestAnimationFrame(() => autosize(taRef.current));
			requestAnimationFrame(() => taRef.current?.focus());
		};
		window.addEventListener("musepi-gui-quote-append", onQuoteAppend);
		return () => window.removeEventListener("musepi-gui-quote-append", onQuoteAppend);
	}, []);
	const { pending: pendingPaste, requestPaste: requestLongPaste, dismiss: dismissLongPaste } = useLongTextPaste();
	const [attachments, setAttachments] = useState<{ id: number; dataUrl: string; mimeType: string; name: string }[]>(
		[],
	);
	// Armed plan/goal (openchamber parity): one tap arms the mode chip —
	// NO popup dialog and NO session creation, so the welcome input keeps
	// its shape. The first sent message applies the mode (goal: the
	// message text becomes the objective; plan: session opens in plan
	// mode). A second tap disarms.
	const [planArmed, setPlanArmed] = useState(false);
	const [goalArmed, setGoalArmed] = useState(false);
	const attachId = useRef(0);

	// Voice dictation (session-composer parity): the welcome composer's tips
	// advertise the mic button, so the empty state must actually ship one.
	// Local STT via the daemon (sherpa-ONNX) — same startDictation the session
	// composer uses; `rpc` is session-less so transcribe works pre-session.
	const [dictating, setDictating] = useState(false);
	const [transcribing, setTranscribing] = useState(false);
	const [voiceSeconds, setVoiceSeconds] = useState(0);
	const [voiceLevel, setVoiceLevel] = useState(0);
	const stopDict = useRef<(() => void) | null>(null);
	// Dictation submit trigger (settings.stt.submitTrigger, TUI parity): whether
	// finishing a dictation auto-sends the transcript instead of filling the draft.
	const [sttSubmitTrigger, setSttSubmitTrigger] = useState<SttSubmitTrigger>("never");
	useEffect(() => {
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
	// Thinking preselect: the boot snapshot (modelRoles.default suffix →
	// defaultThinkingLevel) may arrive after first paint — apply it until the
	// user touches the selector. undefined = no snapshot yet.
	const thinkingTouched = useRef(false);
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
	const effectiveModelId = presetModelId ?? modelId;
	useEffect(() => {
		if (!rpc || !effectiveModelId) {
			setThinkingEfforts(null);
			return;
		}
		let cancelled = false;
		void rpc
			.request<{ efforts?: string[] } | null>("models.detail", { id: effectiveModelId })
			.then(detail => {
				if (cancelled) return;
				// null = id not resolved (e.g. provider-qualified selector the
				// daemon couldn't match) → full ladder; a resolved model with
				// empty efforts genuinely has no controllable surface → off+auto.
				setThinkingEfforts(detail === null ? null : detail.efforts?.length ? detail.efforts : []);
			})
			.catch(() => {
				if (!cancelled) setThinkingEfforts(null);
			});
		return () => {
			cancelled = true;
		};
	}, [rpc, effectiveModelId]);
	const [tipKey, setTipKey] = useState<(typeof TIP_KEYS)[number]>(
		() => TIP_KEYS[Math.floor(Math.random() * TIP_KEYS.length)]!,
	);
	// Git branch selector (openchamber new-session parity): current branch +
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
	// Draft suggestions (openchamber DraftPresetChips parity): user-curated
	// via 设置 → 预设提示词 (lib/suggestions — localStorage + change event);
	// builtins fall back to the i18n-keyed defaults. Collapsed shows the
	// first 8 chips; + expands with a staggered blur-in and morphs into ✕;
	// a 自定义补充 chip jumps to the settings section.
	const [suggestions, setSuggestions] = useState<StoredSuggestion[]>(() => loadSuggestions());
	// Active preset mode: the welcome default is always a real mode ("work",
	// DSH parity) — there is no "no preset" state anymore, so null never
	// reaches the UI (chip label / active check / session create all use
	// this normalized id).
	const activeModeId = modeId ?? "work";
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
	// Incremental expansion (增量展开): chips join one per stage and the
	// container height follows each stage (dynamic stretch — no abrupt
	// jump). revealCount runs COLLAPSED..suggestions.length+1; the +1 is
	// the 自定义补充 chip, revealed last.
	const [revealCount, setRevealCount] = useState(SUGGESTIONS_COLLAPSED_COUNT);
	const [collapsing, setCollapsing] = useState(false);
	const revealTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const suggestRevealRef = useRef<HTMLDivElement | null>(null);
	useEffect(
		() => () => {
			if (revealTimerRef.current) clearInterval(revealTimerRef.current);
		},
		[],
	);
	const expandSuggestions = (): void => {
		if (showMore || collapsing) return;
		setShowMore(true);
		revealTimerRef.current = setInterval(() => {
			setRevealCount(c => {
				const next = c + 1;
				// Stop WITHOUT advancing past the last chip: a final
				// revealCount bump past length+1 renders one more frame
				// whose delta<1 effect skips the settle timer, leaving the
				// reveal height pinned (overflow:hidden + fixed px) — the
				// collapse then computes scrollHeight = max(clientHeight,
				// content) and never shrinks back.
				if (next > suggestions.length + 1) {
					if (revealTimerRef.current) clearInterval(revealTimerRef.current);
					revealTimerRef.current = null;
					return c;
				}
				return next;
			});
		}, 90);
	};
	const collapseSuggestions = (): void => {
		if (!showMore || collapsing) return;
		setCollapsing(true);
		if (revealTimerRef.current) {
			clearInterval(revealTimerRef.current);
			revealTimerRef.current = null;
		}
		window.setTimeout(() => {
			// Pin the CURRENT (expanded) height BEFORE the extra chips
			// unmount: the setState below is batched to the end of this
			// callback, so the pin is in place when they drop. The layout
			// effect then eases from this pinned height to the collapsed
			// natural height (no snap). Doing it the other way round — reset
			// height first, then let the chips unmount — skipped the height
			// transition entirely (delta < 1) and the container collapsed
			// with a visible jump.
			const node = suggestRevealRef.current;
			if (node) {
				node.style.transition = "none";
				node.style.height = `${node.getBoundingClientRect().height}px`;
				node.style.overflow = "hidden";
				void node.offsetHeight;
			}
			setCollapsing(false);
			setShowMore(false);
			setRevealCount(SUGGESTIONS_COLLAPSED_COUNT);
		}, 150);
	};
	// Height follows each reveal stage: pin the current height, ease to the
	// new natural height, settle back to auto (HeightMorph mechanism, but
	// without its per-key fade restart — a full re-fade per 90ms stage
	// would strobe).
	useLayoutEffect(() => {
		const node = suggestRevealRef.current;
		if (!node) return;
		const current = node.getBoundingClientRect().height;
		// Measure the natural content height with any inline pin temporarily
		// lifted. `scrollHeight` is floored at `clientHeight`, so a pinned
		// container (collapse sets `height:<expanded>px` + overflow:hidden)
		// would read back the pinned value — delta < 1 — and never ease
		// down nor settle to auto, stranding the container at the expanded
		// height. Lift → measure → restore, then run the height tween.
		const prevHeight = node.style.height;
		const prevOverflow = node.style.overflow;
		node.style.height = "auto";
		node.style.overflow = "visible";
		const target = node.scrollHeight;
		node.style.height = prevHeight;
		node.style.overflow = prevOverflow;
		const delta = Math.abs(target - current);
		if (delta < 1) return;
		node.style.transition = "none";
		node.style.height = `${current}px`;
		node.style.overflow = "hidden";
		void node.offsetHeight;
		const duration = Math.min(480, Math.max(240, Math.round(delta / 6)));
		node.style.transition = `height ${duration}ms cubic-bezier(0.22, 1, 0.36, 1)`;
		node.style.height = `${target}px`;
		const settle = window.setTimeout(() => {
			node.style.height = "auto";
			node.style.overflow = "";
			node.style.transition = "";
		}, duration + 30);
		return () => window.clearTimeout(settle);
	}, [showMore, revealCount, collapsing]);
	// Chips shown: base 8 always; extras join as revealCount grows, and
	// stay mounted during the collapse fade-out.
	const extraShown = showMore || collapsing ? Math.max(0, revealCount - SUGGESTIONS_COLLAPSED_COUNT) : 0;
	const visibleSuggestions =
		showMore || collapsing
			? suggestions.slice(0, SUGGESTIONS_COLLAPSED_COUNT + extraShown)
			: suggestions.slice(0, SUGGESTIONS_COLLAPSED_COUNT);
	// Empty-state placeholder carousel (new-task 空态 hints).
	const PLACEHOLDER_TIPS = [
		"ask anything, / for commands, @ for context…",
		"welcome tip search web",
		"welcome tip voice input",
		"welcome tip task center",
		"welcome tip annotate image",
		"welcome tip autoresearch",
	] as const;
	// Empty-state placeholder rotates through capability hints (new-task
	// 空态): keep the base shortcut hint first, then surface the newer
	// features (web search / images / boards / diagrams) so the empty
	// composer teaches what the agent can do.
	const [tipIdx, setTipIdx] = useState(0);
	useEffect(() => {
		const id = setInterval(() => setTipIdx(i => (i + 1) % PLACEHOLDER_TIPS.length), 4000);
		return () => clearInterval(id);
	}, []);
	const applySuggestion = (prompt: string): void => {
		setText(prompt);
		requestAnimationFrame(() => autosize(taRef.current));
		requestAnimationFrame(() => taRef.current?.focus());
	};
	// Dot-matrix brand backdrop pref (设置 → 常规 toggle + custom text,
	// musepi-gui-dotmatrix / musepi-gui-dotmatrix-text).
	const [dotMatrixOn, setDotMatrixOn] = useState(() => localStorage.getItem("musepi-gui-dotmatrix") !== "0");
	const [dotMatrixText, setDotMatrixText] = useState(
		() => localStorage.getItem("musepi-gui-dotmatrix-text") ?? "MusePi",
	);
	useEffect(() => {
		const on = (): void => {
			setDotMatrixOn(localStorage.getItem("musepi-gui-dotmatrix") !== "0");
			setDotMatrixText(localStorage.getItem("musepi-gui-dotmatrix-text") || "MusePi");
		};
		window.addEventListener("musepi-dotmatrix-changed", on);
		window.addEventListener("storage", on);
		return () => {
			window.removeEventListener("musepi-dotmatrix-changed", on);
			window.removeEventListener("storage", on);
		};
	}, []);
	// / @ # completion (composer parity): slash commands, workspace files,
	// session references — floating preview menus while typing.
	const [slashOpen, setSlashOpen] = useState(false);
	const [slashQuery, setSlashQuery] = useState("");
	const [slashCmds, setSlashCmds] = useState<SlashEntry[] | null>(null);
	// Selection indexes must be STATE: arrow keys set them inside onKeyDown
	// and the active-row highlight depends on them — refs never re-render,
	// so the highlight only moved on unrelated renders (typing/streaming).
	const [slashIdx, setSlashIdx] = useState(0);
	const [atOpen, setAtOpen] = useState(false);
	const [atQuery, setAtQuery] = useState("");
	const [atEntries, setAtEntries] = useState<{ name: string; path: string; isDir: boolean; depth: number }[] | null>(
		null,
	);
	const [atIdx, setAtIdx] = useState(0);
	const [hashOpen, setHashOpen] = useState(false);
	const [hashQuery, setHashQuery] = useState("");
	const [hashSessions, setHashSessions] = useState<{ id: string; cwd?: string }[] | null>(null);
	const [hashLabels, setHashLabels] = useState<Map<string, string>>(new Map());
	const [hashIdx, setHashIdx] = useState(0);
	const slashFilter = (() => {
		const q = slashQuery.toLowerCase();
		// /skill, /skills, /skill: — surface every skill command (the
		// literal "skills" text never appears in skill:foo names).
		const isSkillQuery = q === "skill" || q === "skills" || q.startsWith("skill:");
		// Composer-intercepted slash commands (open GUI panels instead of
		// hitting the agent) — they win ties in the / completion ranking.
		const guiNative: ReadonlySet<string> = new Set(["usage"]);
		// GUI-native /usage (empty state — no session yet). The daemon's
		// catalog already carries the TUI usage entry; keep only the GUI one.
		const guiUsageCmd: SlashEntry = {
			name: "usage",
			description: t("show subscription usage"),
			kind: "command",
			category: "GUI",
		};
		const list = [...(slashCmds ?? []).filter(c => c.name !== "usage"), guiUsageCmd];
		// Ranked (slash-rank.ts): exact/prefix matches first, GUI-native
		// commands win ties — /usage opens the panel instead of hitting the
		// agent, so it belongs above look-alike daemon entries.
		return rankSlashEntries(
			list.filter(c =>
				isSkillQuery && c.kind === "skill"
					? true
					: c.name.includes(q) || (c.description ?? "").toLowerCase().includes(q),
			),
			q,
			guiNative,
		);
	})();
	const atFilter =
		atEntries?.filter(
			e =>
				e.name.toLowerCase().includes(atQuery.toLowerCase()) ||
				e.path.toLowerCase().includes(atQuery.toLowerCase()),
		) ?? [];
	// `#` completion filters the session list by query (id / label /
	// cwd) — same contract as the @ file completion below.
	const hashFilter = (hashSessions ?? []).filter(s => {
		const q = hashQuery.trim().toLowerCase();
		if (!q) return true;
		const label = hashLabels.get(s.id) ?? "";
		return (
			label.toLowerCase().includes(q) || s.id.toLowerCase().includes(q) || (s.cwd ?? "").toLowerCase().includes(q)
		);
	});
	const [projOpen, setProjOpen] = useState(false);
	const [presetOpen, setPresetOpen] = useState(false);
	// Saved workspaces (sidebar 项目 tab parity): every folder the app
	// knows (musepi-gui-projects localStorage — seeded from session cwds and
	// grown by folder picks), so the workspace picker lists them for
	// one-tap switching instead of only offering 打开文件夹/远程连接.
	const [savedProjects, setSavedProjects] = useState<string[]>(() => {
		try {
			const raw = localStorage.getItem("musepi-gui-projects");
			const parsed: unknown = raw ? JSON.parse(raw) : [];
			return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
		} catch {
			return [];
		}
	});
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
	// Focus-within state drives the hero beam (fades in while the composer
	// has focus, fades out on blur — no static border box).
	const [beamOn, setBeamOn] = useState(false);
	// Portaled workspace-picker popup (model/thinking selector parity): the
	// frosted glass samples real content behind it, and the exit animates.
	// Single-layer: className carries the visual (gui-proj-menu), the hook
	// provides portal + position + animation (Pop parity — no nested Pop).
	const { anchorRef: projAnchorRef, renderMenu: renderProjMenu } = useFloatingMenu(projOpen, setProjOpen, {
		className: "gui-proj-menu",
	});
	// 预设(mode)选择菜单:与项目选择同款浮层样式(DSH hero 对齐)。
	const { anchorRef: presetAnchorRef, renderMenu: renderPresetMenu } = useFloatingMenu(presetOpen, setPresetOpen, {
		className: "gui-proj-menu",
	});
	const { anchorRef: branchAnchorRef, renderMenu: renderBranchMenu } = useFloatingMenu(branchOpen, setBranchOpen, {
		className: "gui-proj-menu",
	});
	// / @ # completion preview (composer parity): one floating menu for all
	// three triggers, portaled so the glass samples real content behind it.
	const compOpen = slashOpen || atOpen || hashOpen;
	const { anchorRef: compAnchorRef, renderMenu: renderCompMenu } = useFloatingMenu(compOpen, open => {
		if (open) return;
		setSlashOpen(false);
		setAtOpen(false);
		setHashOpen(false);
	});
	// Only one completion menu is mounted at a time (conditional render), so
	// a single ref tracks whichever is open. The menu scrolls internally
	// (max-height 300px, overflow-y auto) — keep the active row in view
	// while arrow-navigating.
	const completionMenuRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const menu = completionMenuRef.current;
		if (!menu) return;
		const active = menu.querySelector(".gui-slash-row--active, .gui-model-opt--active");
		active?.scrollIntoView({ block: "nearest" });
	}, [slashIdx, atIdx, hashIdx, slashOpen, atOpen, hashOpen]);

	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const formRef = useRef<HTMLFormElement | null>(null);
	// Select-all + delete clears text AND attachments together (consumed
	// by onChange once the textarea reports the emptied value).
	const clearAllRef = useRef(false);
	const canSend = (text.trim().length > 0 || quotes.length > 0) && !busy;

	// Completion triggers (composer parity): line-leading / @ # open the
	// floating preview lists; Enter/click inserts the token.
	const onCompletionInput = (value: string): void => {
		const lineStart = value.lastIndexOf("\n") + 1;
		const line = value.slice(lineStart);
		if (line.startsWith("/") && line.length >= 1) {
			setSlashQuery(line.length > 1 ? line.slice(1) : "");
			setSlashOpen(true);
			setSlashIdx(0);
			if (!slashCmds && rpc) {
				void rpc
					.request<SlashEntry[]>("commands.list", {})
					.then(list => setSlashCmds(list ?? []))
					.catch(() => {});
			}
		} else {
			setSlashOpen(false);
		}
		if (line.startsWith("@") && line.length >= 1) {
			setAtQuery(line.length > 1 ? line.slice(1) : "");
			setAtOpen(true);
			setAtIdx(0);
			if (!atEntries && rpc) {
				void rpc
					.request<{
						entries: { name: string; path: string; isDir: boolean; size: number; mtime: number; depth: number }[];
					}>("workspace.tree", { cwd: project ?? "", maxDepth: 2, perDirLimit: 60 })
					.then(res => {
						const entries = (res?.entries ?? [])
							.filter(e => e.depth <= 2)
							.map(e => ({ name: e.name, path: e.path, isDir: e.isDir, depth: e.depth }));
						setAtEntries(entries);
					})
					.catch(() => setAtEntries([]));
			}
		} else {
			setAtOpen(false);
		}
		if (line.startsWith("#") && line.length >= 1) {
			setHashQuery(line.length > 1 ? line.slice(1) : "");
			setHashOpen(true);
			setHashIdx(0);
			if (!hashSessions && rpc) {
				void rpc
					.request<{ id: string; timestamp?: string; messageCount?: number; cwd?: string }[]>("session.list", {})
					.then(list => setHashSessions(list ?? []))
					.catch(() => setHashSessions([]));
				// Titles come from the session tree (renames/首条消息 labels).
				void rpc
					.request<{ entry: { id: string; label?: string }; children?: unknown[] }[]>("session.tree", {})
					.then(tree => {
						const labels = new Map<string, string>();
						const walk = (ns: { entry: { id: string; label?: string }; children?: unknown[] }[]): void => {
							for (const n of ns ?? []) {
								if (n.entry?.label) labels.set(n.entry.id, n.entry.label);
								walk((n.children as { entry: { id: string; label?: string }; children?: unknown[] }[]) ?? []);
							}
						};
						walk(tree ?? []);
						setHashLabels(labels);
					})
					.catch(() => {});
			}
		} else {
			setHashOpen(false);
		}
	};
	const insertCompletion = (type: "slash" | "at" | "hash", value: string): void => {
		const ta = taRef.current;
		if (!ta) return;
		const lineStart = ta.value.lastIndexOf("\n") + 1;
		const line = ta.value.slice(lineStart);
		const token = type === "slash" ? "/" : type === "at" ? "@" : "#";
		const qlen = line.startsWith(token) ? line.length - 1 : 0;
		const prefix = ta.value.slice(0, lineStart);
		const next = `${prefix}${token}${value} ${ta.value.slice(lineStart + qlen + 1)}`;
		setText(next);
		if (type === "slash") setSlashOpen(false);
		if (type === "at") setAtOpen(false);
		if (type === "hash") setHashOpen(false);
		requestAnimationFrame(() => autosize(taRef.current));
	};

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
	const prevSize = useRef<{ w: number; h: number } | null>(null);
	const formEl = formRef.current;
	if (formEl) {
		const r = formEl.getBoundingClientRect();
		prevSize.current = { w: r.width, h: r.height };
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
		form.style.height = `${fromH}px`;
		form.style.width = `${fromW}px`;
		void form.offsetHeight;
		form.classList.add("gui-morphing");
		const anim = form.animate(
			[
				{ height: `${fromH}px`, width: `${fromW}px` },
				{ height: `${targetH}px`, width: `${targetW}px` },
			],
			{ duration: 280, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
		);
		form.style.height = `${targetH}px`;
		form.style.width = `${targetW}px`;
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

	// Rotate the tip every ~6s with a shimmer refresh (key change re-triggers).
	useEffect(() => {
		let id = setInterval(() => setTipKey(prev => nextTip(prev)), 6000);
		const onVis = (): void => {
			clearInterval(id);
			if (document.visibilityState === "visible") id = setInterval(() => setTipKey(prev => nextTip(prev)), 6000);
		};
		document.addEventListener("visibilitychange", onVis);
		return () => {
			clearInterval(id);
			document.removeEventListener("visibilitychange", onVis);
		};
	}, []);

	const addImageFiles = async (files: File[]): Promise<void> => {
		const imgs = files.filter(f => f.type.startsWith("image/"));
		if (imgs.length === 0) return;
		// Front-resize large images (TUI parity, images.autoResize-governed).
		const autoResize = await readAutoResizeImages(rpc);
		const entries = await Promise.all(
			imgs.map(async f => {
				const dataUrl = await readFileAsDataURL(f);
				const resized = autoResize ? await resizeImageDataUrl(dataUrl, f.type) : null;
				return {
					id: attachId.current++,
					dataUrl: resized?.dataUrl ?? dataUrl,
					mimeType: resized?.mimeType ?? f.type,
					name: f.name,
				};
			}),
		);
		setAttachments(prev => [...prev, ...entries]);
	};

	// Send a trimmed prompt (shared by form submit and voice-dictation
	// auto-submit): carries the welcome preselects (model/thinking) and armed
	// modes into the session this first prompt creates.
	const sendText = (trimmed: string): void => {
		const quotePrefix =
			quotes.length > 0 ? `${quotes.map(q => `> ${q.split("\n").join("\n> ")}`).join("\n\n")}\n\n` : "";
		const payload = quotePrefix ? `${quotePrefix}${trimmed}`.trim() : trimmed;
		setText("");
		setQuotes([]);
		setAttachments([]);
		// Re-measure after the programmatic clear (onChange doesn't fire).
		requestAnimationFrame(() => autosize(taRef.current));
		sfxFor("first");
		// Armed modes apply to the session this first prompt creates; the
		// armed chips reset either way (goal needs text to be an objective).
		const applyGoal = goalArmed && trimmed.length > 0;
		setGoalArmed(false);
		setPlanArmed(false);
		void onSubmit(payload, {
			thinkingLevel: thinking,
			// modelId is the provider/id composite after a pick (setModelId above);
			// session.create forwards it as modelPattern, which resolves exactly
			// via the daemon's provider reference match — no bare-id ambiguity.
			modelId: modelTouched.current ? modelId : effectiveModelId,
			images: attachments.map(a => ({
				type: "image" as const,
				data: a.dataUrl.split(",")[1] ?? "",
				mimeType: a.mimeType,
			})),
			planMode: planArmed,
			goalMode: applyGoal,
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

	return (
		/* Scene content only — the surrounding rounded surface belongs to
		 * ChatView, which renders both the welcome and in-session scenes
		 * inside one container. Focus mode (⌘⇧E) expands the composer to
		 * fill the surface (openchamber parity): brand/greeting/tips hide
		 * and the input grows. */
		<>
			{renderQuotaMenu(
				<div className="gui-quota-panel" role="dialog" aria-label={t("subscription usage")}>
					<button
						type="button"
						className="gui-quota-close"
						onClick={() => {
							setUsagePanel(s => ({ ...s, open: false }));
							setContextNote(false);
						}}
						aria-label={t("close")}
					>
						<Icon name="close" className="h-3.5 w-3.5" />
					</button>
					{contextNote ? (
						<>
							<div className="gui-quota-title">{t("context usage")}</div>
							<div className="gui-quota-note">{t("context usage unavailable")}</div>
						</>
					) : usagePanel.loading ? (
						<>
							<div className="gui-quota-title">{t("subscription usage")}</div>
							<div className="gui-quota-note">…</div>
						</>
					) : usagePanel.data &&
						(usagePanel.data.reports.length > 0 ||
							usagePanel.data.unreportedAccounts.length > 0 ||
							usagePanel.data.disabledCredentials.length > 0 ||
							usagePanel.data.reloginDeadlines.length > 0) ? (
						<>
							<div className="gui-quota-title">
								{t("subscription usage")}
								{usagePanel.data.fetchedAt
									? ` · ${t("usage {time} ago", { time: fmtQuotaDuration(Date.now() - usagePanel.data.fetchedAt) })}`
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
							<div className="gui-quota-title">{t("subscription usage")}</div>
							<div className="gui-quota-note">{t("no subscription usage reported")}</div>
						</>
					)}
				</div>,
			)}
			<div
				className="gui-welcome gui-pane-glow relative flex h-full flex-1 flex-col items-center justify-center overflow-hidden px-8"
				data-focused={focused ? "1" : undefined}
			>
				{/* Interactive dot-matrix brand backdrop (kimi-style reference):
				 * "MusePi" rasterized into a breathing dot grid with colored
				 * accents, feather edge and click ripples; replaces the static
				 * π watermark. Toggle lives in 设置 → 常规 (musepi-gui-dotmatrix). */}
				{dotMatrixOn && <DotMatrixMark text={dotMatrixText || "MusePi"} className="gui-welcome-mark" />}
				<div className="gui-welcome-inner relative z-10 flex w-full max-w-[560px] flex-col items-center">
					{/* Workspace picker (openchamber/ZCode): dropdown list attached
					 * right above the input — current project, open folder, remote. */}
					<div className="gui-brand mb-2 flex items-center gap-2">
						<span className="gui-brand-mark">π</span>
						<BlurText text={t("MusePi")} className="text-[22px] font-bold" />
					</div>
					<p className="gui-welcome-greet pointer-events-none mb-4">
						<BlurText text={greeting(hour)} stepMs={38} />
					</p>
					{/* Project target — an independent row above the composer,
					 * left-aligned (openchamber DraftTargetSelectors). */}
					{onProject && (
						<div className="gui-project-row mb-2 flex w-full min-w-0 items-center gap-1.5 px-0.5">
							<div className="relative z-20" ref={projAnchorRef}>
								<button
									type="button"
									className="gui-project-chip"
									onClick={() => setProjOpen(v => !v)}
									aria-label={t("current project")}
								>
									<Icon name="folder" className="h-3.5 w-3.5" />
									<span className="max-w-[200px] truncate">
										{project ? projectName(project) : t("not in a project")}
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
												<span className="min-w-0 flex-1 truncate">{projectName(project)}</span>
												<Icon name="check" className="h-3 w-3 flex-shrink-0" />
											</button>
										)}
										{/* Saved workspaces (sidebar 项目 tab parity): every folder
										 * the app knows, one tap to switch. Current project is
										 * already listed above with the check — skip it here. */}
										{savedProjects.filter(p => p !== project).length > 0 && (
											<>
												<div className="gui-proj-menu-label">{t("saved workspaces")}</div>
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
															<span className="min-w-0 flex-1 truncate">{projectName(p)}</span>
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
												onProject("folder");
											}}
										>
											<Icon name="folder-open" className="h-3.5 w-3.5" />
											<span>{t("open folder")}</span>
										</button>
										<button
											type="button"
											className="gui-view-opt"
											onClick={() => {
												setProjOpen(false);
												onProject("new");
											}}
										>
											<Icon name="folder-add" className="h-3.5 w-3.5" />
											<span>{t("new blank project")}</span>
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
											<span>{t("remote connection")}</span>
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
												<span>{t("not in a project")}</span>
											</button>
										)}
									</>,
								)}
							</div>
							{/* 预设(mode)chip:与项目 chip 并排一行(DSH hero 对齐),
							 * 新会话创建时应用。样式与项目选择同款(按钮 + 浮层菜单)。 */}
							{modes && (
								<div className="relative z-20 flex-shrink-0" ref={presetAnchorRef}>
									<button
										type="button"
										className="gui-project-chip"
										onClick={() => setPresetOpen(v => !v)}
										aria-label={t("modes title")}
									>
										<Icon name="stack" className="h-3.5 w-3.5" />
										<span className="max-w-[160px] truncate">
											{modes.find(m => m.id === activeModeId)?.label ?? activeModeId}
										</span>
										<Icon name="arrow-down-s" className="h-3 w-3 opacity-60" />
									</button>
									{renderPresetMenu(
										<>
											{/* 无“默认(无预设)”:modeId 恒非 null(默认 work),
											 * 与 DSH 一致——每次新建都带一个预设。 */}
											{modes.map(m => (
												<button
													key={m.id}
													type="button"
													className={`gui-view-opt${activeModeId === m.id ? " gui-view-opt--active" : ""}`}
													onClick={() => {
														onModeChange?.(m.id);
														setPresetOpen(false);
													}}
												>
													<span className="min-w-0 flex-1 truncate">{m.label}</span>
													{activeModeId === m.id && (
														<Icon name="check" className="h-3 w-3 flex-shrink-0" />
													)}
												</button>
											))}
										</>,
									)}
								</div>
							)}
							{branchInfo && (
								<div className="relative z-20" ref={branchAnchorRef}>
									<button
										type="button"
										className="gui-project-chip"
										onClick={() => setBranchOpen(v => !v)}
										aria-label={t("git branch")}
										title={t("git branch")}
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
												{b === branchInfo.current && (
													<Icon name="check" className="h-3 w-3 flex-shrink-0" />
												)}
											</button>
										)),
									)}
								</div>
							)}
						</div>
					)}
					<form
						ref={formRef}
						className="gui-welcome-form relative w-full"
						onSubmit={submit}
						onFocus={() => setBeamOn(true)}
						onBlur={() => setBeamOn(false)}
					>
						<ComposerFrame
							className="gui-welcome-input"
							hero
							heroActive={beamOn}
							chatInput
							flipAnchor="welcome"
							pet={
								pet.enabled && pet.mode === "input" ? <PetSprite mood="rest" pet={pet.pet} size={34} /> : null
							}
							attachments={attachments}
							onRemoveAttachment={id => setAttachments(prev => prev.filter(p => p.id !== id))}
							footerLeft={
								<>
									<AttachMenu
										goalMode={goalArmed}
										planMode={planArmed}
										// Welcome toggles ARM the mode chip only — no popup
										// dialog, no session creation (the input keeps its
										// shape). The first sent message applies the mode
										// to the session it creates.
										onToggleGoal={() => setGoalArmed(v => !v)}
										onTogglePlan={() => setPlanArmed(v => !v)}
										// Guided goal needs a live session (the interview
										// runs in chat); the welcome state has none, and
										// the goal row is already disabled there.
										onGuidedGoal={() => {}}
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
									{/* Focus mode sits between the attach menu and the model
									 * selector (openchamber ComposerFooter order). */}
									{onToggleFocus && (
										<button
											type="button"
											className={`gui-composer-ico${focused ? " gui-composer-ico--active" : ""}`}
											onClick={onToggleFocus}
											title={t("focus mode")}
											aria-label={t("focus mode")}
											aria-pressed={focused}
										>
											<Icon name="expand-up-down" className="h-3.5 w-3.5" />
										</button>
									)}
									<ModelThinkingCapsule
										rpc={rpc}
										sessionId={null}
										presetModelId={presetModelId ?? modelId}
										thinkingLevel={thinking}
										thinkingEfforts={thinkingEfforts}
										allowSetDefault
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
									{/* Armed mode chips (plan/goal): shown IN the button row
									 * right of the thinking selector so the armed state is
									 * visible without opening the attach menu. */}
									{goalArmed && (
										<button
											type="button"
											className="gui-mode-chip gui-mode-chip--armed"
											title={t("next message becomes the goal objective")}
											onClick={() => setGoalArmed(false)}
										>
											<Icon name="target" className="h-3 w-3" />
											<span>{t("goal")}</span>
										</button>
									)}
									{planArmed && (
										<button
											type="button"
											className="gui-mode-chip gui-mode-chip--armed"
											title={t("plan mode")}
											onClick={() => setPlanArmed(false)}
										>
											<Icon name="compass-3" className="h-3 w-3" />
											<span>{t("plan")}</span>
										</button>
									)}
								</>
							}
							footerRight={
								<>
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
													const { submit, trimTrailing } = evaluateSubmitTrigger(
														transcript,
														sttSubmitTrigger,
													);
													if (submit) {
														// TUI stt.submitTrigger parity: auto-send the utterance
														// (minus a stripped "submit" tail) instead of leaving
														// it in the draft box.
														const trimmed = transcript.slice(0, transcript.length - trimTrailing).trim();
														if (trimmed) sendText(trimmed);
													} else {
														setText(prev => (prev ? `${prev} ${transcript}` : transcript));
														requestAnimationFrame(() => autosize(taRef.current));
													}
													setDictating(false);
													setTranscribing(false);
												},
												message => {
													setDictating(false);
													setTranscribing(false);
													dispatchNotification("error", { lastMessage: message });
												},
												rpc,
												activity => {
													if (activity.phase === "recording") {
														setVoiceSeconds(activity.seconds);
														setVoiceLevel(activity.level);
														setTranscribing(false);
													} else if (activity.phase === "transcribing") {
														setTranscribing(true);
													} else if (activity.phase === "error") {
														setDictating(false);
														setTranscribing(false);
														dispatchNotification("error", { lastMessage: activity.message });
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
									<button
										type="submit"
										ref={quotaAnchorRef}
										className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-accent)] text-[var(--color-accent-fg)] transition-opacity disabled:opacity-40"
										disabled={!canSend}
										aria-label={t("send message")}
									>
										<Icon name="send-plane" className="h-4 w-4" />
									</button>
								</>
							}
						>
							<div className="gui-welcome-ta-wrap flex items-start gap-1.5">
								{quotes.length > 0 && (
									<div className="gui-welcome-quotes">
										{quotes.map((q, i) => (
											<div className="gui-quote-card" key={`${i}-${q.slice(0, 32)}`}>
												<div className="gui-quote-text">{q}</div>
												<button
													type="button"
													className="gui-quote-close"
													onClick={() => setQuotes(prev => prev.filter((_, j) => j !== i))}
													title={t("remove quote")}
													aria-label={t("remove quote")}
												>
													<X size={12} />
												</button>
											</div>
										))}
									</div>
								)}
								{renderCompMenu(
									<div
										className="gui-slash-menu gui-slash-menu--rich"
										style={{ minWidth: 300 }}
										ref={completionMenuRef}
									>
										{slashOpen && slashFilter.length > 0 && (
											<>
												<div className="gui-slash-rows">
													{slashFilter.map((c, i) => (
														<SlashRow
															key={c.name}
															item={c}
															active={i === slashIdx}
															onClick={() => insertCompletion("slash", c.name)}
														/>
													))}
												</div>
												<div className="gui-slash-footer">{t("slash completion hints")}</div>
											</>
										)}
										{atOpen &&
											atFilter.length > 0 &&
											atFilter.map((e, i) => (
												<button
													key={e.path}
													type="button"
													className={`gui-model-opt${i === atIdx ? " gui-model-opt--active" : ""}`}
													onClick={() => insertCompletion("at", e.path)}
												>
													<span className="min-w-0 flex-1 truncate">
														{e.isDir ? "📁 " : "📄 "}
														{e.path}
													</span>
												</button>
											))}
										{hashOpen &&
											hashFilter.length > 0 &&
											hashFilter.map((s, i) => (
												<button
													key={s.id}
													type="button"
													className={`gui-model-opt${i === hashIdx ? " gui-model-opt--active" : ""}`}
													onClick={() => insertCompletion("hash", s.id)}
												>
													<span className="min-w-0 flex-1 truncate">
														#{hashLabels.get(s.id) ?? s.cwd ?? s.id}
													</span>
												</button>
											))}
									</div>,
								)}

								{pendingPaste && (
									<LongPasteDialog
										lineCount={pendingPaste.lineCount}
										charCount={pendingPaste.charCount}
										onAction={action => {
											const ta = taRef.current;
											if (!ta) {
												dismissLongPaste();
												return;
											}
											const start = ta.selectionStart ?? ta.value.length;
											const end = ta.selectionEnd ?? ta.value.length;
											if (action === "file") {
												void (async () => {
													try {
														const name = `paste-${Date.now()}.md`;
														await rpc.request("fs.write", {
															cwd: project ?? "",
															path: name,
															content: pendingPaste.text,
														});
														const newText = ta.value.slice(0, start) + name + ta.value.slice(end);
														setText(newText);
														requestAnimationFrame(() =>
															ta.setSelectionRange(start + name.length, start + name.length),
														);
													} catch {
														const newText =
															ta.value.slice(0, start) + pendingPaste.text + ta.value.slice(end);
														setText(newText);
													}
												})();
												dismissLongPaste();
												return;
											}
											const insertion =
												action === "code-block"
													? `\`\`\`\n${pendingPaste.text}\n\`\`\``
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
								<textarea
									ref={el => {
										taRef.current = el;
										compAnchorRef(el);
									}}
									className="w-full min-w-0 flex-1 resize-none bg-transparent px-1 py-3.5 text-[14px] leading-relaxed text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)]"
									rows={3}
									data-focused={focused ? "1" : "0"}
									value={text}
									onPaste={e => {
										const files = [...e.clipboardData.items]
											.filter(i => i.type.startsWith("image/"))
											.map(i => i.getAsFile())
											.filter((f): f is File => f !== null);
										if (files.length > 0) {
											e.preventDefault();
											void addImageFiles(files);
											return;
										}
										const pastedText = e.clipboardData.getData("text");
										if (isLongPastedText(pastedText)) {
											e.preventDefault();
											requestLongPaste(pastedText);
										}
									}}
									onDrop={e => {
										const files = [...e.dataTransfer.files];
										if (files.some(f => f.type.startsWith("image/"))) {
											e.preventDefault();
											void addImageFiles(files);
										}
									}}
									onChange={e => {
										setText(e.target.value);
										if (clearAllRef.current) {
											clearAllRef.current = false;
											if (e.target.value === "") setAttachments([]);
										}
										onCompletionInput(e.target.value);
										// Initial height equals the content height, so
										// first lines never resize the card.
										autosize(taRef.current);
									}}
									onKeyDown={e => {
										// IME composition: the confirming Enter commits the
										// candidate text — never submit while composing.
										if (e.nativeEvent.isComposing || e.keyCode === 229) return;
										// Attachment keyboard flow (WeChat parity): Backspace/
										// Delete on an empty input removes the last image chip;
										// a select-all delete empties attachments too.
										if (e.key === "Backspace" || e.key === "Delete") {
											const ta = taRef.current;
											if (ta) {
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
												insert: () =>
													slashFilter[slashIdx] && insertCompletion("slash", slashFilter[slashIdx]!.name),
											},
											{
												open: atOpen,
												list: atFilter,
												idx: atIdx,
												setIdx: setAtIdx,
												insert: () => atFilter[atIdx] && insertCompletion("at", atFilter[atIdx]!.path),
											},
											{
												open: hashOpen,
												list: hashFilter,
												idx: hashIdx,
												setIdx: setHashIdx,
												insert: () =>
													hashFilter[hashIdx] && insertCompletion("hash", hashFilter[hashIdx]!.id),
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
												setHashOpen(false);
												return;
											}
										}
										if (e.key === "Enter" && !e.shiftKey) {
											e.preventDefault();
											submit(e as unknown as FormEvent<HTMLFormElement>);
										}
									}}
									placeholder={t(PLACEHOLDER_TIPS[tipIdx]!)}
									spellCheck={(() => {
										try {
											return localStorage.getItem("musepi-gui-chat-spellcheck") === "1";
										} catch {
											return false;
										}
									})()}
									autoFocus
									autoComplete="off"
								/>
							</div>
						</ComposerFrame>
					</form>
					{/* Rotating tip with shimmer refresh (key change re-triggers);
					 * t() runs at render time so locale switches land immediately. */}
					<p key={tipKey} className="gui-tip mt-5 text-[14px] text-[var(--color-text-faint)]">
						{t(tipKey).replace("{mod}", modLabel()).replace("⌘", modLabel())}
					</p>
					{/* Suggestion chips (openchamber new-session parity): one tap
					 * fills the composer; the user hits Enter to send. */}
					<div className="gui-suggest-reveal mt-4" ref={suggestRevealRef}>
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
										{r.label}
									</button>
								);
							})}
							{showMore && revealCount > suggestions.length && (
								<button
									type="button"
									className="gui-suggest-chip gui-suggest-chip--manage gui-suggest-chip--expand"
									style={{ animationDelay: "60ms" }}
									onClick={() =>
										window.dispatchEvent(
											new CustomEvent("musepi-gui-open-settings-section", { detail: "suggestions" }),
										)
									}
								>
									{t("custom supplement")}
								</button>
							)}
							<button
								type="button"
								className="gui-suggest-chip gui-suggest-chip--more"
								title={showMore ? t("collapse suggestions") : t("more suggestions")}
								aria-label={showMore ? t("collapse suggestions") : t("more suggestions")}
								onClick={showMore ? collapseSuggestions : expandSuggestions}
							>
								<MorphIcon icon={showMore ? XIcon : PlusIcon} size={13} spring="snappy" />
							</button>
						</div>
					</div>
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
			</div>
		</>
	);
}
