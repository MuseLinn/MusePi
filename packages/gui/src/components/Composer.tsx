import { Check as CheckIconData, WandSparkles as WandSparklesIconData } from "lucide";
import { SendHorizontal, Square, WandSparkles, X } from "lucide-react";
import { MorphIcon } from "morphicons/react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n/index.js";
import { resolveToolRenderer, type ToolRenderHost } from "@musepi/collab-web";
import { ComposerFrame } from "../lib/composer-frame";
import { type ContextBreakdownView, isContextCommand } from "../lib/context-command";
import { tapFeedback } from "../lib/haptic";
import { readAutoResizeImages, readFileAsDataURL, resizeImageDataUrl } from "../lib/image-resize";
import type { PetMood } from "../lib/pet";
import type { RpcClient } from "../lib/rpc";
import { sessionAccentHex } from "../lib/session-accent";
import { sfxFor } from "../lib/sfx";
import { isUsageCommand } from "../lib/usage-command";
import { useFloatingMenu } from "../lib/use-floating-menu";
import { startDictation } from "../lib/voice";
import { Icon } from "../vendor/oc-icons";
import { AttachMenu } from "./AttachMenu";
import { ContextRing, type SnapcompactSavingsView, type UsageQuotaView } from "./ContextRing";
import { autosize, MIN_ROWS } from "./composer-autosize";
import { ModelSelector } from "./ModelSelector";
import { PetSprite, usePet } from "./PetSprite";
import { Reveal } from "./Reveal";
import type { GuiTreeNode } from "./SessionTree";
import { type SlashEntry, SlashRow } from "./SlashRow";
import { type ThinkingLevel, ThinkingSelector } from "./ThinkingSelector";

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
	/** Focus mode (openchamber ⌘⇧E): the composer fills the surface. */
	focused?: boolean;
	onToggleFocus?(): void;
	/** Live `task` tool running in this session (ChatView passes the last
	 *  active task tool's partialResult) — drives the temporary swarm status
	 *  chip above the input. Clicking the chip opens the frosted floating
	 *  member grid (avatar + progress), kimiwork parity. null → no chip. */
	activeTask?: { partialResult?: unknown } | null;
	/** Host for the floating member grid (agent trajectory drill-down). */
	swarmHost?: import("@musepi/collab-web").ToolRenderHost;
}

type EnhanceState = "idle" | "enhancing" | "enhanced";

/**
 * Floating member grid (kimiwork parity): renders the collab-web task
 * renderer's SwarmCard against the live task tool's partialResult details
 * (progress/results) — the frosted card opened from the composer's
 * temporary swarm status chip. Host wires agent-trajectory drill-down.
 */
