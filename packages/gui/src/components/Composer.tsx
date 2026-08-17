import { Check as CheckIconData, WandSparkles as WandSparklesIconData } from "lucide";
import { SendHorizontal, Square, WandSparkles, X } from "lucide-react";
import { MorphIcon } from "morphicons/react";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n/index.js";
import { ComposerFrame } from "../lib/composer-frame";
import type { PetMood } from "../lib/pet";
import type { RpcClient } from "../lib/rpc";
import { sessionAccentHex } from "../lib/session-accent";
import { sfxFor } from "../lib/sfx";
import { useFloatingMenu } from "../lib/use-floating-menu";
import { startDictation } from "../lib/voice";
import { Icon } from "../vendor/oc-icons";
import { AttachMenu } from "./AttachMenu";
import { autosize, MIN_ROWS } from "./composer-autosize";
import { ContextRing } from "./ContextRing";
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
	/** Quoted message text to prepend (ZCode 引用回复). */
	pendingQuote?: string | null;
	onQuoteConsumed?(): void;
	/** User-message edit: load text into the composer. */
	pendingEdit?: string | null;
	onEditConsumed?(): void;
	onSetThinking?(level: ThinkingLevel | null): void;
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
 * Prompt-enhancement seam (aicss AI Agent Input parity). The component only
 * depends on this resolving to the improved prompt; wire a real model call
 * here when a backend is available. Without one, the state machine still
 * runs (idle → enhancing → enhanced) so the working states are real.
 */
