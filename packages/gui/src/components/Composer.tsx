import { Check as CheckIconData, WandSparkles as WandSparklesIconData } from "lucide";
import { SendHorizontal, Square, WandSparkles, X } from "lucide-react";
import { MorphIcon } from "morphicons/react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n/index.js";
import { ComposerFrame } from "../lib/composer-frame";
import { tapFeedback } from "../lib/haptic";
import { readAutoResizeImages, readFileAsDataURL, resizeImageDataUrl } from "../lib/image-resize";
import type { PetMood } from "../lib/pet";
import type { RpcClient } from "../lib/rpc";
import { sessionAccentHex } from "../lib/session-accent";
import { sfxFor } from "../lib/sfx";
import { useFloatingMenu } from "../lib/use-floating-menu";
import { startDictation } from "../lib/voice";
import { Icon } from "../vendor/oc-icons";
import { AttachMenu } from "./AttachMenu";
import { ContextRing, type SnapcompactSavingsView } from "./ContextRing";
import { autosize, MIN_ROWS } from "./composer-autosize";
import { ModelSelector } from "./ModelSelector";
import { PetSprite, usePet } from "./PetSprite";
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
}

type EnhanceState = "idle" | "enhancing" | "enhanced";

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
async function enhancePrompt(
	prompt: string,
	rpc: RpcClient | null,
	sessionId: string | null,
): Promise<string> {
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
	const timer = useRef<number | null>(null);
	useEffect(() => {
		if (working) {
			setPhase("thinking");
			if (timer.current !== null) {
				clearTimeout(timer.current);
				timer.current = null;
			}
		} else if (phase === "thinking") {
			setPhase("done");
			timer.current = window.setTimeout(() => setPhase("idle"), 1500);
		}
		return () => {
			if (timer.current !== null) clearTimeout(timer.current);
		};
	}, [working, phase]);
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
		snapcompact?: SnapcompactSavingsView | null;
	} | null>(null);
	useEffect(() => {
		if (!rpc || !sessionId) return;
		let disposed = false;
		const tick = (): void => {
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
					if (disposed) return;
					// Value-compare: skip the setState (and the re-render)
					// when the ring's numbers did not move.
					setContextUsage(prev =>
						usage && prev && prev.tokens === usage.tokens && prev.percent === usage.percent
							? prev.snapcompact?.savedTokens === usage.snapcompact?.savedTokens
								? prev
								: usage
							: usage,
					);
				})
				.catch(() => {});
		};
		tick();
		// Same 3s cadence + visibility pause as the modes poll above.
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
		};
	}, [rpc, sessionId]);

	// ── Manual context compaction (TUI /compact parity) ────────────────────
	// The ring shows usage; this is the escape hatch when it fills up. The
	// engine gates preconditions itself (summarizer model present, context
	// big enough, not already compacting) and throws otherwise — surface
	// that via a transient error state instead of swallowing it.
	const [compactBusy, setCompactBusy] = useState(false);
	const [compactFailed, setCompactFailed] = useState(false);
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
				setCompactFailed(true);
				window.setTimeout(() => setCompactFailed(false), 3000);
			})
			.finally(() => setCompactBusy(false));
	}, [rpc, sessionId, refreshModes]);

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

	const slashFilter =
		slashCmds?.filter(c => {
			const q = slashQuery.toLowerCase();
			// /skill, /skills, /skill: — the user's intent is the skill list:
			// surface every skill command (kind: skill) instead of matching
			// against literal "skills" text (skill:foo doesn't contain it).
			const isSkillQuery = q === "skill" || q === "skills" || q.startsWith("skill:");
			if (isSkillQuery && c.kind === "skill") return true;
			return (
				c.name.includes(q) || (c.description ?? "").toLowerCase().includes(q)
			);
		}) ?? [];

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
		} else if (trimmed.startsWith("/") && !trimmed.startsWith("//") && quotes.length === 0 && attachments.length === 0) {
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
			attachments.map(a => ({ type: "image" as const, data: a.dataUrl.split(",")[1] ?? "", mimeType: a.mimeType })),
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
		sfxFor("send");
		tapFeedback();
	}, [text, onSend, attachments, working, goalArmed, rpc, sessionId, quotes, onQuotesChange, busyEnter]);

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
		if (
			e.key === "Enter" &&
			(e.metaKey || e.ctrlKey) &&
			!e.shiftKey &&
			!e.altKey &&
			!composingRef.current
		) {
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
		<div className={`gui-composer${focused ? " gui-composer--focused" : ""}`}>
			{/* Agent status line — hangs ABOVE the input card, outside the
			 * frame (user: the thinking state belongs here, not inside
			 * the input, not duplicated in the transcript): braille
			 * spinner or orb + label on one line. Shows 思考中… while
			 * working and briefly 思考完毕 when the turn ends. */}
			<AgentStatusLine working={working} sessionKey={sessionId || undefined} {...readStatusPrefs()} />
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
					modes && (todoTotal > 0 || (working && queued != null && queued.count > 0)) ? (
						<div className="gui-mode-row gui-mode-row--status">
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
							</div>
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
										</div>
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
							onSelect={id => {
								if (id) onModelChange?.(id);
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
								compacting={compactBusy || modes?.isCompacting === true}
								compactFailed={compactFailed}
								snapcompact={contextUsage.snapcompact ?? null}
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