function SwarmCardPreview({
	details,
	host,
}: {
	details?: unknown;
	host?: ToolRenderHost;
}): ReactNode {
	const SwarmCard = resolveToolRenderer("task").SwarmCard;
	if (!SwarmCard) return null;
	return (
		<SwarmCard
			name="task"
			args={{}}
			result={{ content: [], details }}
			host={host}
		/>
	);
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

/** Per-status glyphs for the todo panel rows (TUI todo board parity). */
const TODO_STATUS_ICONS: Record<string, string> = {
	pending: "○",
	in_progress: "◐",
	completed: "●",
	abandoned: "✕",
	blocked: "⊘",
};

/** Braille spinner frames (cli-spinners "dots" parity): 10 frames at 80ms
 * reads as a rotating 2×4 dot matrix while the agent works. */
const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Agent status line prefs (settings → agent 状态行): the indicator is
 * either the braille spinner, the pulsing orb, the aicss-style 3×3
 * lattice wave, or the 8-dot orbit ring; the label effect is the
 * shimmer sweep, the KITT eye sweep, or plain. The sweep color picks the
 * default tone (text-colored bright stop, shimmer-like) or the accent
 * color — applies to both the shimmer and KITT sweeps. */
export type AgentStatusEffect = "shimmer" | "kitt" | "plain";
export type AgentStatusIndicator = "braille" | "orb" | "lattice" | "ring";
export type SweepColor = "default" | "accent";

export function readStatusPrefs(): {
	effect: AgentStatusEffect;
	indicator: AgentStatusIndicator;
	sweepColor: SweepColor;
} {
	let effect: AgentStatusEffect = "shimmer";
	let indicator: AgentStatusIndicator = "braille";
	let sweepColor: SweepColor = "default";
	try {
		const e = localStorage.getItem("omp-gui-statusbar");
		if (e === "kitt" || e === "plain" || e === "shimmer") effect = e;
		const i = localStorage.getItem("omp-gui-statusbar-indicator");
		if (i === "orb" || i === "braille" || i === "lattice" || i === "ring") indicator = i;
		const k = localStorage.getItem("omp-gui-statusbar-kitt-color");
		if (k === "accent" || k === "default") sweepColor = k;
	} catch {
		// localStorage unavailable — defaults stand
	}
	return { effect, indicator, sweepColor };
}

/**
 * Agent status line hanging above the input card: small braille spinner
 * (or the pulsing orb, per prefs) + label while the agent works, then a
 * brief "思考完毕" acknowledgement when the turn ends (user: the thinking
 * state lives here — outside the input card and not duplicated in the
 * transcript — and flips to complete once finished). The label defaults to
 * the shimmer sweep; in kitt mode the label carries the KITT eye instead
 * (a text-clipped accent band bouncing left↔right, same idea, no bar).
 */
function AgentStatusLine({
	working,
	effect,
	indicator,
	sweepColor = "default",
	sessionKey,
}: {
	working: boolean;
	effect: AgentStatusEffect;
	indicator: AgentStatusIndicator;
	sweepColor?: SweepColor;
	/** Session id/name — derives the TUI-style per-session accent that
	 * colors the spinner/orb; absent (settings preview) → theme accent. */
	sessionKey?: string;
}): ReactNode {
	const [phase, setPhase] = useState<"idle" | "thinking" | "done">("idle");
	const [braille, setBraille] = useState(0);
	// Phase transitions are pure state changes; the idle-revert timer lives
	// in its OWN effect so the re-render triggered by thinking→done (which
	// re-runs this effect and its cleanup) cannot clear the timer it just
	// set — the old shape left "思考完毕" pinned forever after a stop.
	useEffect(() => {
		if (working) {
			setPhase("thinking");
		} else if (phase === "thinking") {
			setPhase("done");
		}
	}, [working, phase]);
	// "done" reverts to idle after a beat (keeps the static ⠿ ack visible).
	useEffect(() => {
		if (phase !== "done") return;
		const id = window.setTimeout(() => setPhase("idle"), 1500);
		return () => clearTimeout(id);
	}, [phase]);
	// Braille frame clock — only while thinking; "done" holds a static ⠿.
	useEffect(() => {
		if (phase !== "thinking") return;
		const id = window.setInterval(() => setBraille(i => (i + 1) % BRAILLE_FRAMES.length), 80);
		return () => clearInterval(id);
	}, [phase]);
	if (phase === "idle") return null;
	const accent = sessionKey ? sessionAccentHex(sessionKey) : null;
	return (
		<div
			className={`gui-agent-status gui-agent-status--${effect}${
				sweepColor === "accent" ? " gui-agent-status--sweep-accent" : ""
			}`}
			style={accent ? ({ "--gui-status-accent": accent } as CSSProperties) : undefined}
		>
			{indicator === "orb" ? (
				<span className="gui-agent-status-orb" aria-hidden />
			) : indicator === "lattice" ? (
				<span className="gui-agent-status-lattice" aria-hidden>
					<i />
					<i />
					<i />
					<i />
					<i />
					<i />
					<i />
					<i />
					<i />
				</span>
			) : indicator === "ring" ? (
				<span className="gui-agent-status-ring" aria-hidden>
					<i />
					<i />
					<i />
					<i />
					<i />
					<i />
					<i />
					<i />
				</span>
			) : (
				<span className="gui-agent-status-braille" aria-hidden>
					{phase === "thinking" ? BRAILLE_FRAMES[braille] : "⠿"}
				</span>
			)}
			<span className="gui-agent-status-text">
				{phase === "thinking" ? t("agent is thinking…") : t("thinking complete")}
			</span>
		</div>
	);
}

export { AgentStatusLine };

/**
 * Compaction status line — replaces the agent status line while the
 * session context is being compacted (manual ring action or daemon auto
 * compaction). Same floating chip above the input card, plus a stop
 * button: the TUI's Esc path (session.abort → AgentSession.abort →
 * abortCompaction) without a confirm — compaction is cheap to re-run.
 */
function CompactionStatusLine({ onCancel }: { onCancel(): void }): ReactNode {
	const [braille, setBraille] = useState(0);
	useEffect(() => {
		const id = window.setInterval(() => setBraille(i => (i + 1) % BRAILLE_FRAMES.length), 80);
		return () => clearInterval(id);
	}, []);
	return (
		<div className="gui-compact-line" role="status" aria-live="polite">
			<span className="gui-agent-status-braille" aria-hidden>
				{BRAILLE_FRAMES[braille]}
			</span>
			<span className="gui-compact-line-text">{t("compacting…")}</span>
			<button
				type="button"
				className="gui-compact-line-stop"
				onClick={onCancel}
				title={t("stop compaction")}
				aria-label={t("stop compaction")}
			>
				<Square size={11} fill="currentColor" />
			</button>
		</div>
	);
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
}: ComposerProps): ReactNode {
	const pet = usePet();
	const [text, setText] = useState("");
	// Element picker (browser tool) inserts picked-page text into the draft.
	useEffect(() => {
		const onInsert = (e: Event): void => {
			const detail = (e as CustomEvent<{ text?: string }>).detail;
			const insertion = detail?.text;
			if (!insertion) return;
			setText(prev => (prev.length === 0 ? insertion : `${prev}\n${insertion}`));
		};
		window.addEventListener("omp-gui-insert-text", onInsert);
		return () => window.removeEventListener("omp-gui-insert-text", onInsert);
	}, []);
	const [enhance, setEnhance] = useState<EnhanceState>("idle");
	const [attachments, setAttachments] = useState<{ id: number; dataUrl: string; mimeType: string; name: string }[]>(
		[],
	);
	const attachId = useRef(0);
	// Slash-command completion (TUI parity): typing "/" lists the daemon's
	// builtin registry; Enter/click inserts the command token.
	const [slashOpen, setSlashOpen] = useState(false);
	const [slashQuery, setSlashQuery] = useState("");
	const [slashCmds, setSlashCmds] = useState<SlashEntry[] | null>(null);
	// Selection index must be STATE: arrow keys set it inside onKeyDown and
	// the active-row highlight depends on it — a ref never re-renders, so
	// the highlight only moved on unrelated renders (typing/streaming).
	const [slashIdx, setSlashIdx] = useState(0);
	// "@" completion (TUI/ZCode parity): @ = files & folders from the
	// workspace tree scan (workspace.tree), NOT agents.
	const [atOpen, setAtOpen] = useState(false);
	const [atQuery, setAtQuery] = useState("");
	const [atEntries, setAtEntries] = useState<{ name: string; path: string; isDir: boolean; depth: number }[] | null>(
		null,
	);
	const [atIdx, setAtIdx] = useState(0);
	// "#" completion (insert a session reference): lists session.list, with
	// titles resolved from session.tree labels (fallback: cwd basename).
	const [hashOpen, setHashOpen] = useState(false);
	const [hashQuery, setHashQuery] = useState("");
	const [hashSessions, setHashSessions] = useState<
		{ id: string; timestamp?: string; messageCount?: number; cwd?: string }[] | null
	>(null);
	const [hashLabels, setHashLabels] = useState<Map<string, string>>(new Map());
	const [hashIdx, setHashIdx] = useState(0);
	const [dictating, setDictating] = useState(false);

	// ── Chat prefs (openchamber parity, shared with the chat settings) ──
	// Stable identity: the draft RESTORE effect keys on draftEnabled, so a
	// fresh closure per render would re-run the restore on EVERY render —
	// deleting the last character (text → "") then resurrects the stale
	// localStorage draft ("最后一个字删不掉"). useCallback keeps the
	// restore scoped to sessionId changes.
	const draftEnabled = useCallback((): boolean => {
		try {
			return localStorage.getItem("omp-gui-chat-draft") !== "0";
		} catch {
			return true;
		}
	}, []);
	const spellcheckEnabled = (): boolean => {
		try {
			return localStorage.getItem("omp-gui-chat-spellcheck") === "1";
		} catch {
			return false;
		}
	};
	// Draft persistence (persistDraft parity): restore the per-session
	// draft when the composer mounts or the session switches, and save
	// every change; submitting clears the box, which empties the draft
	// through the same effect. The composer stays mounted across session
	// switches (ChatView swaps the store in place), so the box must be
	// RESET to the incoming session's draft — the old restore only FILLED
	// empty boxes and never cleared, so text recalled in one session
	// ("撤回还原") stayed in the box for every later session and the save
	// effect then wrote it under the new session's draft key.
	const sessionResetRef = useRef(true);
	useEffect(() => {
		// Keyed on sessionId only: re-running on draftEnabled toggles would
		// clobber in-progress text when the pref flips.
		sessionResetRef.current = true;
		let next = "";
		if (draftEnabled()) {
			try {
				next = localStorage.getItem(`omp-gui-draft:${sessionId}`) ?? "";
			} catch {
				// localStorage unavailable — start empty
			}
		}
		setText(next);
	}, [sessionId, draftEnabled]);
	// Idle-recap editor-draft guard (TUI parity): report the un-sent draft
	// to the daemon (session.setDraft) so a scheduled idle recap is
	// suppressed while the user is composing. `true` is debounced (typing
	// bursts), `false` goes out immediately — a cleared box must not miss
	// the next agent_end's recap scheduling window.
	const lastSentDraftRef = useRef<boolean | null>(null);
	const draftReportTimerRef = useRef<Timer | null>(null);
	useEffect(() => {
		const hasDraft = text.trim().length > 0;
		if (hasDraft === lastSentDraftRef.current) return;
		if (!hasDraft) {
			if (draftReportTimerRef.current) {
				clearTimeout(draftReportTimerRef.current);
				draftReportTimerRef.current = null;
			}
			lastSentDraftRef.current = false;
			if (rpc && sessionId) {
				void rpc.request("session.setDraft", { sessionId, draft: false }).catch(() => {});
			}
			return;
		}
		if (draftReportTimerRef.current) return;
		draftReportTimerRef.current = setTimeout(() => {
			draftReportTimerRef.current = null;
			lastSentDraftRef.current = true;
			if (rpc && sessionId) {
				void rpc.request("session.setDraft", { sessionId, draft: true }).catch(() => {});
			}
		}, 300);
	}, [text, sessionId, rpc]);
	useEffect(() => {
		return () => {
			if (draftReportTimerRef.current) {
				clearTimeout(draftReportTimerRef.current);
				draftReportTimerRef.current = null;
			}
			if (lastSentDraftRef.current === true && rpc && sessionId) {
				void rpc.request("session.setDraft", { sessionId, draft: false }).catch(() => {});
			}
		};
	}, [rpc, sessionId]);
	useEffect(() => {
		if (sessionResetRef.current) {
			// The text in this commit is either stale (belongs to the
			// previous session) or was just restored by the reset effect —
			// skip writing so old-session text can't leak into the new
			// session's draft key.
			sessionResetRef.current = false;
			return;
		}
		if (!draftEnabled()) return;
		try {
			if (text.length > 0) localStorage.setItem(`omp-gui-draft:${sessionId}`, text);
			else localStorage.removeItem(`omp-gui-draft:${sessionId}`);
		} catch {
			// ignore
		}
	}, [text, sessionId, draftEnabled]);

	// ── Goal / plan mode + todo progress (TUI /goal /plan parity) ─────────
	const [modes, setModes] = useState<{
		goalMode: { enabled: boolean; objective?: string; status?: string } | null;
		planMode: boolean;
		isCompacting: boolean;
		todo: {
			name: string;
			done: number;
			total: number;
			tasks: { content: string; status: string; blocker?: string }[];
		}[];
	} | null>(null);
	const [todoOpen, setTodoOpen] = useState(false);
	const [appendText, setAppendText] = useState("");
	const refreshModes = useCallback((): void => {
		if (!rpc || !sessionId) return;
		void rpc
			.request<typeof modes>("session.modes", { sessionId })
			.then(res => {
				// Value-compare: keep the previous reference when nothing
				// changed so the tick never re-renders the composer.
				if (res) setModes(prev => (JSON.stringify(prev) === JSON.stringify(res) ? prev : res));
			})
			.catch(() => {});
	}, [rpc, sessionId]);
	useEffect(() => {
		refreshModes();
		let id = setInterval(refreshModes, 3000);
		// The poll is pure UI freshness — never run it while the tab is
		// hidden (background CPU + daemon RPCs for nothing).
		const onVis = (): void => {
			clearInterval(id);
			if (document.visibilityState === "visible") {
				refreshModes();
				id = setInterval(refreshModes, 3000);
			}
		};
		document.addEventListener("visibilitychange", onVis);
		return () => {
			clearInterval(id);
			document.removeEventListener("visibilitychange", onVis);
		};
	}, [refreshModes]);
	// Armed goal (openchamber parity): one tap with no live goal arms goal
	// mode — the NEXT SENT MESSAGE becomes the objective (no popup dialog,
	// same one-tap shape as the plan-mode toggle). A second tap disarms.
	const [goalArmed, setGoalArmed] = useState(false);
	// A goal arriving from the daemon (poll/own send) clears the armed state.
	useEffect(() => {
		if (modes?.goalMode?.enabled === true) setGoalArmed(false);
	}, [modes?.goalMode?.enabled]);
	const toggleGoalMode = (): void => {
		if (!rpc || !sessionId) return;
		// End an active goal without prompting (TUI /goal off parity).
		if (modes?.goalMode?.enabled === true) {
			void rpc
				.request("session.setGoal", { sessionId })
				.then(res => setModes(res as typeof modes))
				.catch(() => {});
			return;
		}
		setGoalArmed(v => !v);
	};
	const togglePlanMode = (): void => {
		if (!rpc || !sessionId) return;
		void rpc
			.request("session.setPlan", { sessionId })
			.then(res => setModes(res as typeof modes))
			.catch(() => {});
	};
	const todo = modes?.todo ?? [];
	const todoTotal = todo.reduce((n, p) => n + p.total, 0);
	const todoDone = todo.reduce((n, p) => n + p.done, 0);
	// ── Todo mutations (TUI /todo parity) ─────────────────────────────────
	// The panel is read-only without these; each op round-trips through the
	// daemon (setTodoPhases + user_todo_edit entry) and swaps the fresh
	// snapshot into the polled `modes` so the chips/bar update in place.
	const todoOp = useCallback(
		(op: "append" | "start" | "done" | "drop" | "rm", content?: string, phase?: string): void => {
			if (!rpc || !sessionId) return;
			void rpc
				.request<{ todo: typeof todo }>("session.todo", { sessionId, op, content, phase })
				.then(res => {
					if (res?.todo) setModes(prev => (prev ? { ...prev, todo: res.todo } : prev));
				})
				.catch(() => {});
		},
		[rpc, sessionId],
	);
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
	}, [rpc, sessionId, refreshUsage]);

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
					limits: Array<{
						label: string;
						amount?: { usedFraction?: number; remainingFraction?: number };
						window?: { resetsAt?: number; resetLabel?: string };
					}>;
				}>;
			}>("usage.reports", { sessionId });
			const reports = res?.reports ?? [];
			if (reports.length === 0) return null;
			const limits: UsageQuotaView["limits"] = [];
			for (const report of reports) {
				for (const limit of report.limits ?? []) {
					const usedFraction = limit.amount?.usedFraction;
					if (usedFraction === undefined) continue;
					const usedPercent = usedFraction * 100;
					const leftPercent = (limit.amount?.remainingFraction ?? Math.max(0, 1 - usedFraction)) * 100;
					const resetsAt = limit.window?.resetsAt;
					limits.push({
						label: limit.label,
						usedPercent,
						leftPercent,
						...(resetsAt && resetsAt > Date.now() ? { resetsIn: fmtQuotaDuration(resetsAt - Date.now()) } : {}),
					});
				}
			}
			if (limits.length === 0) return null;
			return { provider: reports[0]!.provider, limits };
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
		data: {
			reports: UsageReportView[];
			activeAccount: UsageActiveAccountView | null;
			fetchedAt: number;
		} | null;
	}>({
		open: false,
		loading: false,
		data: null,
	});
	// Full report shape from usage.reports (daemon passes the raw
	// @musepi/pi-ai UsageReport[] through) — the panel renders TUI /usage
	// parity, while the ContextRing popover keeps its compact fetchUsageQuota.
	const fetchUsageReports = useCallback(async (): Promise<{
		reports: UsageReportView[];
		activeAccount: UsageActiveAccountView | null;
	} | null> => {
		if (!rpc || !sessionId) return null;
		try {
			const res = await rpc.request<{
				reports: UsageReportView[];
				activeAccount?: UsageActiveAccountView | null;
			}>("usage.reports", { sessionId });
			if (!res || !Array.isArray(res.reports)) return null;
			return { reports: res.reports, activeAccount: res.activeAccount ?? null };
		} catch {
			return null;
		}
	}, [rpc, sessionId]);
	const openUsagePanel = useCallback((): void => {
		setContextPanel(null);
		setUsagePanel({ open: true, loading: true, data: null });
		void fetchUsageReports().then(data => {
			setUsagePanel(s =>
				s.open ? { open: true, loading: false, data: data ? { ...data, fetchedAt: Date.now() } : null } : s,
			);
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

	useEffect(() => {
		if (!usagePanel.open && !contextPanel?.open) return;
		const onKey = (e: globalThis.KeyboardEvent): void => {
			if (e.key === "Escape") {
				setUsagePanel(s => ({ ...s, open: false }));
				setContextPanel(s => (s ? { ...s, open: false } : s));
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [usagePanel.open, contextPanel?.open]);

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

	// Image paste/drop (openchamber parity): read files as data URLs for
	// preview; the base64 payload rides along in session.send.images.
	// Front-resize large images (TUI parity, images.autoResize-governed)
	// so multi-MB screenshots don't ship full-size over the socket.
	const addImageFiles = async (files: File[]): Promise<void> => {
		const imgs = files.filter(f => f.type.startsWith("image/"));
		if (imgs.length === 0) return;
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

	const slashFilter = (() => {
		const q = slashQuery.toLowerCase();
		// /skill, /skills, /skill: — the user's intent is the skill list:
		// surface every skill command (kind: skill) instead of matching
		// against literal "skills" text (skill:foo doesn't contain it).
		const isSkillQuery = q === "skill" || q === "skills" || q.startsWith("skill:");
		// GUI-native /usage + /context: the daemon's catalog already carries
		// the TUI's commands (with show/reset subcommands) — sending either
		// to the agent returns ANSI panel text, and the composer intercepts
		// the bare commands anyway, so keep ONE GUI entry per command (with
		// the friendly description + GUI category) and drop the daemon's.
		const guiUsageCmd: SlashEntry = {
			name: "usage",
			description: t("show subscription usage"),
			kind: "command",
			category: "GUI",
		};
		const guiContextCmd: SlashEntry = {
			name: "context",
			description: t("show context usage"),
			kind: "command",
			category: "GUI",
		};
		const list = [
			...(slashCmds ?? []).filter(c => c.name !== "usage" && c.name !== "context"),
			guiUsageCmd,
			guiContextCmd,
		];
		return list.filter(c =>
			isSkillQuery && c.kind === "skill"
				? true
				: c.name.includes(q) || (c.description ?? "").toLowerCase().includes(q),
		);
	})();

	const onSlashInput = (value: string): void => {
		// Trigger when the current line starts with "/".
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
	};

	const insertSlash = (name: string): void => {
		const ta = taRef.current;
		if (!ta) return;
		const lineStart = ta.value.lastIndexOf("\n") + 1;
		// Replace the "/query" token with "/name ".
		const prefix = ta.value.slice(0, lineStart);
		const rest = ta.value.slice(lineStart + slashQuery.length + 1);
		const next = `${prefix}/${name} ${rest}`;
		setText(next);
		setSlashOpen(false);
		requestAnimationFrame(() => autosize(taRef.current));
	};

	const onAtInput = (value: string): void => {
		// Trigger when the current line starts with "@" (TUI file mention).
		const lineStart = value.lastIndexOf("\n") + 1;
		const line = value.slice(lineStart);
		if (line.startsWith("@") && line.length >= 1) {
			setAtQuery(line.length > 1 ? line.slice(1) : "");
			setAtOpen(true);
			setAtIdx(0);
			if (!atEntries && rpc) {
				void rpc
					.request<{
						entries: { name: string; path: string; isDir: boolean; size: number; mtime: number; depth: number }[];
					}>("workspace.tree", { cwd: cwd ?? "", maxDepth: 3, perDirLimit: 100 })
					.then(res =>
						setAtEntries(
							(res.entries ?? []).map(e => ({
								name: e.name,
								path: e.path,
								isDir: e.isDir,
								depth: e.depth,
							})),
						),
					)
					.catch(() => setAtEntries([]));
			}
		} else {
			setAtOpen(false);
		}
	};

	const atFilter =
		atEntries?.filter(
			e =>
				e.name.toLowerCase().includes(atQuery.toLowerCase()) ||
				e.path.toLowerCase().includes(atQuery.toLowerCase()),
		) ?? [];

	const insertAt = (path: string): void => {
		const ta = taRef.current;
		if (!ta) return;
		const lineStart = ta.value.lastIndexOf("\n") + 1;
		const prefix = ta.value.slice(0, lineStart);
		const rest = ta.value.slice(lineStart + atQuery.length + 1);
		setText(`${prefix}@${path} ${rest}`);
		setAtOpen(false);
		requestAnimationFrame(() => autosize(taRef.current));
	};

	const onHashInput = (value: string): void => {
		// Trigger when the current line starts with "#" (insert a session).
		const lineStart = value.lastIndexOf("\n") + 1;
		const line = value.slice(lineStart);
		if (line.startsWith("#") && line.length >= 1) {
			setHashQuery(line.length > 1 ? line.slice(1) : "");
			setHashOpen(true);
			setHashIdx(0);
			if (!hashSessions && rpc) {
				void rpc
					.request<{ id: string; timestamp?: string; messageCount?: number; cwd?: string }[]>("session.list", {})
					.then(list => setHashSessions(list ?? []))
					.catch(() => setHashSessions([]));
				// Titles come from the session tree (renames/首条消息 labels);
				// fetch alongside the list so rows show names, not raw ids.
				void rpc
					.request<GuiTreeNode[]>("session.tree", {})
					.then(nodes => {
						const labels = new Map<string, string>();
						const walk = (ns: GuiTreeNode[]): void => {
							for (const n of ns) {
								const label = n.entry.label ?? n.label;
								if (label) labels.set(n.entry.id, label);
								walk(n.children);
							}
						};
						walk(nodes ?? []);
						setHashLabels(labels);
					})
					.catch(() => {});
			}
		} else {
			setHashOpen(false);
		}
	};

	const hashFilter =
		hashSessions?.filter(
			e =>
				(e.id ?? "").toLowerCase().includes(hashQuery.toLowerCase()) ||
				(e.cwd ?? "").toLowerCase().includes(hashQuery.toLowerCase()),
		) ?? [];

	// Display title for a # row: session.tree label, else cwd basename,
	// else a short id slice (the inserted token always keeps the full id).
	const hashLabel = (e: { id: string; cwd?: string }): string => {
		const tree = hashLabels.get(e.id);
		if (tree) return tree;
		const base = e.cwd?.split("/").filter(Boolean).at(-1);
		if (base) return base;
		return e.id.slice(0, 8);
	};

	const insertHash = (id: string): void => {
		const ta = taRef.current;
		if (!ta) return;
		const lineStart = ta.value.lastIndexOf("\n") + 1;
		const prefix = ta.value.slice(0, lineStart);
		const rest = ta.value.slice(lineStart + hashQuery.length + 1);
		// Insert a read-tool-resolvable internal URL (TUI parity: the "#"
		// GitHub-ref completion rewrites to issue://pr:// URLs). The model
		// can `read history://<id>` to inspect the referenced session.
		setText(`${prefix}history://${id} ${rest}`);
		setHashOpen(false);
		requestAnimationFrame(() => autosize(taRef.current));
	};

	const onPaste = (e: React.ClipboardEvent): void => {
		const files = [...e.clipboardData.items]
			.filter(i => i.type.startsWith("image/"))
			.map(i => i.getAsFile())
			.filter((f): f is File => f !== null);
		if (files.length > 0) {
			e.preventDefault();
			void addImageFiles(files);
		}
	};

	const onDrop = (e: React.DragEvent): void => {
		const files = [...e.dataTransfer.files];
		if (files.some(f => f.type.startsWith("image/"))) {
			e.preventDefault();
			void addImageFiles(files);
		}
	};
	const taRef = useRef<HTMLTextAreaElement | null>(null);
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
	// Only one completion menu is mounted at a time (conditional render), so
	// a single ref tracks whichever is open.
	const completionMenuRef = useRef<HTMLDivElement | null>(null);
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
	// Keep the active row in view while arrow-navigating: the menu scrolls
	// internally (max-height 300px, overflow-y auto), so the highlight can
	// run out of the visible area without a scroll.
	useEffect(() => {
		const menu = completionMenuRef.current;
		if (!menu) return;
		const active = menu.querySelector(".gui-slash-row--active, .gui-model-opt--active");
		active?.scrollIntoView({ block: "nearest" });
	}, [slashIdx, atIdx, hashIdx, slashOpen, atOpen, hashOpen]);

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
				<div className="gui-quota-panel" role="dialog" aria-label={t("subscription usage")}>
					<button type="button" className="gui-quota-close" onClick={closeUsagePanel} aria-label={t("close")}>
						<Icon name="close" className="h-3.5 w-3.5" />
					</button>
					<div className="gui-quota-title">
						{t("subscription usage")}
						{usagePanel.data?.fetchedAt
							? ` · ${t("usage {time} ago", { time: fmtQuotaDuration(Date.now() - usagePanel.data.fetchedAt) })}`
							: null}
					</div>
					{usagePanel.loading ? (
						<div className="gui-quota-note">…</div>
					) : usagePanel.data && usagePanel.data.reports.length > 0 ? (
						<div className="gui-usage-reports">
							{usagePanel.data.reports.map(report => (
								<UsageProviderSection
									key={report.provider}
									report={report}
									activeAccount={usagePanel.data!.activeAccount}
								/>
							))}
						</div>
					) : (
						<div className="gui-quota-note">{t("no subscription usage reported")}</div>
					)}
				</div>,
			)}
			{/* GUI-native /context — categorized context-window card above
			 * the composer (TUI /context panel parity), floating like /usage. */}
			{contextPanel
				? renderContextMenu(
						<div className="gui-quota-panel" role="dialog" aria-label={t("context usage")}>
							<button
								type="button"
								className="gui-quota-close"
								onClick={() => setContextPanel(s => (s ? { ...s, open: false } : s))}
								aria-label={t("close")}
							>
								<Icon name="close" className="h-3.5 w-3.5" />
							</button>
							<div className="gui-quota-title">{t("context usage")}</div>
							{contextPanel!.loading ? (
								<div className="gui-quota-note">…</div>
							) : contextPanel!.data ? (
								<>
									{contextPanel!.data.model && (
										<div className="gui-context-model">{contextPanel!.data.model}</div>
									)}
									<div className="gui-context-summary">
										<span className="gui-context-summary-tokens">
											{t("context window {tokens} ({percent} used)", {
												tokens: fmtTokens(contextPanel!.data.contextWindow),
												percent: `${Math.round(contextPanel!.data.percent)}%`,
											})}
										</span>
									</div>
									{contextPanel!.data.breakdown &&
										renderContextGrid(
											contextPanel!.data.breakdown,
											contextPanel!.data.autoCompactBufferTokens ?? 0,
										)}
									{contextPanel!.data.snapcompact && (
										<div className="gui-context-snap">
											<div className="gui-context-snap-title">
												{contextPanel!.data.snapcompact.visionCapable
													? t("snapcompact savings")
													: `Snapcompact: ${t("model does not support images")}`}
											</div>
											{contextPanel!.data.snapcompact.visionCapable &&
												renderSnapcompactLines(
													contextPanel!.data.snapcompact,
													contextPanel!.data.tokens ?? contextPanel!.data.breakdown?.usedTokens ?? 0,
												)}
										</div>
									)}
									{contextPanel!.data.breakdown ? (
										<div className="gui-context-cats">
											{renderContextCat(
												"context system prompt",
												contextPanel!.data.breakdown.systemPromptTokens,
												contextPanel!.data.contextWindow,
												CONTEXT_CELL_FILLED,
												"gui-context-glyph--system",
											)}
											{renderContextCat(
												"context system tools",
												contextPanel!.data.breakdown.systemToolsTokens,
												contextPanel!.data.contextWindow,
												CONTEXT_CELL_FILLED,
												"gui-context-glyph--tools",
											)}
											{renderContextCat(
												"context system context",
												contextPanel!.data.breakdown.systemContextTokens,
												contextPanel!.data.contextWindow,
												CONTEXT_CELL_FILLED,
												"gui-context-glyph--context",
											)}
											{renderContextCat(
												"context skills",
												contextPanel!.data.breakdown.skillsTokens,
												contextPanel!.data.contextWindow,
												CONTEXT_CELL_FILLED,
												"gui-context-glyph--skills",
											)}
											{renderContextCat(
												"context messages",
												contextPanel!.data.breakdown.messagesTokens,
												contextPanel!.data.contextWindow,
												CONTEXT_CELL_MESSAGES,
												"gui-context-glyph--messages",
											)}
											{renderContextCat(
												"context free",
												contextPanel!.data.freeTokens ??
													Math.max(
														0,
														contextPanel!.data.contextWindow -
															contextPanel!.data.breakdown.usedTokens -
															(contextPanel!.data.autoCompactBufferTokens ?? 0),
													),
												contextPanel!.data.contextWindow,
												CONTEXT_CELL_FREE,
												"gui-context-glyph--free",
											)}
											{(contextPanel!.data.autoCompactBufferTokens ?? 0) > 0 &&
												renderContextCat(
													"context autocompact buffer",
													contextPanel!.data.autoCompactBufferTokens ?? 0,
													contextPanel!.data.contextWindow,
													CONTEXT_CELL_BUFFER,
													"gui-context-glyph--buffer",
												)}
										</div>
									) : (
										<div className="gui-quota-note">{t("context usage unavailable")}</div>
									)}
								</>
							) : (
								<div className="gui-quota-note">{t("context usage unavailable")}</div>
							)}
						</div>,
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
					modes && (todoTotal > 0 || (working && queued != null && queued.count > 0)) || activeTask ? (
						<div className="gui-mode-row gui-mode-row--status">
							{activeTask && (
								<>
									<button
										type="button"
										ref={swarmAnchorRef}
										className={`gui-swarm-chip${swarmOpen ? " gui-swarm-chip--open" : ""}`}
										title={t("swarm members")}
										aria-expanded={swarmOpen}
										onClick={() => setSwarmOpen(v => !v)}
									>
										<span className="gui-swarm-chip-dot" aria-hidden="true" />
										<span className="gui-swarm-chip-label">{t("swarm members")}</span>
									</button>
									{renderSwarmMenu(
										<div className="gui-swarm-popup-card" role="region" aria-label={t("swarm members")}>
											<SwarmCardPreview
												details={
													(activeTask.partialResult as { details?: unknown } | null | undefined)?.details
												}
												host={swarmHost}
											/>
										</div>,
									)}
								</>
							)}
							{todoTotal > 0 && (
								<button
									type="button"
									ref={todoAnchorRef}
									className={`gui-todo-chip${todoOpen ? " gui-todo-chip--open" : ""}`}
									title={todo.map(p => `${p.name} ${p.done}/${p.total}`).join(" · ")}
									aria-expanded={todoOpen}
									onClick={() => setTodoOpen(v => !v)}
								>
									<div className="gui-todo-bar">
										<div className="gui-todo-fill" style={{ width: `${(todoDone / todoTotal) * 100}%` }} />
									</div>
									<span className="gui-todo-label">
										{todoDone}/{todoTotal}
									</span>
								</button>
							)}
							{renderTodoMenu(
								<div className="gui-todo-panel" role="region" aria-label={t("todo list")}>
									{todo.map(phase => (
										<div key={phase.name} className="gui-todo-phase">
											<div className="gui-todo-phase-head">
												<span className="gui-todo-phase-name">{phase.name}</span>
												<span className="gui-todo-phase-count">
													{phase.done}/{phase.total}
												</span>
											</div>
											<div className="gui-todo-bar">
												<div
													className="gui-todo-fill"
													style={{ width: `${(phase.done / phase.total) * 100}%` }}
												/>
											</div>
											{phase.tasks.map((task, i) => (
												<div key={i} className={`gui-todo-task gui-todo-task--${task.status}`}>
													<span className="gui-todo-task-icon">
														{TODO_STATUS_ICONS[task.status] ?? "·"}
													</span>
													<span className="min-w-0 flex-1 truncate" title={task.content}>
														{task.content}
													</span>
													{task.blocker && (
														<span className="gui-todo-task-blocker" title={task.blocker}>
															{task.blocker}
														</span>
													)}
													<span className="gui-todo-task-actions">
														{task.status === "pending" && (
															<button
																type="button"
																className="gui-todo-act"
																title={t("mark in progress")}
																aria-label={t("mark in progress")}
																onClick={() => todoOp("start", task.content)}
															>
																<Icon name="play" className="h-3 w-3" />
															</button>
														)}
														{task.status !== "completed" && (
															<button
																type="button"
																className="gui-todo-act"
																title={t("mark done")}
																aria-label={t("mark done")}
																onClick={() => todoOp("done", task.content)}
															>
																<Icon name="check" className="h-3 w-3" />
															</button>
														)}
														{task.status !== "abandoned" && task.status !== "completed" && (
															<button
																type="button"
																className="gui-todo-act"
																title={t("abandon task")}
																aria-label={t("abandon task")}
																onClick={() => todoOp("drop", task.content)}
															>
																<Icon name="close" className="h-3 w-3" />
															</button>
														)}
														<button
															type="button"
															className="gui-todo-act"
															title={t("remove task")}
															aria-label={t("remove task")}
															onClick={() => todoOp("rm", task.content)}
														>
															<Icon name="delete-bin" className="h-3 w-3" />
														</button>
													</span>
												</div>
											))}
											<div className="gui-todo-append">
												<input
													className="gui-todo-append-input"
													value={appendText}
													onChange={e => setAppendText(e.target.value)}
													onKeyDown={e => {
														if (e.key === "Enter") {
															e.preventDefault();
															if (appendText.trim()) {
																todoOp("append", appendText.trim(), phase.name);
																setAppendText("");
															}
														}
													}}
													placeholder={t("add a task…")}
													aria-label={t("add a task…")}
												/>
												<button
													type="button"
													className="gui-todo-act gui-todo-act--add"
													title={t("add task")}
													aria-label={t("add task")}
													disabled={!appendText.trim()}
													onClick={() => {
														if (appendText.trim()) {
															todoOp("append", appendText.trim(), phase.name);
															setAppendText("");
														}
													}}
												>
													<Icon name="add" className="h-3 w-3" />
												</button>
											</div>
										</div>
									))}
								</div>,
							)}
							{/* Pending-message queue (TUI /queue parity): editable list
							 * above the input — 取回 pops the newest queued message
							 * back into the editor. */}
							{working && queued && queued.count > 0 && (
								<>
									<button
										type="button"
										ref={queueAnchorRef}
										className={`gui-queue-chip${queueOpen ? " gui-queue-chip--open" : ""}`}
										aria-expanded={queueOpen}
										onClick={() => setQueueOpen(v => !v)}
									>
										<Icon name="list-unordered" className="h-3 w-3" />
										<span>{t("queued {count}", { count: String(queued.count) })}</span>
									</button>
									{renderQueueMenu(
										<div className="gui-queue-panel" role="region" aria-label={t("queued messages")}>
											{/* Grouped like the TUI pending display: steering
											 * (immediate) vs after yield (next-turn). */}
											{queued.steering.length > 0 && (
												<>
													<div className="gui-queue-group">
														{t("Steering")} · {queued.steering.length}
													</div>
													{queued.steering.map((msg, i) => (
														<div key={`s-${i}-${msg.slice(0, 12)}`} className="gui-queue-item">
															<span className="gui-queue-item-text" title={msg}>
																{msg}
															</span>
															<button
																type="button"
																className="gui-queue-send"
																title={t("send now")}
																aria-label={t("send now")}
																onClick={() => void sendQueued("steering", msg, i)}
															>
																<Icon name="arrow-up" className="h-3 w-3" />
															</button>
														</div>
													))}
												</>
											)}
											{queued.followUp.length > 0 && (
												<>
													<div className="gui-queue-group">
														{t("After yield")} · {queued.followUp.length}
													</div>
													{queued.followUp.map((msg, i) => (
														<div key={`f-${i}-${msg.slice(0, 12)}`} className="gui-queue-item">
															<span className="gui-queue-item-text" title={msg}>
																{msg}
															</span>
															<button
																type="button"
																className="gui-queue-send"
																title={t("send now")}
																aria-label={t("send now")}
																onClick={() => void sendQueued("followUp", msg, i)}
															>
																<Icon name="arrow-up" className="h-3 w-3" />
															</button>
														</div>
													))}
												</>
											)}
											<div className="gui-queue-panel-actions">
												<button
													type="button"
													className="gui-pane-action !w-auto px-2"
													onClick={() => void popQueued()}
												>
													<Icon name="arrow-go-back" className="h-3 w-3" />
													<span>{t("take back newest")}</span>
												</button>
												<button
													type="button"
													className="gui-pane-action !w-auto px-2"
													onClick={() => void clearQueued()}
												>
													<Icon name="delete-bin" className="h-3 w-3" />
													<span>{t("clear queue")}</span>
												</button>
											</div>
										</div>,
									)}
								</>
							)}
						</div>
					) : null
				}
				footerLeft={
					<>
						<AttachMenu
							goalMode={modes?.goalMode?.enabled === true || goalArmed}
							planMode={modes?.planMode === true}
							onToggleGoal={toggleGoalMode}
							onTogglePlan={togglePlanMode}
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
						{/* Pending-message queue chip (TUI /queue parity): visible
						 * while the agent works and messages are queued behind
						 * the current turn; hover shows the queued texts. */}
						{working && queued && queued.count > 0 && (
							<button
								type="button"
								className="gui-queue-chip"
								title={[...queued.steering, ...queued.followUp].join("\n")}
								aria-label={t("queued messages")}
							>
								<Icon name="list-unordered" className="h-3 w-3" />
								<span>{t("queued {count}", { count: String(queued.count) })}</span>
							</button>
						)}
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
						{(modes?.goalMode?.enabled === true || goalArmed) && (
							<button
								type="button"
								className={`gui-mode-chip${goalArmed ? " gui-mode-chip--armed" : " gui-mode-chip--goal"}`}
								title={
									goalArmed
										? t("next message becomes the goal objective")
										: `${t("goal mode")} · ${modes?.goalMode?.objective ?? ""} · ${t("click to end")}`
								}
								onClick={toggleGoalMode}
							>
								<Icon name="target" className="h-3 w-3" />
								<span className="max-w-[200px] truncate">
									{goalArmed ? t("goal") : modes?.goalMode?.objective || t("goal")}
								</span>
								{!goalArmed && <Icon name="close" className="h-2.5 w-2.5 opacity-60" />}
							</button>
						)}
						{modes?.planMode === true && (
							<button
								type="button"
								className="gui-mode-chip"
								title={`${t("plan mode")} · ${t("click to end")}`}
								onClick={togglePlanMode}
							>
								<Icon name="compass-3" className="h-3 w-3" />
								<span>{t("plan")}</span>
								<Icon name="close" className="h-2.5 w-2.5 opacity-60" />
							</button>
						)}
						{canSend && (
							<button
								type="button"
								className={`gui-composer-pill${enhance === "enhanced" ? " gui-composer-pill--done" : ""}`}
								onClick={() => {
									if (enhance === "enhancing") return;
									if (enhance === "enhanced") {
										setEnhance("idle");
										return;
									}
									runEnhance();
								}}
							>
								{enhance === "enhancing" ? (
									<WandSparkles size={11} className="gui-spin" />
								) : (
									<MorphIcon
										icon={enhance === "enhanced" ? CheckIconData : WandSparklesIconData}
										size={11}
										spring="snappy"
										className="gui-composer-morph"
									/>
								)}
								<span>
									{enhance === "enhancing"
										? t("enhancing…")
										: enhance === "enhanced"
											? t("enhanced")
											: t("enhance")}
								</span>
							</button>
						)}
					</>
				}
				footerRight={
					<>
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
						<button
							type="button"
							className={`gui-composer-ico${dictating ? " gui-composer-ico--dictating" : ""}`}
							onClick={() => {
								if (dictating) {
									stopDict.current?.();
									setDictating(false);
									return;
								}
								const stop = startDictation(
									transcript => {
										setText(prev => (prev ? `${prev} ${transcript}` : transcript));
										requestAnimationFrame(() => autosize(taRef.current));
										setDictating(false);
									},
									() => setDictating(false),
									rpc,
								);
								stopDict.current = stop;
								if (stop) setDictating(true);
							}}
							title={t("voice input")}
							aria-label={t("voice input")}
						>
							<Icon name="mic" className="h-3.5 w-3.5" />
						</button>
						{working && (
							<button
								type="button"
								className="gui-composer-ico"
								onClick={() => {
									tapFeedback(2);
									onStop();
								}}
								title={t("stop the current turn")}
								aria-label={t("stop the current turn")}
							>
								<Square size={11} />
							</button>
						)}
						{!working && (
							<button
								type="button"
								className={`gui-composer-ico${retryNone ? " gui-composer-ico--danger" : ""}`}
								onClick={retryLastTurn}
								disabled={retryBusy}
								title={retryNone ? t("nothing to retry") : t("retry last turn")}
								aria-label={t("retry last turn")}
							>
								<Icon name="arrow-go-back" className="h-3.5 w-3.5" />
							</button>
						)}
						<button
							type="button"
							className="gui-composer-send"
							onClick={canSend && enhance !== "enhancing" ? () => send() : undefined}
							disabled={!canSend || enhance === "enhancing"}
							title={working ? t("steer message") : t("send message")}
							aria-label={working ? t("steer message") : t("send message")}
						>
							<SendHorizontal size={14} />
						</button>
					</>
				}
			>
				{slashNotice && (
					<div
						className={`gui-composer-slash-note gui-composer-slash-note--${slashNotice.level}`}
						role="status"
						aria-live="polite"
					>
						<Icon
							name={slashNotice.level === "error" ? "close-circle" : "information"}
							className="h-3.5 w-3.5 shrink-0"
						/>
						<span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{slashNotice.text}</span>
					</div>
				)}
				{quotes.map((q, i) => (
					<div className="gui-quote-card" key={`${i}-${q.slice(0, 32)}`}>
						<div className="gui-quote-text">{q}</div>
						<button
							type="button"
							className="gui-quote-close"
							onClick={() => {
								handledQuoteCountRef.current = 0;
								onQuotesChange(quotes.filter((_, j) => j !== i));
							}}
							title={t("remove quote")}
							aria-label={t("remove quote")}
						>
							<X size={12} />
						</button>
					</div>
				))}
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
					<>
						{hashOpen && hashFilter.length > 0 && (
							<div className="gui-slash-menu" ref={completionMenuRef}>
								{hashFilter.map((e, i) => (
									<button
										key={e.id}
										type="button"
										className={`gui-model-opt${i === hashIdx ? " gui-model-opt--active" : ""}`}
										onMouseDown={ev => ev.preventDefault()}
										onClick={() => insertHash(e.id)}
									>
										<Icon name="chat-1" className="h-4 w-4 shrink-0 text-[var(--color-text-faint)]" />
										<span className="min-w-0 flex-1 truncate font-medium">#{hashLabel(e)}</span>
										{e.cwd && (
											<span className="max-w-[180px] truncate text-[12px] text-[var(--color-text-faint)]">
												{e.cwd}
											</span>
										)}
									</button>
								))}
							</div>
						)}
						{slashOpen && slashFilter.length > 0 && (
							<div className="gui-slash-menu gui-slash-menu--rich" ref={completionMenuRef}>
								<div className="gui-slash-rows">
									{slashFilter.map((c, i) => (
										<SlashRow
											key={c.name}
											item={c}
											active={i === slashIdx}
											onClick={() => insertSlash(c.name)}
										/>
									))}
								</div>
								<div className="gui-slash-footer">{t("slash completion hints")}</div>
							</div>
						)}
						{atOpen && atFilter.length > 0 && (
							<div className="gui-slash-menu" ref={completionMenuRef}>
								{atFilter.map((e, i) => (
									<button
										key={e.path}
										type="button"
										className={`gui-model-opt${i === atIdx ? " gui-model-opt--active" : ""}`}
										onMouseDown={ev => ev.preventDefault()}
										onClick={() => insertAt(e.path)}
									>
										<Icon
											name={e.isDir ? "folder" : "file"}
											className={`h-4 w-4 shrink-0 ${e.isDir ? "text-[var(--color-accent)]" : "text-[var(--color-text-faint)]"}`}
										/>
										<span className="min-w-0 flex-1 truncate">
											<span className="font-medium">{e.name}</span>
											{e.isDir && <span className="ml-1 text-[12px] text-[var(--color-text-faint)]">/</span>}
										</span>
										<span className="max-w-[200px] truncate text-[12px] text-[var(--color-text-faint)]">
											{e.path}
										</span>
									</button>
								))}
							</div>
						)}
					</>,
				)}
			</ComposerFrame>
		</div>
	);
}

/** Compact "resets in …" label from a duration in ms (TUI formatDuration
 *  parity): 2h, 3d5h, 12m — coarse but stable for popover width. */
export function fmtQuotaDuration(ms: number): string {
	const mins = Math.max(0, Math.round(ms / 60000));
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h${mins % 60 ? `${mins % 60}m` : ""}`;
	const days = Math.floor(hours / 24);
	return `${days}d${hours % 24 ? `${hours % 24}h` : ""}`;
}

/** Compact token count (K/M) for the context dialog. */
function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${Math.round(n / 1000)}K`;
	return String(n);
}

/** Snapcompact wire-savings detail lines (TUI /context legend parity):
 *  per-source savings when the model is vision-capable. `usedTokens` feeds
 *  the "next request" projection, mirroring the TUI's
 *  `Math.max(0, usedTokens - savedTokens)`. */
function renderSnapcompactLines(snap: SnapcompactSavingsView, usedTokens: number): ReactNode {
	const lines: ReactNode[] = [];
	if (snap.systemPrompt) {
		const sp = snap.systemPrompt;
		lines.push(
			<div className="gui-context-snap-line" key="sp">
				{sp.applied
					? t("system prompt imaged: {text} text → {frames} frames (saves ~{saved})", {
							text: fmtTokens(sp.textTokens),
							frames: String(sp.frames),
							saved: fmtTokens(sp.savedTokens),
						})
					: t("system prompt stays text ({reason})", {
							reason: t(
								sp.reason === "empty"
									? "reason: empty"
									: sp.reason === "margin"
										? "reason: insufficient savings"
										: "reason: image budget",
							),
						})}
			</div>,
		);
	}
	if (snap.toolResults) {
		const tr = snap.toolResults;
		lines.push(
			<div className="gui-context-snap-line" key="tr">
				{tr.swapped > 0
					? t("tool results: {imaged} imaged (saves ~{saved})", {
							imaged: String(tr.swapped),
							saved: fmtTokens(tr.savedTokens),
						})
					: t("tool results: none imaged ({total} in history)", { total: String(tr.total) })}
			</div>,
		);
	}
	if (snap.savedTokens > 0) {
		lines.push(
			<div className="gui-context-snap-line" key="next">
				{t("next request: ~{tokens} tokens on the wire", {
					tokens: fmtTokens(Math.max(0, usedTokens - snap.savedTokens)),
				})}
			</div>,
		);
	}
	return lines;
}

/** /usage wire shape — mirror of @musepi/pi-ai UsageReport served by the
 *  daemon's usage.reports RPC (TUI /usage parity). Shared with the
 *  empty-state composer, which fetches the same global view session-less. */
export interface UsageAmountView {
	used?: number;
	limit?: number;
	unit?: string;
	usedFraction?: number;
	remainingFraction?: number;
}
export interface UsageLimitView {
	id: string;
	label: string;
	scope?: { accountId?: string; projectId?: string; tier?: string; windowId?: string };
	window?: { id?: string; label?: string; resetsAt?: number; resetLabel?: string };
	amount: UsageAmountView;
	status?: string;
	notes?: string[];
}
export interface UsageReportView {
	provider: string;
	fetchedAt?: number;
	limits: UsageLimitView[];
	resetCredits?: { availableCount: number; credits?: Array<{ expiresAt?: string; status?: string }> };
	notes?: string[];
	metadata?: Record<string, unknown>;
}
/** The credential the live session is actually using (daemon resolves it). */
export interface UsageActiveAccountView {
	provider: string;
	accountId?: string;
	email?: string;
}

/** Title-case a provider id ("openai-codex" → "Openai Codex", TUI parity). */
function usageProviderTitle(provider: string): string {
	return provider
		.split(/[-_]/g)
		.map(part => (part ? part[0]!.toUpperCase() + part.slice(1) : ""))
		.join(" ");
}

/** Account label for one limit row: email → accountId → projectId → "account N". */
function usageAccountLabel(limit: UsageLimitView, report: UsageReportView, index: number): string {
	const meta = report.metadata ?? {};
	const email = typeof meta.email === "string" && meta.email ? meta.email : undefined;
	if (email) return email;
	const accountId =
		(typeof meta.accountId === "string" && meta.accountId ? meta.accountId : limit.scope?.accountId) ?? undefined;
	if (accountId) return accountId;
	const projectId =
		(typeof meta.projectId === "string" && meta.projectId ? meta.projectId : limit.scope?.projectId) ?? undefined;
	if (projectId) return projectId;
	return t("account {count}", { count: String(index + 1) });
}

/** Used fraction 0..1 — mirrors @musepi/pi-ai resolveUsedFraction. */
function usageResolveUsedFraction(limit: UsageLimitView): number | undefined {
	const amount = limit.amount;
	if (amount.usedFraction !== undefined) return amount.usedFraction;
	if (amount.used !== undefined && amount.limit !== undefined && amount.limit > 0) {
		return amount.used / amount.limit;
	}
	if (amount.unit === "percent" && amount.used !== undefined) return amount.used / 100;
	if (amount.remainingFraction !== undefined) return Math.max(0, 1 - amount.remainingFraction);
	return undefined;
}

/** Whether a limit row belongs to the session's active credential (TUI ●). */
function usageLimitIsActive(
	limit: UsageLimitView,
	report: UsageReportView,
	activeAccount: UsageActiveAccountView | null,
): boolean {
	if (!activeAccount || activeAccount.provider !== report.provider) return false;
	const meta = report.metadata ?? {};
	return (
		(activeAccount.accountId !== undefined &&
			(meta.accountId === activeAccount.accountId || limit.scope?.accountId === activeAccount.accountId)) ||
		(activeAccount.email !== undefined && meta.email === activeAccount.email)
	);
}

/** Trailing amount for a limit group ("N% free" / "N accts", TUI parity). */
function usageAggregateAmount(limits: UsageLimitView[]): string {
	const fractions = limits.map(usageResolveUsedFraction).filter((value): value is number => value !== undefined);
	if (fractions.length === limits.length && fractions.length > 0) {
		const sum = fractions.reduce((total, value) => total + value, 0);
		const avgRemaining = Math.max(0, ((limits.length - sum) / limits.length) * 100);
		return t("{percent}% free", { percent: String(Math.round(avgRemaining)) });
	}
	const amounts = limits
		.map(limit => limit.amount)
		.filter(amount => amount.used !== undefined && amount.limit !== undefined && amount.limit > 0);
	if (amounts.length === limits.length && amounts.length > 0) {
		const totalUsed = amounts.reduce((sum, amount) => sum + (amount.used ?? 0), 0);
		const totalLimit = amounts.reduce((sum, amount) => sum + (amount.limit ?? 0), 0);
		const remainingPct = totalLimit > 0 ? Math.max(0, 100 - (totalUsed / totalLimit) * 100) : 0;
		return t("{percent}% free", { percent: String(Math.round(remainingPct)) });
	}
	if (limits.length > 0) {
		const uniqueAccounts = new Set(
			limits
				.map(limit => limit.scope?.accountId)
				.filter((id): id is string => typeof id === "string" && id.length > 0),
		);
		const count = uniqueAccounts.size > 0 ? uniqueAccounts.size : limits.length;
		return t("{count} accts", { count: String(count) });
	}
	return "";
}

/** "resets in 2h" / "resets in 2h–3h" for a limit group (TUI parity). */
function usageResetRange(limits: UsageLimitView[], nowMs: number): string | null {
	const windows = limits
		.map(limit => limit.window)
		.filter(
			(window): window is NonNullable<UsageLimitView["window"]> =>
				window?.resetsAt !== undefined && window.resetsAt > nowMs,
		);
	if (windows.length === 0) return null;
	const offsets = windows.map(window => window.resetsAt!).sort((a, b) => a - b);
	const minReset = offsets[0]!;
	const maxReset = offsets[offsets.length - 1]!;
	if (maxReset - minReset > 60_000) {
		return t("resets in {min}–{max}", {
			min: fmtQuotaDuration(minReset - nowMs),
			max: fmtQuotaDuration(maxReset - nowMs),
		});
	}
	return t("resets in {time}", { time: fmtQuotaDuration(minReset - nowMs) });
}

/** Status tone for a limit's bar + dot ("ok" | "warn" | "err"). */
function usageTone(status: string | undefined): "ok" | "warn" | "err" {
	if (status === "exhausted") return "err";
	if (status === "warning") return "warn";
	return "ok";
}

/** Status tone class for a limit's bar (exhausted/warning → ok). */
function usageStatusTone(status: string | undefined): string {
	return `gui-usage-bar--${usageTone(status)}`;
}

/** One provider section of the /usage card (TUI /usage panel parity).
 *  Collapsible per provider (desktop Reveal standard): the header shows
 *  the aggregate status dot + window count, the detail folds underneath —
 *  a multi-provider /usage card stays scannable without dumping every
 *  window group at once. */
export function UsageProviderSection({
	report,
	activeAccount,
}: {
	report: UsageReportView;
	activeAccount: UsageActiveAccountView | null;
}): ReactNode {
	const [expanded, setExpanded] = useState(false);
	const nowMs = Date.now();
	const limits = report.limits ?? [];
	// Group limits by window (label + window id, TUI parity) so 5h and 7d
	// windows (and any per-tier buckets) render as separate sections.
	const groups = new Map<string, { label: string; windowLabel: string; limits: UsageLimitView[] }>();
	for (const limit of limits) {
		const tier = limit.scope?.tier;
		const label =
			tier && !limit.label.toLowerCase().includes(tier.toLowerCase()) ? `${limit.label} (${tier})` : limit.label;
		const windowId = limit.window?.id ?? limit.scope?.windowId ?? "default";
		const windowLabel = limit.window?.label ?? windowId;
		const key = `${label}|${windowId}`;
		const group = groups.get(key) ?? { label, windowLabel, limits: [] };
		group.limits.push(limit);
		groups.set(key, group);
	}
	const groupList = [...groups.values()].filter(group => group.limits.length > 0);
	const unlimitedReports = limits.length === 0;
	const resets = report.resetCredits;
	const activeHere =
		activeAccount?.provider === report.provider
			? (activeAccount.email ?? activeAccount.accountId ?? undefined)
			: undefined;
	// Aggregate tone across all of the provider's limits → the header dot.
	const allStatuses = limits.map(limit => limit.status).filter(Boolean);
	const aggregateTone = usageTone(
		allStatuses.includes("exhausted") ? "exhausted" : allStatuses.includes("warning") ? "warning" : "ok",
	);

	return (
		<div className="gui-usage-section" key={report.provider}>
			<button
				type="button"
				className="gui-usage-provider-head"
				onClick={() => setExpanded(v => !v)}
				aria-expanded={expanded}
			>
				<span className={`gui-usage-dot gui-usage-dot--${aggregateTone}`} />
				<span className="gui-usage-provider">{usageProviderTitle(report.provider)}</span>
				{groupList.length > 0 && (
					<span className="gui-usage-provider-summary">
						{t("{count} windows", { count: String(groupList.length) })}
					</span>
				)}
				<Icon name="arrow-down" className={`gui-usage-chevron${expanded ? " gui-usage-chevron--open" : ""}`} />
			</button>
			<Reveal open={expanded}>
				<div className="gui-usage-provider-body">
					{activeHere && (
						<div className="gui-usage-note">
							{t("in use by this session: {account}", { account: activeHere })}
						</div>
					)}
					{Array.isArray(report.notes) && report.notes.length > 0 && (
						<div className="gui-usage-note">{report.notes.join(" • ")}</div>
					)}
					{resets && resets.availableCount > 0 && (
						<div className="gui-usage-resets">
							<span className="gui-usage-resets-title">{t("saved rate-limit resets")}</span>
							{(() => {
								const meta = report.metadata ?? {};
								const label =
									(typeof meta.email === "string" && meta.email ? meta.email : undefined) ??
									(typeof meta.accountId === "string" && meta.accountId ? meta.accountId : undefined) ??
									t("account {count}", { count: "1" });
								const isActive =
									activeAccount?.provider === report.provider &&
									((activeAccount.email !== undefined && meta.email === activeAccount.email) ||
										(activeAccount.accountId !== undefined && meta.accountId === activeAccount.accountId));
								const rows: ReactNode[] = [
									<span key="row">
										• {label}: {resets.availableCount}{" "}
										{resets.availableCount === 1 ? t("saved reset") : t("saved resets")}
										{isActive ? ` (${t("active")})` : ""}
									</span>,
								];
								for (const credit of resets.credits ?? []) {
									if (!credit.expiresAt) continue;
									const expiryMs = Date.parse(credit.expiresAt);
									if (Number.isNaN(expiryMs)) continue;
									const remaining = expiryMs - nowMs;
									const date = credit.expiresAt.slice(0, 10);
									rows.push(
										<span key={`${credit.expiresAt}-${date}`}>
											{remaining > 0
												? t("expires in {time}", { time: fmtQuotaDuration(remaining) })
												: t("expired ({date})", { date })}
										</span>,
									);
								}
								return rows;
							})()}
						</div>
					)}
					{groupList.map(group => {
						const statuses = group.limits.map(limit => limit.status).filter(Boolean);
						const aggregate = statuses.includes("exhausted")
							? "exhausted"
							: statuses.includes("warning")
								? "warning"
								: "ok";
						const amount = usageAggregateAmount(group.limits);
						const resetRange = usageResetRange(group.limits, nowMs);
						const windowSuffix =
							group.windowLabel.toLowerCase() === "quota window" ||
							group.label.toLowerCase().includes(group.windowLabel.toLowerCase())
								? ""
								: group.windowLabel;
						return (
							<div className="gui-usage-group" key={group.label + group.windowLabel}>
								<div className="gui-usage-group-head">
									<span className={`gui-usage-dot gui-usage-dot--${usageTone(aggregate)}`} />
									<span className="gui-usage-group-name">{group.label}</span>
									{windowSuffix && <span className="gui-usage-group-window">({windowSuffix})</span>}
									{amount && <span className="gui-usage-amount">{amount}</span>}
								</div>
								{group.limits.map((limit, i) => {
									const fraction = usageResolveUsedFraction(limit);
									const percent = fraction !== undefined ? Math.min(100, Math.max(0, fraction * 100)) : 0;
									const active = usageLimitIsActive(limit, report, activeAccount);
									const resetShort =
										limit.window?.resetsAt !== undefined && limit.window.resetsAt > nowMs
											? t("resets in {time}", { time: fmtQuotaDuration(limit.window.resetsAt - nowMs) })
											: undefined;
									return (
										<div className="gui-quota-row" key={limit.id || `${limit.label}-${i}`}>
											<div className="gui-quota-label">
												<span
													className={`gui-usage-acct-name${active ? " gui-usage-acct-name--active" : ""}`}
												>
													{active ? "● " : ""}
													{usageAccountLabel(limit, report, i)}
												</span>
												{resetShort && <span className="gui-usage-acct-reset">({resetShort})</span>}
											</div>
											<div className="gui-quota-bar">
												<div className="gui-usage-bar-track">
													<div
														className={`gui-usage-bar ${usageStatusTone(limit.status)}`}
														style={{ width: `${percent}%` }}
													/>
												</div>
												<span className="gui-quota-pct">
													{fraction !== undefined ? `${Math.round(fraction * 100)}% used` : "—"}
												</span>
											</div>
										</div>
									);
								})}
								{resetRange && <div className="gui-usage-resetline">{resetRange}</div>}
								{(() => {
									const notes = [...new Set(group.limits.flatMap(limit => limit.notes ?? []))];
									return notes.length > 0 ? <div className="gui-usage-note">{notes.join(" • ")}</div> : null;
								})()}
							</div>
						);
					})}
					{unlimitedReports && (
						<div className="gui-usage-unlimited">
							• {usageAccountLabel({ id: "", label: "", amount: {} }, report, 0)}
							{typeof report.metadata?.planType === "string" && report.metadata.planType
								? ` (${report.metadata.planType})`
								: ""}{" "}
							<span className="gui-usage-note">— {t("no limits")}</span>
						</div>
					)}
				</div>
			</Reveal>
		</div>
	);
}

/** One category row of the /context dialog: glyph + name, tokens, percent
 *  bar. The glyph and color match the board cells (TUI /context legend
 *  parity) so the grid reads without hunting. */
function renderContextCat(label: string, tokens: number, window: number, glyph: string, colorClass: string): ReactNode {
	const percent = window > 0 ? (tokens / window) * 100 : 0;
	const isFree = label === "context free";
	return (
		<div className="gui-context-cat" key={label}>
			<div className="gui-context-cat-label">
				<span className="gui-context-cat-name">
					<span className={`gui-context-cat-glyph ${colorClass}`}>{glyph}</span>
					{t(label as never)}
				</span>
				<span className="gui-context-cat-pct">
					{fmtTokens(tokens)} tokens · {percent.toFixed(1)}%
				</span>
			</div>
			<div className="gui-usage-bar-track">
				<div
					className={`gui-usage-bar ${isFree ? "gui-usage-bar--ok" : "gui-usage-bar--accent"}`}
					style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
				/>
			</div>
		</div>
	);
}

/** TUI /context panel parity (modes/utils/context-usage.ts): the board is a
 *  20×10 = 200 cell grid. Categories render as filled ⛁ glyphs (messages as
 *  ⛃), free space as empty ⛶, the autocompact reserve as ⛝. Cells flow
 *  categories → free → buffer, same as the TUI. */
const CONTEXT_GRID_COLS = 20;
const CONTEXT_GRID_ROWS = 10;
const CONTEXT_GRID_CELLS = CONTEXT_GRID_COLS * CONTEXT_GRID_ROWS;
const CONTEXT_CELL_FILLED = "⛁";
const CONTEXT_CELL_MESSAGES = "⛃";
const CONTEXT_CELL_FREE = "⛶";
const CONTEXT_CELL_BUFFER = "⛝";

function renderContextGrid(breakdown: ContextBreakdownView, autoCompactBufferTokens = 0): ReactNode {
	const total = Math.max(1, breakdown.contextWindow);
	const cells = CONTEXT_GRID_CELLS;
	const cats: Array<{ n: number; cls: string; glyph: string }> = [
		{ n: breakdown.systemPromptTokens, cls: "gui-context-cell--system", glyph: CONTEXT_CELL_FILLED },
		{ n: breakdown.systemToolsTokens, cls: "gui-context-cell--tools", glyph: CONTEXT_CELL_FILLED },
		{ n: breakdown.systemContextTokens, cls: "gui-context-cell--context", glyph: CONTEXT_CELL_FILLED },
		{ n: breakdown.skillsTokens, cls: "gui-context-cell--skills", glyph: CONTEXT_CELL_FILLED },
		{ n: breakdown.messagesTokens, cls: "gui-context-cell--messages", glyph: CONTEXT_CELL_MESSAGES },
	];
	// TUI /context parity: every non-zero category occupies AT LEAST one
	// cell (Math.max(1, …)) — plain rounding drops small-but-present
	// categories (system prompt / skills / messages) to zero.
	const tokensPerCell = total / cells;
	const ratioCells = (tokens: number): number => (tokens <= 0 ? 0 : Math.max(1, Math.round(tokens / tokensPerCell)));
	const counts = cats.map(c => ratioCells(c.n));
	// Autocompact reserve cells come AFTER free space (TUI order); free fills
	// the remainder so the board sums to exactly 200.
	const bufferCount =
		autoCompactBufferTokens > 0 ? Math.max(1, Math.round(autoCompactBufferTokens / tokensPerCell)) : 0;
	let used = counts.reduce((a, b) => a + b, 0) + bufferCount;
	// Over-allocation (small windows where the at-least-one rule overruns):
	// trim from the LARGEST categories first so the board never overflows.
	if (used > cells) {
		const idx = counts.map((_, i) => i).sort((a, b) => counts[b]! - counts[a]!);
		for (const i of idx) {
			if (used <= cells) break;
			if (counts[i]! > 1) {
				counts[i] = counts[i]! - 1;
				used--;
			}
		}
	}
	const free = Math.max(0, cells - used);
	const cellList: Array<{ glyph: string; cls: string }> = [];
	for (let i = 0; i < cats.length; i++) {
		for (let j = 0; j < (counts[i] ?? 0); j++) cellList.push({ glyph: cats[i]!.glyph, cls: cats[i]!.cls });
	}
	for (let j = 0; j < free; j++) cellList.push({ glyph: CONTEXT_CELL_FREE, cls: "gui-context-cell--free" });
	for (let j = 0; j < bufferCount; j++) cellList.push({ glyph: CONTEXT_CELL_BUFFER, cls: "gui-context-cell--buffer" });
	return (
		<div className="gui-context-grid" role="img" aria-label="Context window visualization">
			{Array.from({ length: CONTEXT_GRID_ROWS }, (_, r) => (
				<div className="gui-context-grid-row" key={r}>
					{Array.from({ length: CONTEXT_GRID_COLS }, (_, c) => {
						const cell = cellList[r * CONTEXT_GRID_COLS + c];
						return cell ? (
							// Anonymous visual cells — index is identity.
							// biome-ignore lint/suspicious/noArrayIndexKey: grid cells
							<span key={c} className={`gui-context-cell ${cell.cls}`}>
								{cell.glyph}
							</span>
						) : null;
					})}
				</div>
			))}
		</div>
	);
}