async function enhancePrompt(prompt: string): Promise<string> {
	await new Promise(resolve => setTimeout(resolve, 1100));
	return prompt;
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
 * either the braille spinner or the pulsing orb; the label effect is the
 * shimmer sweep, the KITT eye sweep, or plain. The sweep color picks the
 * default tone (text-colored bright stop, shimmer-like) or the accent
 * color — applies to both the shimmer and KITT sweeps. */
export type AgentStatusEffect = "shimmer" | "kitt" | "plain";
export type AgentStatusIndicator = "braille" | "orb";
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
		if (i === "orb" || i === "braille") indicator = i;
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
	thinkingCeiling,
	thinkingEfforts,
	pendingQuote,
	onQuoteConsumed,
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
	const slashIdx = useRef(0);
	// "@" completion (TUI/ZCode parity): @ = files & folders from the
	// workspace tree scan (workspace.tree), NOT agents.
	const [atOpen, setAtOpen] = useState(false);
	const [atQuery, setAtQuery] = useState("");
	const [atEntries, setAtEntries] = useState<{ name: string; path: string; isDir: boolean; depth: number }[] | null>(
		null,
	);
	const atIdx = useRef(0);
	// "#" completion (insert a session reference): lists session.list, with
	// titles resolved from session.tree labels (fallback: cwd basename).
	const [hashOpen, setHashOpen] = useState(false);
	const [hashQuery, setHashQuery] = useState("");
	const [hashSessions, setHashSessions] = useState<
		{ id: string; timestamp?: string; messageCount?: number; cwd?: string }[] | null
	>(null);
	const [hashLabels, setHashLabels] = useState<Map<string, string>>(new Map());
	const hashIdx = useRef(0);
	const [dictating, setDictating] = useState(false);

	// ── Chat prefs (openchamber parity, shared with the chat settings) ──
	const draftEnabled = (): boolean => {
		try {
			return localStorage.getItem("omp-gui-chat-draft") !== "0";
		} catch {
			return true;
		}
	};
	const spellcheckEnabled = (): boolean => {
		try {
			return localStorage.getItem("omp-gui-chat-spellcheck") === "1";
		} catch {
			return false;
		}
	};
	// Draft persistence (persistDraft parity): restore the per-session
	// draft when the composer mounts (only into an EMPTY box — quote/edit
	// content must not be clobbered), and save every change; submitting
	// clears the box, which empties the draft through the same effect.
	useEffect(() => {
		if (!draftEnabled()) return;
		try {
			const draft = localStorage.getItem(`omp-gui-draft:${sessionId}`);
			if (draft) setText(prev => (prev.length === 0 ? draft : prev));
		} catch {
			// localStorage unavailable — draft stays in memory only
		}
	}, [sessionId]);
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
		if (!draftEnabled()) return;
		try {
			if (text.length > 0) localStorage.setItem(`omp-gui-draft:${sessionId}`, text);
			else localStorage.removeItem(`omp-gui-draft:${sessionId}`);
		} catch {
			// ignore
		}
	}, [text, sessionId]);

	// ── Goal / plan mode + todo progress (TUI /goal /plan parity) ─────────
	const [modes, setModes] = useState<{
		goalMode: { enabled: boolean; objective?: string; status?: string } | null;
		planMode: boolean;
		todo: {
			name: string;
			done: number;
			total: number;
			tasks: { content: string; status: string; blocker?: string }[];
		}[];
	} | null>(null);
	const [todoOpen, setTodoOpen] = useState(false);
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
	const stopDict = useRef<(() => void) | null>(null);

	// ── Context-window usage (usage ring) ─────────────────────────────────
	const [contextUsage, setContextUsage] = useState<{
		tokens: number;
		contextWindow: number;
		percent: number;
	} | null>(null);
	useEffect(() => {
		if (!rpc || !sessionId) return;
		let disposed = false;
		const tick = (): void => {
			void rpc
				.request<{ tokens: number; contextWindow: number; percent: number } | null>("session.contextUsage", {
					sessionId,
				})
				.then(usage => {
					if (disposed) return;
					// Value-compare: skip the setState (and the re-render)
					// when the ring's numbers did not move.
					setContextUsage(prev =>
						usage && prev && prev.tokens === usage.tokens && prev.percent === usage.percent ? prev : usage,
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

	// ── Pending-message queue (TUI /queue parity): while the agent works,
	// sent messages land in the follow-up queue — poll the live count so
	// the composer can show the "queue N" chip. Idle → nothing to show.
	const [queued, setQueued] = useState<{ count: number; steering: string[]; followUp: string[] } | null>(null);
	const [queueOpen, setQueueOpen] = useState(false);
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
	const addImageFiles = (files: File[]): void => {
		const imgs = files.filter(f => f.type.startsWith("image/"));
		if (imgs.length === 0) return;
		for (const f of imgs) {
			const reader = new FileReader();
			reader.onload = () => {
				if (typeof reader.result !== "string") return;
				setAttachments(prev => [
					...prev,
					{ id: attachId.current++, dataUrl: reader.result as string, mimeType: f.type, name: f.name },
				]);
			};
			reader.readAsDataURL(f);
		}
	};

	const slashFilter =
		slashCmds?.filter(
			c =>
				c.name.includes(slashQuery.toLowerCase()) ||
				(c.description ?? "").toLowerCase().includes(slashQuery.toLowerCase()),
		) ?? [];

	const onSlashInput = (value: string): void => {
		// Trigger when the current line starts with "/".
		const lineStart = value.lastIndexOf("\n") + 1;
		const line = value.slice(lineStart);
		if (line.startsWith("/") && line.length >= 1) {
			setSlashQuery(line.length > 1 ? line.slice(1) : "");
			setSlashOpen(true);
			slashIdx.current = 0;
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
			atIdx.current = 0;
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
			hashIdx.current = 0;
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
		setText(`${prefix}#${id} ${rest}`);
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
			addImageFiles(files);
		}
	};

	const onDrop = (e: React.DragEvent): void => {
		const files = [...e.dataTransfer.files];
		if (files.some(f => f.type.startsWith("image/"))) {
			e.preventDefault();
			addImageFiles(files);
		}
	};
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const composingRef = useRef(false);
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

	const send = useCallback((): void => {
		const trimmed = text.trim();
		if (!trimmed && !pendingQuote && attachments.length === 0) return;
		// Delivery semantics MUST match the TUI:
		//  - Enter while the agent works → steering (queued as a steer,
		//    the agent processes it immediately); plain Enter when idle
		//    is a normal prompt (streamingBehavior: steer covers the race).
		//  - "/queue <msg>" / "=> <msg>" → followUp (delivered only AFTER
		//    the current turn yields) — TUI /queue parity. Bare "/queue"
		//    is a no-op (the queue chip shows the state).
		let payload = trimmed;
		let delivery: "steer" | "followUp" | undefined = working ? "steer" : undefined;
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
		onSend(
			pendingQuote ? `> ${pendingQuote.split("\n").join("\n> ")}\n\n${payload}`.trim() : payload,
			attachments.map(a => ({ type: "image" as const, data: a.dataUrl.split(",")[1] ?? "", mimeType: a.mimeType })),
			// Working → steer (TUI Enter parity: processed immediately);
			// "/queue"/"=>" → followUp (after the current turn yields).
			delivery,
		);
		if (pendingQuote) {
			handledQuoteRef.current = null;
			onQuoteConsumed?.();
		}
		setText("");
		setAttachments([]);
		setEnhance("idle");
		sfxFor("send");
	}, [text, onSend, attachments, working, goalArmed, rpc, sessionId, pendingQuote, onQuoteConsumed]);

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		// IME composition: every key (including the confirming Enter) belongs
		// to the editor — never run completion or submit while composing.
		if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) {
			return;
		}
		if (slashOpen && slashFilter.length > 0) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				slashIdx.current = (slashIdx.current + 1) % Math.min(8, slashFilter.length);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				slashIdx.current =
					(slashIdx.current - 1 + Math.min(8, slashFilter.length)) % Math.min(8, slashFilter.length);
				return;
			}
			if (e.key === "Enter") {
				e.preventDefault();
				const pick = slashFilter[slashIdx.current];
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
				atIdx.current = (atIdx.current + 1) % Math.min(8, atFilter.length);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				atIdx.current = (atIdx.current - 1 + Math.min(8, atFilter.length)) % Math.min(8, atFilter.length);
				return;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				const pick = atFilter[atIdx.current];
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
				hashIdx.current = (hashIdx.current + 1) % Math.min(8, hashFilter.length);
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				hashIdx.current = (hashIdx.current - 1 + Math.min(8, hashFilter.length)) % Math.min(8, hashFilter.length);
				return;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				const pick = hashFilter[hashIdx.current];
				if (pick) insertHash(pick.id);
				return;
			}
			if (e.key === "Escape") {
				setHashOpen(false);
				return;
			}
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
		void enhancePrompt(text)
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

	// ZCode 引用回复: the quoted text renders as a card above the input
	// (not raw `> ` text pasted into the box). The ref-guard makes the focus
	// effect run exactly once per incoming quote; the card stays until the
	// message is sent or the close button dismisses it.
	const handledQuoteRef = useRef<string | null>(null);
	useEffect(() => {
		if (pendingQuote == null || handledQuoteRef.current === pendingQuote) return;
		handledQuoteRef.current = pendingQuote;
		requestAnimationFrame(() => {
			taRef.current?.focus();
			autosize(taRef.current);
		});
	}, [pendingQuote, onQuoteConsumed]);

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
							{todoOpen && (
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
												</div>
											))}
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
										className={`gui-queue-chip${queueOpen ? " gui-queue-chip--open" : ""}`}
										aria-expanded={queueOpen}
										onClick={() => setQueueOpen(v => !v)}
									>
										<Icon name="list-unordered" className="h-3 w-3" />
										<span>{t("queued {count}", { count: String(queued.count) })}</span>
									</button>
									{queueOpen && (
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
							onPickImages={files => addImageFiles(files)}
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
						<ModelSelector rpc={rpc} sessionId={sessionId} presetId={presetModelId} />
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
								onClick={onStop}
								title={t("stop the current turn")}
								aria-label={t("stop the current turn")}
							>
								<Square size={11} />
							</button>
						)}
						<button
							type="button"
							className="gui-composer-send"
							onClick={canSend && enhance !== "enhancing" ? send : undefined}
							disabled={!canSend || enhance === "enhancing"}
							title={working ? t("steer message") : t("send message")}
							aria-label={working ? t("steer message") : t("send message")}
						>
							<SendHorizontal size={14} />
						</button>
					</>
				}
			>
				{pendingQuote && (
					<div className="gui-quote-card">
						<div className="gui-quote-text">{pendingQuote}</div>
						<button
							type="button"
							className="gui-quote-close"
							onClick={() => {
								handledQuoteRef.current = null;
								onQuoteConsumed?.();
							}}
							title={t("remove quote")}
							aria-label={t("remove quote")}
						>
							<X size={12} />
						</button>
					</div>
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
							<div className="gui-slash-menu">
								{hashFilter.slice(0, 8).map((e, i) => (
									<button
										key={e.id}
										type="button"
										className={`gui-model-opt${i === hashIdx.current ? " gui-model-opt--active" : ""}`}
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
							<div className="gui-slash-menu gui-slash-menu--rich">
								<div className="gui-slash-rows">
									{slashFilter.slice(0, 8).map((c, i) => (
										<SlashRow
											key={c.name}
											item={c}
											active={i === slashIdx.current}
											onClick={() => insertSlash(c.name)}
										/>
									))}
								</div>
								<div className="gui-slash-footer">{t("slash completion hints")}</div>
							</div>
						)}
						{atOpen && atFilter.length > 0 && (
							<div className="gui-slash-menu">
								{atFilter.slice(0, 8).map((e, i) => (
									<button
										key={e.path}
										type="button"
										className={`gui-model-opt${i === atIdx.current ? " gui-model-opt--active" : ""}`}
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
