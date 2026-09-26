import type { AssistantMessage, CustomMessageEntry, SessionEntry, ToolResultMessage } from "@musepi/pi-wire";
import { play } from "cuelume";
import { Check as CheckIconData, Copy as CopyIconData } from "lucide";
import { ArrowDown, GitFork, ImageDown, MessageSquare, Pencil, RefreshCw, Undo2, Volume2 } from "lucide-react";
import { MorphIcon } from "morphicons/react";
import { electronBridge } from "../../lib/electron-bridge";

/** Tap the Taptic Engine when the desktop bridge is present (electronAPI
 *  is optional - plain browsers skip it silently). */
function hapticTap(): void {
	try {
		electronBridge()?.haptic?.();
	} catch {
		// bridge unavailable
	}
}

import { useVirtualizer } from "@tanstack/react-virtual";
import { Fragment, memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import type { ActiveTool } from "../../lib/client";
import { fmtDuration, fmtTokens } from "../../lib/format";
import type { ToolRenderHost } from "../../tool-render";
import { ImageLightbox } from "../image-lightbox";
import { BashCard } from "./bash-card";
import type { FileCardItem } from "./FileCards";
import { finalArtifacts } from "./file-artifacts.js";
import type { TurnRenderUnit } from "./render-units";
import { buildToolRuns, type RoundFold, type ToolRunSummary } from "./round-collapse";
import {
	anchorActionAfterContentChange,
	initialFollowing,
	isAtBottom,
	reconcileFollowingForContentAnchor,
	resolveFollowingAfterScroll,
	shouldShowBackToBottom,
	type TimelineUserScrollIntent,
	timelineKeyboardScrollIntent,
	timelineTouchScrollIntent,
	timelineWheelScrollIntent,
} from "./scroll-anchor";
import { ToolCard } from "./ToolCard";
import {
	AdvisorBlock,
	type AdvisorNote,
	AssistantBody,
	compatHostRenderer,
	lastUserMessageTs,
	MsgContent,
	modelLevelMeta,
	msgText,
	RoundFoldHeader,
	readLiveCustomMessage,
	ToolRunLine,
	type TranscriptNodeInjection,
	TtsrBlock,
	TurnHeader,
	transcriptNodeKind,
	UserMsgContent,
	WorkingLine,
} from "./transcript-content";
import { createTurnDeriveCache, deriveTurns } from "./turn-derive.js";

export {
	type MusePiCompatHost,
	msgText,
	type TranscriptNodeInjection,
	transcriptNodeKind,
} from "./transcript-content";

import "./transcript.css";

// M2 entry-level virtualization (0.5.0 P0①, zcode ModelTrajectoryTimeline
// parity — docs/review/0.5.0-transcript-virtualization.md): the transcript
// renders ONLY the rows intersecting the scroller viewport (+overscan)
// through @tanstack/react-virtual, with top/bottom spacers sized from the
// virtualizer's running total, so the scrollbar reflects the FULL loaded
// history and TurnRail jumps mount the target directly (scrollToIndex)
// instead of growing a render window to it. This replaces M1.11's
// grow-only tail window (mem-bench: full-list derive ~200ms/frame at 42k
// entries; the window also only ever grew, so one trip to the top mounted
// all loaded history forever). The per-frame derive cost is bounded by
// turn-derive.ts' incremental per-round cache — completed rounds are never
// re-classified while streaming.

/** Per-kind initial row-height estimates — the virtualizer's pre-measure
 *  guess. Refined per row by measureElement; kept close to reality so the
 *  scrollbar doesn't visibly breathe while scrolling. */
function estimateEntryHeight(e: SessionEntry | undefined): number {
	if (!e) return 48;
	switch (e.type) {
		case "compaction":
			return 36;
		case "model_change":
			return 24;
		case "custom_message":
			return 40;
		case "message": {
			const role = e.message.role;
			if (role === "user") return 72;
			if (role === "assistant") return 96;
			if (role === "toolResult") return 56;
			if (role === "bashExecution") return 40;
			return 48;
		}
		default:
			return 48;
	}
}

/** Top inset for a jump landing: the row must not sit flush against the
 *  scroller's edge (floating status cards / masks live there). */
const JUMP_TOP_INSET = 12;

/** Scroll the entry row carrying `title=<timestamp>` into view and flash it
 *  (jump feedback for the request path and the post-expansion path; the
 *  caller releases bottom-follow before invoking).
 *
 *  Scrolls ONLY the transcript's own scroller: `scrollIntoView` walks every
 *  scrollable ancestor, so a jump used to push the whole shell up and leave the
 *  target half-hidden under the top chrome (user: 轨迹跳转后界面上移被遮挡). */
function jumpFlashRow(root: HTMLElement | null, timestamp: string): void {
	const el = root?.querySelector<HTMLElement>(`[title="${CSS.escape(timestamp)}"]`);
	if (!el) return;
	const scroller = root?.closest<HTMLElement>(".gui-transcript") ?? null;
	if (scroller) {
		const offset =
			el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - JUMP_TOP_INSET;
		scroller.scrollTo({ top: Math.max(0, offset), behavior: "smooth" });
	} else {
		el.scrollIntoView({ block: "start", behavior: "smooth" });
	}
	el.classList.remove("tr-flash-highlight");
	// rAF so the class re-add restarts the animation on consecutive jumps.
	requestAnimationFrame(() => {
		el.classList.add("tr-flash-highlight");
		window.setTimeout(() => el.classList.remove("tr-flash-highlight"), 1300);
	});
}

export interface TranscriptAnchor {
	/** Entry id of the first visible row at capture time. */
	key: string;
	/** The row's distance below the viewport top, px (negative = scrolled
	 *  partially past it). Restored verbatim after the prepend. */
	offset: number;
}

export interface TranscriptAnchorCtl {
	capture(): TranscriptAnchor | null;
	restore(anchor: TranscriptAnchor): void;
}

export interface TranscriptProps {
	entries: readonly SessionEntry[];
	/** Branch-tree source, when it differs from `entries`. The GUI renders the
	 *  ACTIVE PATH only (off-path siblings and the tail beyond the branch leaf
	 *  leave the transcript but stay on the tree), while the layer-1 branch bar
	 *  must still list those off-path siblings — deriving its children from the
	 *  rendered rows left the expanded switcher empty: the bar showed
	 *  "4 branches" (the count comes from the caller's full map) and opened to
	 *  nothing. Defaults to `entries` for callers that render everything. */
	branchEntries?: readonly SessionEntry[];
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	working: boolean;
	/** Frozen round durations by final assistant message timestamp (ms),
	 *  recorded at agent_end — each completed round's total stays visible
	 *  under its final message (craft-agents TaskActionMenu freeze parity). */
	roundDurations?: ReadonlyMap<number, number>;
	/** Current session thinking level (SessionState.thinkingLevel — the
	 *  auto-classified or user-picked effort). Shown beside the per-round
	 *  work timer as `model · level` (auto-thinking transparency). */
	thinkingLevel?: string;
	/** Session model ("provider/modelId") — the M1 turn header's per-turn
	 *  model fallback for turns before any `model_change` row. */
	model?: string;
	compact?: boolean; // dense variant for the agent drawer
	/** Sub-session drill-down capabilities forwarded to tool renderers. */
	host?: ToolRenderHost;
	/** Gutter replacement (ZCode: avatars instead of 宿主/代理 labels). */
	userGutter?: ReactNode;
	agentGutter?: ReactNode;
	/** User messages render as plain text instead of markdown
	 *  (openchamber userMessageRendering parity). */
	userPlain?: boolean;
	/** Empty-state replacement (mobile welcome hint): rendered in place of
	 *  the bare "no activity yet" line when the transcript has nothing. */
	emptySlot?: ReactNode;
	/** Long user messages clamp to two lines with an expand toggle
	 *  (openchamber collapsibleUserMessages parity). */
	collapseLongUserMessages?: boolean;
	/** Completed-round activity folds default EXPANDED (openchamber
	 *  activityDefaultState "expanded" parity) — default false (collapsed,
	 *  ZCode behavior). User toggles per round still win either way. */
	defaultRoundFoldExpanded?: boolean;
	/** 工具调用汇总 (Kimi parity, default ON): within a turn, stretches of ≥2
	 *  consecutive work rows summarize into ONE category-aggregated line
	 *  (`读取了 3 个文件 · 运行了 2 个命令`, round-collapse.buildToolRuns);
	 *  click re-expands the run. false renders every tool card 现状逐条. */
	toolCallSummary?: boolean;
	/** TUI display.smoothStreaming parity: false renders streamed text
	 *  without the character-level reveal (also applied via the
	 *  `gui-chat-no-smooth` html class in the desktop GUI). */
	smoothStreaming?: boolean;
	/** Codex 编辑预览 parity: open an image in the host's drawing board
	 *  (the transcript lightbox's edit button). Optional — hides the
	 *  button in hosts without a board. */
	onEditImage?(src: string): void;
	/** Session identity. A CHANGE re-locks the bottom and jumps to the latest
	 *  position: the transcript stays mounted across sessions, and the
	 *  following flag only ever loosens on user scrolling, so an opened
	 *  session used to inherit
	 *  the previous scroll offset and render at its very first rows. */
	sessionKey?: string;
	/** TUI display.hideToolActivity parity: suppress model-initiated tool
	 *  call cards and running tail tools from the transcript. */
	hideToolActivity?: boolean;
	/** TUI display.showTokenUsage parity: show the per-turn token usage row
	 *  under settled assistant messages. */
	showTokenUsage?: boolean;
	/** TUI display.collapseCompacted parity: fold pre-compaction history
	 *  behind the first compaction divider. */
	collapseCompacted?: boolean;
	/** TUI display.taskCardStyle parity: "classic" swaps the swarm member
	 *  grid card for the plain tool-call card. */
	taskCardStyle?: "swarm" | "classic";
	/** TUI colorBlindMode parity: diff additions render blue instead of
	 *  green (root gets `data-colorblind`). */
	colorBlind?: boolean;
	/** Quote-a-message into the composer (ZCode 引用回复). */
	onQuote?(text: string): void;
	/** Edit: truncate to this message and restore its text (edit-and-reconverse). */
	onEdit?(messageId: string, text: string): void;
	/** Retry: truncate the session to before the USER message that produced
	 *  this assistant reply, then re-send it (TUI /retry parity — the old
	 *  reply goes into the revert backup and is restorable). */
	onRetry?(messageId: string, text: string): void;
	/** Revert (撤回): truncate the session to before this user message. */
	onRevert?(messageId: string, text: string): void;
	/** Fork (分叉): copy the session truncated at this message into a NEW
	 *  session (non-destructive — the original is untouched). user messages
	 *  re-answer via backfilled `text`; assistant/toolResult nodes pass
	 *  `includeTarget: true` to keep the node and continue from it. */
	onFork?(messageId: string, text: string | undefined, includeTarget?: boolean): void;
	/** Lazy history backfill (kimi/DSH parity): fires when the tail window
	 *  is fully expanded AND the user keeps scrolling up — the caller pages
	 *  the next older chunk from session.history and prepends it. */
	onLoadOlder?(): void;
	/** True while the caller is paging the next older chunk — the top
	 *  spacer shows a shimmer so the wait reads as loading, not emptiness. */
	loadingOlder?: boolean;
	/** Prepend anchoring (key-based): the caller captures the first visible
	 *  row before paging older history via session.history and restores it
	 *  after the prepend commits. Immune to scrollHeight drift from tail
	 *  streaming and estimate corrections — the old scrollHeight-delta
	 *  compensation jumped blindly into unmeasured space (multi-thousand-px
	 *  yanks) and triggered measurement-correction cascades. */
	anchorCtlRef?: { current: TranscriptAnchorCtl | null };
	/** Jump request (message tree / trajectory tree / canvas jumps): when
	 *  `nonce` advances, expand the tail window (and the compaction fold)
	 *  until the target row mounts, then scroll it into view with the
	 *  flash highlight. Long sessions previously scrolled to the top
	 *  spacer instead — the target stayed unmounted (user: 轨迹跳转不能
	 *  合理处理). */
	jumpRequest?: { timestamp: string; nonce: number } | null;
	/** Read an assistant reply aloud (TTS). */
	onSpeak?(text: string, messageId?: string): void;
	/** 当前朗读中的消息 id(播放状态行级指示;null = 无朗读)。 */
	speakingId?: string | null;
	/** 停止朗读(点击播放中的行按钮触发)。 */
	onStopSpeak?(): void;
	/** Save an assistant reply as an image to the clipboard (openchamber). */
	onSaveImage?(text: string): void;
	/** Branch topology (session-tree nav, layer-1): children counts per
	 *  entry id (from buildMessageTree) + the active path id set. When
	 *  provided, messages with MULTIPLE children render a branch bar
	 *  ("此节点有 N 个分支") that expands sibling switches; entries OFF the
	 *  active path collapse into it. Absent/undefined = plain linear
	 *  rendering (web shell, no branches) — zero behavior change. */
	branchInfo?: {
		childCount: ReadonlyMap<string, number>;
		activePathIds: ReadonlySet<string>;
		onSwitchBranch?(leafEntryId: string): void;
	};
	/** transcript.node seat 注入 (DSH `conversation.chat.node` analog):
	 *  host 提供按条目派发的渲染器,按 `transcriptNodeKind(entry)` 分发,
	 *  可用 `children`(内建渲染)增强/追加;缺省 -> 仅内建渲染(inert)。
	 *  调用方 MUST memoize(身份参与 EntryRow memo 比较)。 */
	renderTranscriptNode?: (node: TranscriptNodeInjection) => ReactNode;
}

/** Clock stamp for a branch-switch row. Sibling attempts of one prompt share
 *  a label ("谢谢" ×4), so the switcher needs a second axis to tell them
 *  apart — the entry's own local time does exactly that. */
function branchClock(ts: unknown): string | undefined {
	if (typeof ts !== "string" || ts.length === 0) return undefined;
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return undefined;
	return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Layer-1 branch bar: rendered under a message that has MULTIPLE
 *  children in the entry tree. Collapsed: a thin divider line with the
 *  branch count; expanded (click): sibling switch buttons. The active
 *  child is highlighted. Zero branches → never rendered. */
export function BranchBar({
	count,
	childrenLabels,
	activeChildId,
	onPick,
}: {
	count: number;
	childrenLabels: Array<{ id: string; label: string; time?: string }>;
	activeChildId?: string | null;
	onPick(childId: string): void;
}): ReactNode {
	const [open, setOpen] = useState(false);
	return (
		<div className="tr-branch">
			<button type="button" className="tr-branch-bar" onClick={() => setOpen(v => !v)} aria-expanded={open}>
				<span className="tr-branch-line" aria-hidden />
				<span className="tr-branch-count">{t("this node has {count} branches", { count: String(count) })}</span>
				<span className="tr-branch-line" aria-hidden />
			</button>
			{/* Kept mounted while closed so BOTH directions animate (the list is
			 *  max-height driven in CSS); `inert` keeps the hidden rows out of
			 *  the tab order. */}
			<div
				className={`tr-branch-list${open ? " tr-branch-list--open" : ""}`}
				role="listbox"
				aria-label={t("switch branch")}
				aria-hidden={!open}
				inert={!open}
			>
				{childrenLabels.map(c => (
					<button
						key={c.id}
						type="button"
						role="option"
						aria-selected={c.id === activeChildId}
						className={`tr-branch-item${c.id === activeChildId ? " tr-branch-item--active" : ""}`}
						onClick={() => {
							setOpen(false);
							onPick(c.id);
						}}
					>
						<GitFork size={11} />
						<span className="tr-branch-item-text">{c.label || "…"}</span>
						{c.time && <span className="tr-branch-item-time">{c.time}</span>}
						{c.id === activeChildId && <span className="tr-branch-active-dot" aria-hidden />}
					</button>
				))}
			</div>
		</div>
	);
}

function Row({
	kind,
	id,
	gutter,
	title,
	turnStart,
	children,
	onQuote,
	onEdit,
	onRetry,
	onRevert,
	onFork,
	onSpeak,
	speaking,
	onStopSpeak,
	onSaveImage,
	quoteText,
	retryTarget,
}: {
	kind: "user" | "assistant" | "custom" | "marker" | "bash";
	id?: string;
	gutter: ReactNode;
	title?: string;
	/** 该行是会话轮次的起始行(user 提示或 display:true 的顾问笔记——
	 *  与 isTurnStart 同口径)。导航条 scroll-spy 靠它把顾问轮纳入
	 *  当前轮高亮(顾问行是 tr-row--custom,不进 .tr-row--user 查询)。 */
	turnStart?: boolean;
	children: ReactNode;
	onQuote?(text: string): void;
	/** Edit: truncate to this message and restore its text (edit-and-reconverse). */
	onEdit?(messageId: string, text: string): void;
	onRetry?(messageId: string, text: string): void;
	/** Revert (撤回): truncate the session to before this user message. */
	onRevert?(messageId: string, text: string): void;
	/** Fork (分叉): copy the session truncated at this message into a NEW
	 *  session (non-destructive — the original is untouched). user messages
	 *  re-answer via backfilled `text`; assistant/toolResult nodes pass
	 *  `includeTarget: true` to keep the node and continue from it. */
	onFork?(messageId: string, text: string | undefined, includeTarget?: boolean): void;
	onSpeak?(text: string, messageId?: string): void;
	/** 该行朗读中(播放状态指示)。 */
	speaking?: boolean;
	/** 停止朗读(播放中的行点击)。 */
	onStopSpeak?(): void;
	/** The user message whose reply this row is — retry truncates to it and
	 *  re-sends it (assistant rows only). */
	retryTarget?: { id: string; text: string } | null;
	/** Save-as-image: hands over the rendered message body element so the
	 *  caller rasterizes the REAL markdown DOM (openchamber toPng parity)
	 *  instead of re-drawing plain text. May return a promise — the row
	 *  shows a spinner while it runs, then morphs to a check on success. */
	onSaveImage?(text: string, element: HTMLElement | null): void | Promise<void>;
	/** Pre-extracted plain text for actions (data-driven, not DOM walk). */
	quoteText?: string;
}): ReactNode {
	const [copied, setCopied] = useState(false);
	const copy = async (): Promise<void> => {
		if (!quoteText) return;
		try {
			if (kind === "assistant" && bodyRef.current && typeof ClipboardItem !== "undefined") {
				// Rich clipboard (openchamber copyMarkdownToClipboard parity):
				// markdown source as text/plain + the LIVE rendered HTML, so
				// pasting into rich editors keeps headings/bold/code. Tool
				// and thinking cards are stripped — copy is the answer text.
				const clone = bodyRef.current.cloneNode(true) as HTMLElement;
				clone.querySelectorAll<HTMLElement>(".tv-card, .tr-think, .tr-usage").forEach(el => {
					el.remove();
				});
				const payload: Record<string, Blob> = {
					"text/plain": new Blob([quoteText], { type: "text/plain" }),
					"text/html": new Blob([clone.innerHTML], { type: "text/html" }),
				};
				if (typeof ClipboardItem.supports === "function" && ClipboardItem.supports("text/markdown")) {
					payload["text/markdown"] = new Blob([quoteText], { type: "text/markdown" });
				}
				await navigator.clipboard.write([new ClipboardItem(payload)]);
			} else {
				// User rows copy plain text (openchamber does the same).
				await navigator.clipboard.writeText(quoteText);
			}
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// Rich write unavailable/failed — fall back to plain text.
			try {
				await navigator.clipboard.writeText(quoteText);
			} catch {
				// clipboard unavailable
			}
		}
	};
	const bodyRef = useRef<HTMLDivElement | null>(null);
	return (
		<div
			className={`tr-row tr-row--${kind}`}
			data-turn-start={turnStart ? "" : undefined}
			data-turn-start-ts={turnStart ? title : undefined}
		>
			<div className="tr-gutter" title={title}>
				{gutter}
			</div>
			<div className="tr-body" ref={bodyRef}>
				{children}
			</div>
			{(onQuote || onEdit || onRetry || onRevert || onSpeak || onSaveImage || quoteText) && kind !== "marker" && (
				<div className="tr-actions">
					{title && (
						<span className="tr-action-time">
							{new Date(title).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
						</span>
					)}
					{onRevert && kind === "user" && id && (
						<button
							type="button"
							className="tr-action"
							title={t("revert message")}
							aria-label={t("revert message")}
							onClick={() => {
								if (quoteText) onRevert(id, quoteText);
							}}
						>
							<Undo2 size={13} />
						</button>
					)}
					{onFork && kind === "user" && id && (
						<button
							type="button"
							className="tr-action"
							title={t("fork session from this message")}
							aria-label={t("fork session from this message")}
							onClick={() => {
								if (quoteText) onFork(id, quoteText);
							}}
						>
							<GitFork size={13} />
						</button>
					)}
					{quoteText && (
						<button
							type="button"
							className="tr-action"
							title={t("copy message")}
							aria-label={t("copy message")}
							onClick={() => {
								play("press");
								hapticTap();
								void copy();
							}}
						>
							{/* Morphing Copy↔Check confirms the action (morphicons +
							 * cuelume feedback per design doc §5b). */}
							<MorphIcon icon={copied ? CheckIconData : CopyIconData} size={13} spring="snappy" />
						</button>
					)}
					{onEdit && kind === "user" && id && (
						<button
							type="button"
							className="tr-action"
							title={t("edit and resend")}
							aria-label={t("edit and resend")}
							onClick={() => {
								if (quoteText) onEdit(id, quoteText);
							}}
						>
							<Pencil size={13} />
						</button>
					)}
					{onRetry && kind === "assistant" && retryTarget && (
						<button
							type="button"
							className="tr-action"
							title={t("retry")}
							aria-label={t("retry")}
							onClick={() => {
								// Retry = regenerate THIS reply: truncate to the
								// user message that produced it and re-send that
								// user message (NOT this assistant text — sending
								// the reply back as a new user message was a bug).
								onRetry(retryTarget.id, retryTarget.text);
							}}
						>
							<RefreshCw size={13} />
						</button>
					)}
					{onFork && kind === "assistant" && id && (
						<button
							type="button"
							className="tr-action"
							title={t("fork session from this message")}
							aria-label={t("fork session from this message")}
							onClick={() => {
								play("press");
								hapticTap();
								// includeTarget: keep THIS reply as the new
								// session's last record and continue from it
								// with a fresh prompt (TUI navigateTree parity
								// for non-user nodes).
								onFork(id, undefined, true);
							}}
						>
							<GitFork size={13} />
						</button>
					)}
					{onSpeak && kind === "assistant" && (
						<button
							type="button"
							className={`tr-action${speaking ? " tr-action--speaking" : ""}`}
							title={speaking ? t("read aloud stop") : t("read aloud")}
							aria-label={speaking ? t("read aloud stop") : t("read aloud")}
							onClick={() => {
								play("press");
								hapticTap();
								if (speaking) {
									onStopSpeak?.();
								} else if (quoteText) {
									onSpeak(quoteText, id);
								}
							}}
						>
							<Volume2 size={13} />
						</button>
					)}
					{onSaveImage && kind === "assistant" && (
						/* Opens the 保存为图片 export dialog (options + preview);
						 * the dialog's copy button carries the Copy → ✓ morph. */
						<button
							type="button"
							className="tr-action"
							title={t("save as image")}
							aria-label={t("save as image")}
							onClick={() => {
								play("press");
								hapticTap();
								if (quoteText) onSaveImage(quoteText, bodyRef.current);
							}}
						>
							<ImageDown size={13} />
						</button>
					)}
					{onQuote && (
						<button
							type="button"
							className="tr-action"
							title={t("quote and reply")}
							aria-label={t("quote and reply")}
							onClick={() => {
								play("press");
								hapticTap();
								if (quoteText) onQuote(quoteText);
							}}
						>
							<MessageSquare size={13} />
						</button>
					)}
				</div>
			)}
		</div>
	);
}

/** Plain text of a message for the quote/copy/edit/fork/retry actions.
 *  Full length on purpose: the per-message copy button must hand over the
 *  whole message, and edit-and-resend / fork / TTS / save-image all consume
 *  the same text (a cap would silently drop content on long messages). */
interface EntryRowProps {
	entry: SessionEntry;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	host?: ToolRenderHost;
	userGutter?: ReactNode;
	agentGutter?: ReactNode;
	/** True when this row is the live-streaming assistant message. */
	streamingLast?: boolean;
	/** Round start (last user message ts) for the live ticker. */
	runStartTs?: number;
	/** Frozen round duration (ms) — the completed round's total. */
	roundDuration?: number;
	userPlain?: boolean;
	collapseLongUserMessages?: boolean;
	hideToolActivity?: boolean;
	/** 活动 header rendered INSIDE this row's content column (openchamber puts
	 *  TurnActivity in the message body): it inherits the message alignment and
	 *  the row's gutter, so a collapsed turn shows orb + 活动 + answer on ONE line
	 *  instead of the orb floating on a blank row of its own. */
	foldHeader?: ReactNode;
	/** Collapsed 活动 fold: render this row's TEXT blocks only (see AssistantBody). */
	textOnly?: boolean;
	showTokenUsage?: boolean;
	smoothStreaming?: boolean;
	/** display.taskCardStyle parity: "classic" swaps the swarm member grid
	 *  card for the plain tool-call card. */
	taskCardStyle?: "swarm" | "classic";
	/** Turn-final aggregated file artifacts (undefined = no cards). */
	artifacts?: FileCardItem[];
	/** Session thinking level — work-timer `model · level` badge. */
	thinkingLevel?: string;
	onQuote?(text: string): void;
	onEdit?(messageId: string, text: string): void;
	onRetry?(messageId: string, text: string): void;
	onRevert?(messageId: string, text: string): void;
	onFork?(messageId: string, text: string): void;
	onSpeak?(text: string, messageId?: string): void;
	onSaveImage?(text: string, element: HTMLElement | null): void | Promise<void>;
	/** Open the full-size image preview lightbox (transcript-level state). */
	onPreviewImage?(images: { src: string; alt: string }[], index: number): void;
	/** 该行朗读中(播放状态指示)。 */
	speaking?: boolean;
	/** 停止朗读(播放中的行点击)。 */
	onStopSpeak?(): void;
	/** The user message whose reply this assistant row is (retry target). */
	retryTarget?: { id: string; text: string } | null;
	/** transcript.node seat 注入 —— 按条目派发(见 TranscriptProps)。 */
	renderTranscriptNode?: (node: TranscriptNodeInjection) => ReactNode;
}

/** Re-render only when the entry itself or one of its tool pairings changed. */
function entryRowEqual(prev: EntryRowProps, next: EntryRowProps): boolean {
	if (prev.entry !== next.entry || prev.host !== next.host) return false;
	if (prev.userGutter !== next.userGutter || prev.agentGutter !== next.agentGutter) return false;
	if (
		prev.userPlain !== next.userPlain ||
		prev.collapseLongUserMessages !== next.collapseLongUserMessages ||
		prev.streamingLast !== next.streamingLast ||
		prev.runStartTs !== next.runStartTs ||
		prev.roundDuration !== next.roundDuration ||
		prev.hideToolActivity !== next.hideToolActivity ||
		prev.showTokenUsage !== next.showTokenUsage ||
		prev.smoothStreaming !== next.smoothStreaming ||
		prev.taskCardStyle !== next.taskCardStyle
	) {
		return false;
	}
	if (prev.onQuote !== next.onQuote || prev.onEdit !== next.onEdit || prev.onRetry !== next.onRetry) return false;
	if (prev.artifacts !== next.artifacts) return false;
	if (prev.thinkingLevel !== next.thinkingLevel) return false;
	if (prev.onRevert !== next.onRevert || prev.onFork !== next.onFork) return false;
	if (prev.retryTarget !== next.retryTarget) return false;
	if (prev.onSpeak !== next.onSpeak || prev.onSaveImage !== next.onSaveImage) return false;
	if (prev.speaking !== next.speaking || prev.onStopSpeak !== next.onStopSpeak) return false;
	if (prev.onPreviewImage !== next.onPreviewImage) return false;
	if (prev.renderTranscriptNode !== next.renderTranscriptNode) return false;
	const e = next.entry;
	if (e.type !== "message" || e.message.role !== "assistant") return true;
	for (const block of e.message.content) {
		if (block.type !== "toolCall") continue;
		if (prev.results.get(block.id) !== next.results.get(block.id)) return false;
		if (prev.active.get(block.id) !== next.active.get(block.id)) return false;
	}
	return true;
}

/**
 * Body of a session custom message — advisor cards, TTSR warnings, async-job
 * results, IRC relay, collab prompts, and the generic chip fallback. Shared by
 * persisted `custom_message` entries and the live message seam, where the same
 * notes arrive as a message with a custom role.
 *
 * A plain render helper, not a component: a hidden body must surface as `null`
 * so the caller can skip the row's wrapper entirely.
 */
function renderCustomMessage({
	customType,
	content,
	details,
	display,
	timestamp,
	onPreviewImage,
}: {
	customType: string;
	content: CustomMessageEntry["content"];
	details: unknown;
	display: boolean;
	timestamp: string;
	onPreviewImage?(images: { src: string; alt: string }[], index: number): void;
}): ReactNode {
	if (customType === "collab-prompt") {
		const from =
			details !== null && typeof details === "object" && "from" in details && typeof details.from === "string"
				? details.from
				: t("unnamed device");
		return (
			<Row kind="user" gutter={<span className="tr-badge">{from}</span>} title={timestamp}>
				<MsgContent content={content} onPreviewImage={onPreviewImage} />
			</Row>
		);
	}
	if (customType === "ttsr") {
		const rules =
			details !== null && typeof details === "object" && "rules" in details && Array.isArray(details.rules)
				? (details.rules as { name: string; description?: string; content?: string }[])
				: [];
		return (
			<Row kind="custom" gutter="" title={timestamp}>
				<TtsrBlock rules={rules} />
			</Row>
		);
	}
	if (customType === "advisor") {
		// Advisor notes (customType "advisor", display:true): renders the
		// details.notes[] as a distinct-voice card (severity rail + badge).
		// The message content is the model-facing `<advisory>` XML — never
		// surface it; only the clean note text from details.
		const notes =
			details !== null && typeof details === "object" && "notes" in details && Array.isArray(details.notes)
				? (details.notes as AdvisorNote[])
				: [];
		return (
			<Row kind="custom" gutter="" title={timestamp} turnStart>
				<AdvisorBlock notes={notes} />
			</Row>
		);
	}
	if (customType === "async-result") {
		// Background job completion (async-result custom message) —
		// renders as compact "Background job completed" rows, NOT the
		// raw `<system-notice>` content template (the LLM-facing
		// prompt text must never surface to the user). Mirrors the TUI
		// buildAsyncResultBlock: one row per job with id + duration.
		const jobs = asyncResultJobs(details);
		return (
			<Row kind="custom" gutter="" title={timestamp}>
				<div className="tr-async-result" role="status">
					{jobs.map((job, i) => (
						<div key={i} className="tr-async-result-row">
							<span className="tr-async-result-done" aria-hidden>
								✓
							</span>
							<span className="tr-async-result-text">{t("Background job completed")}</span>
							{job.type ? <span className="tr-async-result-tag">[{job.type}]</span> : null}
							<span className="tr-async-result-id">{job.jobId ?? "unknown"}</span>
							{typeof job.durationMs === "number" ? (
								<span className="tr-async-result-dur">({fmtDuration(job.durationMs)})</span>
							) : null}
						</div>
					))}
				</div>
			</Row>
		);
	}
	if (customType === "retry_failure") {
		const attempt =
			details !== null && typeof details === "object" && "attempt" in details && typeof details.attempt === "number"
				? details.attempt
				: undefined;
		return (
			<Row kind="custom" gutter="" title={timestamp}>
				<div className="tr-retry-failure" role="alert">
					<span className="tr-retry-failure-chip">{t("model error")}</span>
					<span className="tr-retry-failure-message">{msgText({ content })}</span>
					{attempt !== undefined && (
						<span className="tr-retry-failure-attempt">
							{t("retry attempt {count}", { count: String(attempt) })}
						</span>
					)}
				</div>
			</Row>
		);
	}
	if (customType.startsWith("irc:")) {
		const from =
			details !== null && typeof details === "object" && "from" in details && typeof details.from === "string"
				? details.from
				: "irc";
		// irc:incoming content is the rendered LLM prompt template
		// (irc-incoming.md) — literal <irc>…</irc> scaffolding plus
		// reply instructions that must not reach the UI. The clean
		// body lives in details.message (mirror the TUI card, which
		// renders card.body = details.message); fall back to content
		// with the wrapper stripped for snapshots without details.
		// relay/autoreply content is already display-shaped
		// ([IRC a → b] header + body), so keep it verbatim.
		const body =
			details !== null && typeof details === "object" && "message" in details && typeof details.message === "string"
				? details.message
				: undefined;
		const shown =
			customType === "irc:incoming"
				? (body ??
					msgText({ content })
						.replace(/^\s*<irc>\s*/i, "")
						.replace(/\s*<\/irc>\s*$/i, ""))
				: content;
		return (
			<Row kind="custom" gutter="" title={timestamp}>
				<div className="tr-irc">
					<span className="tr-irc-from">{from}</span>
					<MsgContent content={shown} onPreviewImage={onPreviewImage} />
				</div>
			</Row>
		);
	}
	if (!display) return null;
	return (
		<Row kind="custom" gutter="" title={timestamp}>
			<div className="tr-custom">
				<span className="tr-chip">{customType}</span>
				<MsgContent content={content} onPreviewImage={onPreviewImage} />
			</div>
		</Row>
	);
}

/** One row of the `async-result` card: a job id + optional kind/label/duration. */
interface AsyncResultJobRow {
	jobId?: string;
	type?: "bash" | "task" | "agnes-video";
	label?: string;
	durationMs?: number;
}

/** Async-job rows carried by an `async-result` custom message (single job on
 *  older frames, `jobs[]` on batched ones). */
function asyncResultJobs(details: unknown): AsyncResultJobRow[] {
	if (details === null || typeof details !== "object") return [{}];
	const jobs = "jobs" in details && Array.isArray(details.jobs) ? details.jobs : undefined;
	if (jobs && jobs.length > 0) return jobs as AsyncResultJobRow[];
	const one: AsyncResultJobRow = {};
	if ("jobId" in details && typeof details.jobId === "string") one.jobId = details.jobId;
	if ("label" in details && typeof details.label === "string") one.label = details.label;
	if ("durationMs" in details && typeof details.durationMs === "number") one.durationMs = details.durationMs;
	if ("type" in details && (details.type === "bash" || details.type === "task" || details.type === "agnes-video")) {
		one.type = details.type;
	}
	return [one];
}

const EntryRow = memo(function EntryRow({
	entry,
	results,
	active,
	host,
	userGutter,
	agentGutter,
	userPlain = false,
	collapseLongUserMessages = false,
	streamingLast = false,
	runStartTs,
	roundDuration,
	hideToolActivity = false,
	foldHeader,
	textOnly = false,
	showTokenUsage = false,
	smoothStreaming = true,
	taskCardStyle = "swarm",
	artifacts,
	thinkingLevel,
	onQuote,
	onEdit,
	onRetry,
	onRevert,
	onFork,
	onSpeak,
	onSaveImage,
	onPreviewImage,
	speaking,
	onStopSpeak,
	retryTarget,
	renderTranscriptNode,
}: EntryRowProps): ReactNode {
	const row = ((): ReactNode => {
		switch (entry.type) {
			case "message": {
				const msg = entry.message;
				// Live custom messages (advisor cards, async-job results, IRC
				// relay) ride the message seam with a custom role and render as
				// the same card a persisted `custom_message` entry does.
				const custom = readLiveCustomMessage(msg);
				if (custom) {
					return renderCustomMessage({
						customType: custom.customType,
						content: custom.content,
						details: custom.details,
						display: custom.display,
						timestamp: new Date(custom.timestamp).toISOString(),
						onPreviewImage,
					});
				}
				switch (msg.role) {
					case "user":
						return (
							<Row
								kind="user"
								id={entry.id}
								gutter={userGutter ?? t("host")}
								title={entry.timestamp}
								turnStart
								onQuote={onQuote}
								onEdit={onEdit}
								onRetry={onRetry}
								onRevert={onRevert}
								onFork={onFork}
								quoteText={msgText(msg)}
							>
								<UserMsgContent
									content={msg.content}
									plain={userPlain}
									collapse={collapseLongUserMessages}
									onPreviewImage={onPreviewImage}
								/>
							</Row>
						);
					case "assistant":
						return (
							<Row
								kind="assistant"
								id={entry.id}
								gutter={agentGutter ?? t("agent")}
								title={entry.timestamp}
								onQuote={onQuote}
								onRetry={onRetry}
								onFork={onFork}
								onSpeak={onSpeak}
								onSaveImage={onSaveImage}
								speaking={speaking}
								onStopSpeak={onStopSpeak}
								quoteText={msgText(msg)}
								retryTarget={retryTarget}
							>
								{foldHeader}
								<AssistantBody
									message={msg}
									results={results}
									active={active}
									pending={streamingLast}
									runStartTs={runStartTs}
									roundDuration={roundDuration}
									host={host}
									hideToolActivity={hideToolActivity}
									textOnly={textOnly}
									showTokenUsage={showTokenUsage}
									smoothStreaming={smoothStreaming}
									taskCardStyle={taskCardStyle}
									artifacts={artifacts}
									thinkingLevel={thinkingLevel}
									onPreviewImage={onPreviewImage}
								/>
							</Row>
						);
					case "bashExecution":
						// User-initiated shell command (! / !! composer parity): the
						// daemon streams the bashExecution message as a wire entry.
						return (
							<Row kind="bash" gutter="&gt;_" title={entry.timestamp}>
								<BashCard message={msg as import("@musepi/pi-wire").BashExecutionMessage} />
							</Row>
						);
					default:
						// toolResult entries are consumed via pairing; developer & unknown roles skipped
						return null;
				}
			}
			case "custom_message":
				return renderCustomMessage({
					customType: entry.customType,
					content: entry.content,
					details: entry.details,
					display: entry.display,
					timestamp: entry.timestamp,
					onPreviewImage,
				});
			case "compaction":
				return (
					<div className="tr-divider" title={entry.shortSummary ?? entry.summary}>
						<span>{t("context compacted · {count} tokens", { count: fmtTokens(entry.tokensBefore) })}</span>
					</div>
				);
			case "branch_summary":
				return (
					<div className="tr-divider" title={entry.summary}>
						<span>{t("branch summary")}</span>
					</div>
				);
			case "model_change":
				// No marker row: the composer's model selector shows the live
				// model, and mid-session switches are just noise in the flow
				// (same treatment as thinking_level_change).
				return null;
			case "thinking_level_change":
				// No marker row: the composer's thinking chip (ChatView) derives
				// the live level from these entries, so a transcript marker is
				// redundant noise — keep model_change (informative) visible.
				return null;
			default:
				// unknown entry types from newer hosts — skip tolerantly
				return null;
		}
	})();
	// No row → no wrapper: daemon-internal bookkeeping entries (tool execution
	// markers, session exit) and the marker-less model/thinking switches must
	// not leave a blank `.tr-entry` line in the transcript.
	if (row == null) return null;
	const kind = transcriptNodeKind(entry);
	// Passive compat slot-host dispatch: when the GUI does not inject
	// renderTranscriptNode (client-core standalone / served compat page),
	// fall back to the daemon-hosted extension registry that the serve
	// entry's compat script populated on window.MusePiCompatHost. Guests in
	// a plain browser have no such registry — built-in rendering stays.
	const compat = renderTranscriptNode ?? compatHostRenderer(kind);
	return (
		<div data-entry-kind={kind} data-entry-id={entry.id} className="tr-entry">
			{compat ? compat({ entry, kind, children: row }) : row}
		</div>
	);
}, entryRowEqual);

export const Transcript = memo(function Transcript(props: TranscriptProps): ReactNode {
	const {
		entries,
		branchEntries,
		stream,
		streamDone,
		activeTools,
		working,
		roundDurations,
		thinkingLevel,
		model,
		compact,
		host,
		userGutter,
		agentGutter,
		emptySlot,
		userPlain = false,
		collapseLongUserMessages = false,
		defaultRoundFoldExpanded = false,
		toolCallSummary = true,
		smoothStreaming = true,
		taskCardStyle = "swarm",
		hideToolActivity = false,
		sessionKey,
		showTokenUsage = false,
		collapseCompacted = false,
		colorBlind = false,
		onQuote,
		onEdit,
		onRetry,
		onRevert,
		onFork,
		onLoadOlder,
		loadingOlder = false,
		anchorCtlRef,
		jumpRequest = null,
		onSpeak,
		onSaveImage,
		onEditImage,
		speakingId,
		onStopSpeak,
		branchInfo,
		renderTranscriptNode,
	} = props;

	const results = useMemo(() => {
		const map = new Map<string, ToolResultMessage>();
		for (const entry of entries) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				map.set(entry.message.toolCallId, entry.message);
			}
		}
		return map;
	}, [entries]);

	// For every assistant reply, the USER message that produced it — the
	// retry action truncates to that message and re-sends it. Built over
	// the FULL entries (not the windowed slice): a reply whose user message
	// scrolled out of the window still retries correctly.
	const retryTargets = useMemo(() => {
		const map = new Map<string, { id: string; text: string }>();
		let lastUser: { id: string; text: string } | null = null;
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role === "user") {
				lastUser = { id: entry.id, text: msgText(entry.message) };
			} else if (entry.message.role === "assistant" && lastUser) {
				map.set(entry.id, lastUser);
			}
		}
		return map;
	}, [entries]);

	// ── Layer-1 branch topology (session-tree nav) ─────────────────────
	// Children index over the FULL entries by parentId (wire seam tags it
	// on message_start). Only built when the caller provides branchInfo —
	// plain linear consumers pay nothing.
	const branchChildren = useMemo(() => {
		const map = new Map<string, SessionEntry[]>();
		if (!branchInfo) return map;
		for (const entry of branchEntries ?? entries) {
			const pid = entry.parentId ?? "";
			if (!pid) continue;
			const bucket = map.get(pid);
			if (bucket) bucket.push(entry);
			else map.set(pid, [entry]);
		}
		return map;
	}, [entries, branchEntries, branchInfo]);
	// Short label for a branch-switch button (first text line of a message).
	const entryLabelOf = useCallback((e: SessionEntry): string => {
		if (e.type !== "message") return e.type;
		const m = e.message as { role?: string; content?: unknown };
		const blocks = Array.isArray(m.content) ? (m.content as Array<{ type?: string; text?: string }>) : [];
		const text =
			typeof m.content === "string"
				? m.content
				: blocks
						.filter(b => b?.type === "text")
						.map(b => b.text ?? "")
						.join(" ");
		return text.replace(/\s+/g, " ").trim().slice(0, 60);
	}, []);
	// Which child of `parentId` lies on the active path (the one whose
	// subtree contains the current leaf — approximated here as the LAST
	// child in entry order, which is where new branches append).
	const activeChildOf = useCallback(
		(parentId: string): string | null => {
			const kids = branchChildren.get(parentId);
			if (!kids || kids.length === 0) return null;
			return kids[kids.length - 1]!.id;
		},
		[branchChildren],
	);

	// Turn-final file artifacts (本轮文件卡片展示在最底部): a turn spans
	// multiple assistant messages (one per agent step), so the final files
	// the turn produced aggregate across ALL of them and render once, under
	// the turn's FINAL assistant message. Keyed by the final message's entry
	// id; built over the full entries (window-safe). Turns without artifacts
	// are omitted so untouched rows keep their memo (undefined prop = no
	// cards) — only settled results count (finalArtifacts' completed gate).
	const turnArtifactsByFinal = useMemo(() => {
		const byFinal = new Map<string, FileCardItem[]>();
		let turn: AssistantMessage[] = [];
		let finalId: string | null = null;
		const flush = (): void => {
			if (finalId !== null && turn.length > 0) {
				const artifacts = finalArtifacts(
					turn.flatMap(m => m.content),
					id => {
						const r = results.get(id);
						return r !== undefined && r.isError !== true;
					},
				);
				if (artifacts.length > 0) byFinal.set(finalId, artifacts);
			}
			turn = [];
			finalId = null;
		};
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			const m = entry.message;
			if (m.role === "user") {
				flush();
			} else if (m.role === "assistant") {
				turn.push(m);
				finalId = entry.id;
			}
		}
		flush();
		return byFinal;
	}, [entries, results]);

	// display.collapseCompacted parity: fold everything before the FIRST
	// compaction divider behind a toggle row ("show pre-compaction
	// history"). Virtualization renders the folded prefix as zero-height
	// rows (estimate 0), so the compaction fold costs no DOM.
	const [compactedOpen, setCompactedOpen] = useState(false);
	// Completed-round folds (craft-agents TurnCard parity): per-round toggle
	// state, keyed by the round's user-message ENTRY ID (stable across
	// history prepends — index keys dropped deviations before). The set
	// stores DEVIATIONS from the default (openchamber activityDefaultState):
	// when the default is collapsed it holds OPEN rounds; when expanded,
	// CLOSED ones — so a settings flip re-reads existing rounds without
	// migration.
	const [roundFoldOpen, setRoundFoldOpen] = useState<ReadonlySet<string>>(() => new Set());
	// Image preview lightbox: full-size view of clicked message images
	// (all images of the message form the gallery).
	const [previewImg, setPreviewImg] = useState<{ items: { src: string; alt: string }[]; index: number } | null>(null);
	const openPreview = useCallback(
		(images: { src: string; alt: string }[], index: number) => setPreviewImg({ items: images, index }),
		[],
	);
	const firstCompactionIdx = useMemo(
		() => (collapseCompacted ? entries.findIndex(e => e.type === "compaction") : -1),
		[entries, collapseCompacted],
	);
	const folding = collapseCompacted && !compactedOpen && firstCompactionIdx > 0;

	const rootRef = useRef<HTMLDivElement | null>(null);
	// M1.3 scroll-anchor state machine (scroll-anchor.ts, ZCode parity):
	// `following` is the user's scrolling INTENT — only real user input flips
	// it; programmatic stick-to-bottom writes and layout scroll events only
	// update the geometry ledger. `programmaticScrollRef` marks our own
	// scrollTop writes so the async scroll event classifies itself;
	// `intentRef` holds the wheel/touch/keyboard intent a commit must
	// reconcile BEFORE sticking (a wheel upscroll lands one frame ahead of
	// its scroll event — without the reconcile a streaming commit would
	// swallow it and yank the viewport back to the bottom).
	const followingRef = useRef(initialFollowing());
	const [followingUi, setFollowingUi] = useState(followingRef.current);
	const setFollowing = useCallback((next: boolean): void => {
		followingRef.current = next;
		setFollowingUi(next);
	}, []);
	const programmaticScrollRef = useRef(false);
	// Back-to-bottom smooth scroll in flight: intermediate scroll events must
	// not be adjudicated as user upscrolls (they'd cancel the animation's
	// re-follow). Cleared on arrival (at bottom) or scrollend.
	const smoothScrollRef = useRef(false);
	const lastObservedScrollTopRef = useRef(0);
	const scrollIntentRef = useRef<TimelineUserScrollIntent | undefined>(undefined);
	const prevLenRef = useRef(entries.length);
	const sentinelRef = useRef<HTMLDivElement | null>(null);
	/** Session-open grace window (epoch ms): scroll events and content-change
	 *  reconciles inside it cannot release `following` (see the sessionKey
	 *  effect). 0 = grace inactive. */
	const openGraceUntilRef = useRef(0);

	// The scrolling host differs per consumer: the desktop GUI scrolls an
	// OUTER .gui-transcript (this component's .tr-root is expanded and
	// static there), the web shell scrolls .tr-root itself. Resolved in the
	// root's ref callback (below) — state, not just a ref, so the
	// virtualizer re-renders once the scroll element exists. Every
	// scroll-affecting path (lock tracking, bottom follow, virtualization)
	// must talk to the real scroller or it silently no-ops.
	const scrollerRef = useRef<HTMLElement | null>(null);
	const resolveScroller = useCallback((el: HTMLDivElement | null): void => {
		rootRef.current = el;
		const sc = el?.closest<HTMLElement>(".gui-transcript") ?? el ?? null;
		scrollerRef.current = sc;
		setScrollerEl(prev => (prev === sc ? prev : sc));
	}, []);

	// In-flight round boundary: entries after the last user message while the
	// agent works. That span is never suppressed — watching the agent work IS
	// the transcript (user: 执行过程中活动应该都可见, 结束后才折叠进摘要行).
	// Without a user message there is no round to exempt, so the display
	// setting applies as before (the parity test pins that case).
	const liveFromIdx = useMemo(() => {
		if (!working) return Number.MAX_SAFE_INTEGER;
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e?.type === "message" && e.message.role === "user") return i + 1;
		}
		return Number.MAX_SAFE_INTEGER;
	}, [entries, working]);

	// Session switch → land on the latest message (see `sessionKey`).
	useEffect(() => {
		void sessionKey;
		setFollowing(true);
		scrollIntentRef.current = undefined;
		const el = scrollerRef.current;
		if (el) {
			programmaticScrollRef.current = true;
			el.scrollTop = el.scrollHeight;
			lastObservedScrollTopRef.current = el.scrollTop;
		}
		// Open grace: a fresh session's first second is measurement chaos —
		// fold derivation settles, rows measure in, the browser clamps
		// scrollTop as estimate→measure corrections land. Those unflagged
		// scroll events used to adjudicate as USER upscrolls (following went
		// false) and the transcript parked at its first rows instead of the
		// latest message. During the grace only explicit at-bottom landing
		// confirms follow; unfollow decisions are deferred. A final stick at
		// grace end guarantees the bottom landing even if no content change
		// re-triggers the follow effect.
		openGraceUntilRef.current = Date.now() + 1200;
		const graceTimer = setTimeout(() => {
			openGraceUntilRef.current = 0;
			const sc = scrollerRef.current;
			if (sc && followingRef.current) {
				programmaticScrollRef.current = true;
				sc.scrollTop = sc.scrollHeight;
				lastObservedScrollTopRef.current = sc.scrollTop;
			}
		}, 1250);
		return () => clearTimeout(graceTimer);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [sessionKey]);

	// Completed-round folds + M1 turn units, derived over the FULL loaded
	// list through the incremental per-round cache (turn-derive.ts): every
	// streamed frame only re-derives the in-flight round, never the whole
	// history (mem-bench: the old full-list build was ~200ms at 42k
	// entries). Result references are structurally shared — unchanged
	// frames return the previous arrays, so the memos below stay valid.
	const deriveCacheRef = useRef(createTurnDeriveCache());
	useEffect(() => {
		deriveCacheRef.current = createTurnDeriveCache();
	}, [sessionKey]);
	const { folds, units: turnUnits } = useMemo(
		() => deriveTurns(entries, working, { fallbackModel: model }, deriveCacheRef.current),
		[entries, working, model],
	);
	const turnUnitByStart = useMemo(() => {
		const map = new Map<number, TurnRenderUnit>();
		for (const unit of turnUnits) map.set(unit.startIdx, unit);
		return map;
	}, [turnUnits]);

	// Completed-round fold OPEN-state keys are the round's user-message id
	// (fold.userId), NOT the entry index: history prepends shift absolute
	// indexes, and index keys silently dropped the user's fold deviations.
	const foldKeyOf = useCallback((f: RoundFold): string => f.userId ?? `idx:${f.startIdx}`, []);
	const foldsExpanded = defaultRoundFoldExpanded && !hideToolActivity;
	const foldOpenOf = useCallback(
		(f: RoundFold): boolean => roundFoldOpen.has(foldKeyOf(f)) !== foldsExpanded,
		[roundFoldOpen, foldsExpanded, foldKeyOf],
	);

	// 工具调用汇总 (Kimi parity): consecutive work runs (round-collapse
	// .buildToolRuns — streaming live tail exempt) summarized per run at the
	// run head. Expand deviations key on the run head's entry id (stable
	// across history prepends — same lesson as foldKeyOf): an expanded run
	// renders its full row sequence plus the summary line (click re-folds).
	const [runsExpanded, setRunsExpanded] = useState<ReadonlySet<string>>(() => new Set());
	const toggleRun = useCallback((key: string): void => {
		setRunsExpanded(prev => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);
	const toolRuns = useMemo(
		() => (toolCallSummary && !hideToolActivity ? buildToolRuns(entries, working) : []),
		[entries, working, toolCallSummary, hideToolActivity],
	);
	const runByHeadIdx = useMemo(() => {
		const map = new Map<number, ToolRunSummary>();
		for (const r of toolRuns) map.set(r.headIdx, r);
		return map;
	}, [toolRuns]);
	const runByRowIdx = useMemo(() => {
		const map = new Map<number, ToolRunSummary>();
		for (const r of toolRuns) {
			for (const i of r.idxs) map.set(i, r);
		}
		return map;
	}, [toolRuns]);

	// Index set of rows collapsed inside a CLOSED fold — the virtualizer's
	// estimate for these is ~0 (the fold slot collapses to height 0), which
	// keeps the scrollbar stable when scrolled-past turns mount/unmount.
	// Recomputes only when a fold actually toggles (folds is reference-stable
	// across streamed frames).
	const collapsedSpanSet = useMemo(() => {
		const set = new Set<number>();
		for (const f of folds) {
			if (foldOpenOf(f)) continue;
			for (let i = f.startIdx + 1; i <= f.endIdx; i++) {
				if (i !== f.finalIdx && !f.exempt.includes(i)) set.add(i);
			}
		}
		// 工具调用汇总: summarized run tail rows collapse into zero-height
		// slots too — same virtualizer estimate contract as closed folds.
		for (const r of toolRuns) {
			if (runsExpanded.has(r.key)) continue;
			for (let k = 1; k < r.idxs.length; k++) set.add(r.idxs[k]);
		}
		return set;
	}, [folds, foldOpenOf, toolRuns, runsExpanded]);

	// ── Entry-level virtualization (M2/P0①) ──────────────────────────────
	// The scroll host resolves in the ref callback below (desktop scrolls an
	// outer .gui-transcript, the web shell scrolls .tr-root itself).
	const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null);
	const virtualizer = useVirtualizer({
		count: entries.length,
		getScrollElement: () => scrollerEl,
		getItemKey: (index: number) => entries[index]?.id ?? index,
		estimateSize: (index: number) => {
			if (collapsedSpanSet.has(index)) return 2;
			if (folding && index < firstCompactionIdx) return 0;
			return estimateEntryHeight(entries[index]);
		},
		overscan: 8,
	});
	// Prepend anchoring is handled by the CALLER's scrollHeight-delta
	// compensation (ChatView.loadOlder) — the mechanism this codebase has
	// always used. tanstack's own measure-drift adjustment would compensate
	// a second time on the prepend frame, so it stays off; estimate
	// refinement drift for items entirely above the viewport resolves
	// before they become visible (see review doc §8-P0④).
	virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
	const virtualItems = virtualizer.getVirtualItems();
	// Test/SSR fallback: without a measurable scroller (happy-dom, SSR) the
	// virtualizer's window is empty — render the full list so row-level tests
	// and first-paint SSR keep working. Browsers always have a sized scroller
	// here (the ref callback resolves before paint).
	const virtualEnabled = (scrollerEl?.clientHeight ?? 0) > 0;
	const firstVirtualItem = virtualItems[0];
	const lastVirtualItem = virtualItems.at(-1);
	const topSpacerHeight = virtualEnabled ? (firstVirtualItem?.start ?? 0) : 0;
	const bottomSpacerHeight =
		virtualEnabled && lastVirtualItem ? Math.max(0, virtualizer.getTotalSize() - lastVirtualItem.end) : 0;

	// Two things fire when the top sentinel enters the pane (M1.11):
	//  1. DATA backfill — the caller pages the next older chunk from
	//     session.history (daemon tail is 200; pages are 500 entries).
	//  2. RENDER window expansion — the newly paged-in prefix must actually
	//     mount. Rows inserted ABOVE the reading position shove the visible
	//     content down, so the scroll offset is compensated with the real
	//     scrollHeight delta after React commits (double rAF), same trick
	//     the caller uses for prepending pages.
	// The bottom lock gate matters: while the tail is followed (streaming),
	// batched renders can transiently swing the sentinel into the root
	// margin and must not expand the window to the full history.
	useEffect(() => {
		const el = sentinelRef.current;
		if (!el) return;
		// The desktop GUI scrolls an outer .gui-transcript (ancestor of
		// .tr-root); the web shell scrolls .tr-root itself, so no root
		// (viewport) there. Observing with the scroller as root keeps the
		// sentinel tied to the pane, not the viewport.
		const scroller = el.closest<HTMLElement>(".gui-transcript") ?? undefined;
		const obs = new IntersectionObserver(
			([entry]) => {
				if (!entry?.isIntersecting || followingRef.current) return;
				// Reaching the top pages the next older chunk; the caller
				// guards concurrency and compensates the scroll anchor
				// (ChatView.loadOlder's scrollHeight-delta) — virtualization
				// mounts paged-in rows on demand, no render-window growth.
				onLoadOlder?.();
			},
			// Lookahead: the page RPC must resolve BEFORE the user scrolls into
			// the top spacer, or the scroller shows blank space.
			{ root: scroller, rootMargin: "1200px 0px" },
		);
		obs.observe(el);
		return () => obs.disconnect();
	}, [onLoadOlder]);

	// Jump requests (message tree / trajectory / canvas / branch bar /
	// TurnRail): the virtualizer scrolls straight to the target's estimated
	// position (cheap — no mounting of everything in between), the row mounts
	// in the next window, then the flash effect below re-anchors precisely
	// and plays the highlight.
	const lastJumpNonceRef = useRef(0);
	const pendingJumpRef = useRef<{ timestamp: string; nonce: number } | null>(null);
	useEffect(() => {
		const pending = pendingJumpRef.current;
		if (!pending) return;
		const idx = entries.findIndex(e => e.timestamp === pending.timestamp);
		if (idx < 0) {
			pendingJumpRef.current = null;
			return;
		}
		// Wait until the target row is actually mounted (it mounts with the
		// next virtual window after scrollToIndex).
		if (!virtualItems.some(vi => vi.index === idx)) return;
		pendingJumpRef.current = null;
		jumpFlashRow(rootRef.current, pending.timestamp);
	}, [virtualItems, entries]);
	useEffect(() => {
		if (!jumpRequest || jumpRequest.nonce === lastJumpNonceRef.current) return;
		lastJumpNonceRef.current = jumpRequest.nonce;
		const idx = entries.findIndex(e => e.timestamp === jumpRequest.timestamp);
		if (idx < 0) return;
		if (folding && idx < firstCompactionIdx) setCompactedOpen(true);
		pendingJumpRef.current = { timestamp: jumpRequest.timestamp, nonce: jumpRequest.nonce };
		virtualizer.scrollToIndex(idx, { align: "center" });
	}, [jumpRequest, entries, folding, firstCompactionIdx, virtualizer]);

	// Key-based prepend anchoring (see anchorCtlRef prop): capture = first
	// mounted row intersecting the viewport top + its offset below the top;
	// restore = scrollToIndex(that key) + offset correction on the next
	// frame. The anchor row was mounted at capture time, so its measurement
	// survives the prepend (cache is keyed by entry id) and the restore
	// lands accurately — no scrollHeight arithmetic anywhere.
	const anchorCtl = useMemo<TranscriptAnchorCtl>(
		() => ({
			capture: () => {
				const scroller = scrollerRef.current;
				if (!scroller) return null;
				const first = virtualItems.find(vi => vi.end > scroller.scrollTop);
				if (!first) return null;
				return { key: String(first.key), offset: first.start - scroller.scrollTop };
			},
			restore: anchor => {
				const scroller = scrollerRef.current;
				if (!scroller) return;
				const idx = entries.findIndex(e => e.id === anchor.key);
				if (idx < 0) return;
				programmaticScrollRef.current = true;
				virtualizer.scrollToIndex(idx, { align: "start" });
				// scrollToIndex lands the row top at the viewport top; shift by
				// the captured offset so it returns to exactly its prior spot.
				requestAnimationFrame(() => {
					programmaticScrollRef.current = true;
					scroller.scrollTop -= anchor.offset;
					lastObservedScrollTopRef.current = scroller.scrollTop;
				});
			},
		}),
		[virtualItems, entries, virtualizer],
	);
	useEffect(() => {
		if (anchorCtlRef) anchorCtlRef.current = anchorCtl;
	}, [anchorCtl, anchorCtlRef]);

	// Scroll-event adjudication (M1.3): our own scrollTop writes set
	// `programmaticScrollRef` first, so the async scroll event classifies as
	// "programmatic" and cannot flip the user's following intent; genuine
	// user scrolls re-decide by landing position (at bottom ⇔ follow). Moved
	// off the JSX onScroll attribute — that fired on .tr-root, which is NOT
	// the scroller in the desktop GUI; the listener attaches to the resolved
	// scroller.
	useEffect(() => {
		const scroller = scrollerRef.current;
		if (!scroller) return;
		const onScroll = (): void => {
			const metrics = {
				scrollTop: scroller.scrollTop,
				viewportHeight: scroller.clientHeight,
				contentHeight: scroller.scrollHeight,
			};
			// Back-to-bottom animation in flight: intermediate positions are
			// programmatic, not user upscrolls. Keep ignoring until arrival
			// (landing at the bottom re-arms follow) or the scrollend fallback.
			if (smoothScrollRef.current) {
				lastObservedScrollTopRef.current = scroller.scrollTop;
				if (isAtBottom(metrics)) {
					smoothScrollRef.current = false;
					programmaticScrollRef.current = false;
					setFollowing(true);
				}
				return;
			}
			const source = programmaticScrollRef.current ? "programmatic" : "user";
			programmaticScrollRef.current = false;
			lastObservedScrollTopRef.current = scroller.scrollTop;
			const resolved = resolveFollowingAfterScroll({ following: followingRef.current, metrics, source });
			// Open grace: measurement-clamp scroll events are not user
			// upscrolls — only an explicit at-bottom landing may (re)arm
			// follow inside the window.
			if (Date.now() < openGraceUntilRef.current && !isAtBottom(metrics)) {
				setFollowing(followingRef.current);
				return;
			}
			setFollowing(resolved);
		};
		const onScrollEnd = (): void => {
			smoothScrollRef.current = false;
		};
		scroller.addEventListener("scroll", onScroll);
		scroller.addEventListener("scrollend", onScrollEnd);
		return () => {
			scroller.removeEventListener("scroll", onScroll);
			scroller.removeEventListener("scrollend", onScrollEnd);
		};
	}, [setFollowing]);

	// User scroll-intent capture (wheel/touch/keyboard). The intent exists
	// one frame ahead of its scroll event; a content commit landing in that
	// window reconciles against it before any stick-to-bottom (see the
	// follow effect below).
	useEffect(() => {
		const scroller = scrollerRef.current;
		if (!scroller) return;
		const onWheel = (e: WheelEvent): void => {
			const intent = timelineWheelScrollIntent(e.deltaY);
			scrollIntentRef.current = intent;
			// Release follow SYNCHRONOUSLY on an upscroll gesture. Without
			// this the async scroll-event adjudication races the RO
			// stick-to-bottom: the RO pins the viewport back to the bottom
			// before the wheel's scroll event is delivered, the event then
			// adjudicates "landed at bottom" and RE-ARMS follow — the user's
			// upscroll is annihilated and every notch fights the pin (the
			// 分页被拽回底部 jitter). Disarming here means the rAF-coalesced
			// pin always sees following=false and no-ops.
			if (intent === "awayFromBottom") setFollowing(false);
		};
		let lastTouchY: number | null = null;
		const onTouchStart = (e: TouchEvent): void => {
			lastTouchY = e.touches[0]?.clientY ?? null;
		};
		const onTouchMove = (e: TouchEvent): void => {
			const y = e.touches[0]?.clientY;
			if (y === undefined) return;
			if (lastTouchY !== null) {
				const intent = timelineTouchScrollIntent(lastTouchY, y);
				scrollIntentRef.current = intent;
				// Same synchronous release as onWheel (upswipe disarms the
				// bottom pin before the RO can yank the viewport back).
				if (intent === "awayFromBottom") setFollowing(false);
			}
			lastTouchY = y;
		};
		const onKeyDown = (e: KeyboardEvent): void => {
			const target = e.target;
			const editable =
				target instanceof HTMLElement &&
				(target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
			const intent = timelineKeyboardScrollIntent({
				key: e.key,
				shiftKey: e.shiftKey,
				editableTarget: editable,
			});
			if (intent !== "none") {
				scrollIntentRef.current = intent;
				if (intent === "awayFromBottom") setFollowing(false);
			}
		};
		scroller.addEventListener("wheel", onWheel, { passive: true });
		scroller.addEventListener("touchstart", onTouchStart, { passive: true });
		scroller.addEventListener("touchmove", onTouchMove, { passive: true });
		window.addEventListener("keydown", onKeyDown);
		return () => {
			scroller.removeEventListener("wheel", onWheel);
			scroller.removeEventListener("touchstart", onTouchStart);
			scroller.removeEventListener("touchmove", onTouchMove);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, []);

	const followKey = `${entries.length}:${stream !== null}:${activeTools.size}:${working}`;
	// Live-streaming assistant row: the last assistant entry while the
	// session is working (GUI folds message_start into entries, so this is
	// the row whose text is still growing).
	const lastAssistantIdx = useMemo(() => {
		let idx = -1;
		entries.forEach((e, i) => {
			if (e.type === "message" && e.message.role === "assistant") idx = i;
		});
		return idx;
	}, [entries]);
	// Round anchor for the live ticker: the LAST user message timestamp
	// (craft-agents parity) — the round's start, data-driven so a session
	// switch mid-round resumes the count instead of restarting it.
	const lastUserTs = useMemo(() => lastUserMessageTs(entries), [entries]);
	// Round-true tail: the last assistant entry must BELONG to the current
	// round (timestamp >= the last user message). Right after a send the
	// previous round's final message is still the last assistant entry —
	// mounting the live ticker on it makes "已用时 X 秒" appear under the
	// WRONG message until message_start lands (the jump the user saw).
	// Gate streamingLast on this, and render the ticker as a standalone
	// ghost row under the user message until the new entry exists.
	const lastAssistantEntry = lastAssistantIdx >= 0 ? entries[lastAssistantIdx] : undefined;
	const lastAssistantInRound =
		lastAssistantEntry?.type === "message" &&
		lastUserTs !== undefined &&
		new Date(lastAssistantEntry.message.timestamp).getTime() >= lastUserTs;
	useEffect(() => {
		// followKey is only ever a re-run trigger (the scroll itself is stateless).
		void followKey;
		const el = scrollerRef.current;
		if (el === null) return;
		// Sending a message always re-locks the bottom (user: sending should
		// scroll to the latest) — a fresh user entry means the user is
		// engaging with the tail again.
		if (entries.length > prevLenRef.current) {
			const last = entries[entries.length - 1] as { type?: string; message?: { role?: string } } | undefined;
			if (last?.type === "message" && last.message?.role === "user") {
				setFollowing(true);
				scrollIntentRef.current = undefined;
			}
		}
		prevLenRef.current = entries.length;
		// Reconcile BEFORE sticking: a wheel upscroll one frame ahead of its
		// scroll event must not be swallowed by this commit (it would yank
		// the viewport back to the bottom and re-arm follow). The intent is
		// consumed here; later scroll events adjudicate by landing position.
		// Open grace: measurement chaos after a session switch must not
		// release follow either — the reconcile is skipped entirely (sticks
		// still run, and the grace-end timer guarantees the final landing).
		const inGrace = Date.now() < openGraceUntilRef.current;
		if (!inGrace) {
			setFollowing(
				reconcileFollowingForContentAnchor({
					following: followingRef.current,
					metrics: {
						scrollTop: el.scrollTop,
						viewportHeight: el.clientHeight,
						contentHeight: el.scrollHeight,
					},
					lastObservedScrollTop: lastObservedScrollTopRef.current,
					userScrollIntent: scrollIntentRef.current,
				}),
			);
		}
		scrollIntentRef.current = undefined;
		if (anchorActionAfterContentChange(followingRef.current) === "stickToBottom") {
			programmaticScrollRef.current = true;
			el.scrollTop = el.scrollHeight;
			lastObservedScrollTopRef.current = el.scrollTop;
		}
	}, [followKey, entries, setFollowing]);

	// While following, ANY tail-ward content growth re-pins the bottom:
	// streaming deltas, images finishing decode, deferred code highlighting.
	// Once released, growth never pulls the reading position back (the
	// observer no-ops while !following). Observes .tr-root (the content),
	// not the scroller — the scroller's own box is layout-fixed. rAF-coalesced
	// so a burst of measurements settles in one write.
	useEffect(() => {
		const content = rootRef.current;
		if (!content) return;
		let raf = 0;
		const ro = new ResizeObserver(() => {
			if (!followingRef.current) return;
			// Belt & braces over the synchronous gesture release: never pin
			// while a fresh away-from-bottom intent is pending (the reconcile
			// that would consume it may not have run yet).
			if (scrollIntentRef.current === "awayFromBottom") return;
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(() => {
				const scroller = scrollerRef.current;
				if (!scroller || !followingRef.current) return;
				programmaticScrollRef.current = true;
				scroller.scrollTop = scroller.scrollHeight;
				lastObservedScrollTopRef.current = scroller.scrollTop;
			});
		});
		ro.observe(content);
		return () => {
			ro.disconnect();
			cancelAnimationFrame(raf);
		};
	}, []);

	// Active tools not already represented as toolCall blocks in committed rows or the stream ghost.
	// Memoized: the full-entry scan ran on EVERY render (not just entries
	// changes) — one of the per-frame O(n) loops the virtualization work
	// is eliminating.
	const tailTools = useMemo(() => {
		const renderedToolIds = new Set<string>();
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			for (const block of entry.message.content) {
				if (block.type === "toolCall") renderedToolIds.add(block.id);
			}
		}
		if (stream !== null) {
			for (const block of stream.content) {
				if (block.type === "toolCall") renderedToolIds.add(block.id);
			}
		}
		const out: ActiveTool[] = [];
		for (const tool of activeTools.values()) {
			if (!renderedToolIds.has(tool.toolCallId)) out.push(tool);
		}
		return out;
	}, [entries, stream, activeTools]);

	// Back-to-bottom (M1.10 批次 A, L2 float 规格): visible only when the
	// user has scrolled away (shouldShowBackToBottom semantics from the M1.3
	// state machine). The click re-arms follow and smooth-scrolls; the
	// in-flight animation's intermediate scroll events are adjudicated as
	// programmatic (smoothScrollRef) so they cannot cancel the re-follow.
	const backToBottom = useCallback((): void => {
		setFollowing(true);
		scrollIntentRef.current = undefined;
		const scroller = scrollerRef.current;
		if (!scroller) return;
		smoothScrollRef.current = true;
		programmaticScrollRef.current = true;
		scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
	}, [setFollowing]);

	// Render ONE entry row (the virtualizer mounts only the viewport
	// window). Fold/turn/branch decoration all happens here — the
	// virtual-row wrapper itself is rendered by the list map in JSX.
	const renderEntryRow = (absIdx: number, entry: SessionEntry): ReactNode => {
		// Folded pre-compaction history: the toggle row replaces the first
		// compaction divider; everything before it renders null (its
		// virtual-row wrapper still mounts at estimate 0).
		if (folding && absIdx < firstCompactionIdx) return null;
		if (folding && absIdx === firstCompactionIdx) {
			return (
				<button
					key="compacted-fold"
					type="button"
					className="tr-divider tr-compacted-fold"
					title={t("show pre-compaction history")}
					onClick={() => setCompactedOpen(true)}
				>
					<span>{t("show pre-compaction history ({count})", { count: String(firstCompactionIdx) })}</span>
				</button>
			);
		}
		const isAssistantMessage = entry.type === "message" && entry.message.role === "assistant";
		// One avatar per agent turn (openchamber grouping): consecutive
		// assistant/tool messages keep the gutter empty so the orb only
		// renders on the first row of the turn. Virtualization may unmount
		// the predecessor, so the old window accumulator became a direct
		// lookup of the previous entry (equivalent — the old seeding code
		// documented exactly this equivalence).
		const before = entries[absIdx - 1];
		const prevIsAssistant =
			before?.type === "message" && (before.message.role === "assistant" || before.message.role === "toolResult");
		// M1 turn header: rendered above the turn-start row (the user
		// prompt or an advisor note — shared isTurnStart semantics).
		// The frozen round duration keys off the reply message's
		// timestamp (same map the reply row's timer uses).
		const turnUnit = turnUnitByStart.get(absIdx);
		// Completed-round folding (craft-agents TurnCard parity): working
		// entries between a user message and its final reply fold behind
		// a header once the round is done and isn't the live tail. The
		// header renders ABOVE the final assistant message; the in-span
		// working rows render only while that fold is expanded.
		// 隐藏工具活动 implies "collapsed into 活动": the fold owns the
		// process so nothing becomes unreachable. (foldOpenOf / foldsExpanded
		// live at component scope — fold keys are the round's user-message id,
		// stable across history prepends.)
		// The fold this row belongs to — by header row, by reply row, or by
		// sitting inside the span. ONE lookup drives everything below;
		// deriving the roles from separate finds is what lost the header for
		// turns whose first content row is not their reply (the header row
		// suppressed itself while the hoist onto the reply row never fired —
		// verified against a real 1721-entry journal: 34 folds, only 20
		// headers rendered).
		const fold = folds.find(
			f => absIdx === f.headerIdx || absIdx === f.finalIdx || (absIdx > f.startIdx && absIdx <= f.endIdx),
		);
		const foldOpen = fold !== undefined && foldOpenOf(fold);
		const foldClosed = fold !== undefined && !foldOpen;
		const isHeaderRow = fold !== undefined && absIdx === fold.headerIdx;
		const isReplyRow = fold !== undefined && absIdx === fold.finalIdx;
		// Widget rows (successful widget toolCalls, see round-collapse
		// exempt) stay mounted while the fold is closed: the standalone
		// card is the turn's artifact, not process noise.
		const isExemptRow = fold?.exempt.includes(absIdx) === true;
		const inHiddenSpan = fold !== undefined && !isHeaderRow && !isReplyRow && !isExemptRow;
		// ── 工具调用汇总 (Kimi parity) ────────────────────────────────────
		// An active run renders its HEAD slot as the one-line summary and
		// collapses its tail rows into zero-height slots (same .tr-fold-slot
		// animation the round fold uses); clicking the summary (or re-clicking
		// an expanded one) flips the run back to its full row sequence.
		// Suppressed when: the fold is closed (the 活动 header owns the
		// process), a run row is fold-exempt (widget/tail/hook rows are
		// artifacts, not noise) — the whole run renders 现状 then.
		const run = runByRowIdx.get(absIdx);
		const runBlocked = run !== undefined && fold !== undefined && run.idxs.some(i => fold.exempt.includes(i));
		const runActive = run !== undefined && !runBlocked && !foldClosed;
		const isRunHead = runActive && run.headIdx === absIdx;
		const runOpen = runActive && runsExpanded.has(run.key);
		const isRunHidden = runActive && !isRunHead && !runOpen;
		// Rows in the hidden span stay MOUNTED and collapse to height 0
		// (.tr-fold-slot, animatable via interpolate-size) so folding
		// animates both ways instead of popping in and out. Summarized run
		// tail rows take the same slot treatment.
		const collapsible = inHiddenSpan || isRunHidden;
		// Collapsed turn = 活动 row + the answer: the reply row renders its
		// TEXT only (thinking/tool parts fold into the activity row).
		const rowTextOnly = foldClosed && isReplyRow;
		// A closed fold shows ONLY the header + the reply (+ exempt widget
		// rows): every other row of the turn loses its body, and the header
		// row (when it is not the reply) disappears entirely — its header
		// rides the reply row instead.
		const hideRowContent = foldClosed && !isReplyRow && !isExemptRow;
		const hoistHeaderHere = foldClosed && isReplyRow;
		const renderHeaderHere = (isHeaderRow && !foldClosed) || hoistHeaderHere;
		// Per-round work timer: the live tail row ticks from the
		// round start (last user message); completed rounds show
		// their frozen total under the final message.
		const isTail = isAssistantMessage && absIdx === lastAssistantIdx;
		const streamingLast = working && isTail && lastAssistantInRound;
		const roundDuration = isAssistantMessage ? roundDurations?.get(entry.message.timestamp) : undefined;
		// Closed: the header rides the REPLY row (hoisted into its content column) so
		// orb + 活动 + answer share one line, while the turn's own first row renders
		// nothing — no pixel-less row, no floating avatar.
		const foldHeader =
			renderHeaderHere && fold !== undefined ? (
				<RoundFoldHeader
					key={`round-fold-${fold.startIdx}`}
					fold={fold}
					open={foldOpenOf(fold)}
					onToggle={() =>
						setRoundFoldOpen(prev => {
							const next = new Set(prev);
							const key = foldKeyOf(fold);
							if (next.has(key)) next.delete(key);
							else next.add(key);
							return next;
						})
					}
					onRevert={onRevert}
					startTs={entries[fold.startIdx]?.timestamp}
				/>
			) : null;
		// A header row is the turn's first content row, which is frequently a
		// toolResult / custom row — EntryRow mounts no Row for those, so the
		// header has to be mounted by this loop instead (it vanished entirely
		// when it could only ride an assistant body).
		const headerStandalone = foldHeader !== null && !isAssistantMessage;
		// 隐藏工具活动 hides the process EXCEPT (a) behind an expanded
		// 活动 row — asking to expand it outranks the setting — and
		// (b) during the live round, where the activity is the point.
		// Completed rounds are what the fold + the setting govern.
		const rowHideTools = hideToolActivity && !foldOpen && absIdx < liveFromIdx;
		// The row body: mounted for hidden-span rows too (the slot collapses
		// them), suppressed only for a closed fold's non-reply header row —
		// and for a summarized run head, whose body the summary line replaces
		// (an expanded run keeps its full rows below the summary).
		const runSummaryHere = isRunHead && run !== undefined;
		const body =
			collapsible || !hideRowContent ? (
				<Fragment key={entry.id}>
					{headerStandalone ? (
						// Inside the message column, so it aligns with the reply.
						<Row kind="assistant" gutter={agentGutter ?? t("agent")}>
							{foldHeader}
						</Row>
					) : null}
					{runSummaryHere ? (
						<Row kind="assistant" gutter={agentGutter ?? t("agent")}>
							{headerStandalone ? null : foldHeader}
							<ToolRunLine run={run} open={runOpen} onToggle={() => toggleRun(run.key)} />
						</Row>
					) : null}
					{hideRowContent && !collapsible ? null : runSummaryHere && !runOpen ? null : (
						<EntryRow
							entry={entry}
							foldHeader={isAssistantMessage && !runSummaryHere ? (foldHeader ?? undefined) : undefined}
							results={results}
							active={activeTools}
							host={host}
							userGutter={userGutter}
							agentGutter={
								// The reply of a COLLAPSED turn owns the orb: its predecessor is the
								// hidden header row, so the usual "consecutive assistant rows drop the
								// avatar" rule must not apply here.
								isAssistantMessage && prevIsAssistant && !(foldClosed && isReplyRow) ? "" : agentGutter
							}
							userPlain={userPlain}
							collapseLongUserMessages={collapseLongUserMessages}
							hideToolActivity={rowHideTools || rowTextOnly}
							textOnly={rowTextOnly}
							showTokenUsage={showTokenUsage}
							smoothStreaming={smoothStreaming}
							taskCardStyle={taskCardStyle}
							artifacts={turnArtifactsByFinal.get(entry.id)}
							thinkingLevel={thinkingLevel}
							streamingLast={streamingLast}
							runStartTs={streamingLast ? lastUserTs : undefined}
							roundDuration={roundDuration}
							onQuote={onQuote}
							onEdit={onEdit}
							onRetry={onRetry}
							onRevert={onRevert}
							onFork={onFork}
							onSpeak={onSpeak}
							onSaveImage={onSaveImage}
							onPreviewImage={openPreview}
							speaking={speakingId != null && speakingId === entry.id}
							onStopSpeak={onStopSpeak}
							retryTarget={retryTargets.get(entry.id) ?? null}
							renderTranscriptNode={renderTranscriptNode}
						/>
					)}
				</Fragment>
			) : null;
		const headerStandaloneRow = headerStandalone ? (
			// Inside the message column, so it aligns with the reply.
			<Row kind="assistant" gutter={agentGutter ?? t("agent")}>
				{foldHeader}
			</Row>
		) : null;
		// Summarized run tail rows stay collapsed even inside an OPEN fold —
		// the run's own summary line owns their visibility now.
		const slotClass = `tr-fold-slot${foldOpen && !isRunHidden ? " tr-fold-slot--open" : ""}`;
		const row = collapsible ? (
			// Hidden span rows stay MOUNTED inside the slot and collapse to
			// height 0, so folding animates both ways (returning null popped
			// rows in and out).
			<div className={slotClass}>{body}</div>
		) : (
			<Fragment key={entry.id}>
				{headerStandaloneRow}
				{body}
			</Fragment>
		);
		// M1 turn header: rendered above the turn-start row. Rows hidden
		// by the compaction fold returned null earlier (no orphans), and
		// turn starts never sit inside a fold's hidden span — the span
		// begins AFTER the user message.
		const rowWithTurnHead =
			turnUnit !== undefined ? (
				<Fragment key={`${entry.id}-turn`}>
					<TurnHeader
						unit={turnUnit}
						time={branchClock(entry.timestamp)}
						durationMs={
							turnUnit.replyIdx >= 0
								? roundDurations?.get(
										(entries[turnUnit.replyIdx] as { message: { timestamp: number } }).message.timestamp,
									)
								: undefined
						}
					/>
					{row}
				</Fragment>
			) : (
				row
			);
		// Layer-1 branch bar: a message with MULTIPLE children gets
		// a switchable divider under it (hidden when the caller
		// provides no branch topology — plain linear sessions).
		const childCount = branchInfo?.childCount.get(entry.id) ?? 0;
		if (branchInfo && childCount > 1 && entry.type === "message") {
			const kids = (branchChildren.get(entry.id) ?? []).map(c => ({
				id: c.id,
				label: entryLabelOf(c),
				time: branchClock((c as { timestamp?: unknown }).timestamp),
			}));
			return (
				<div key={entry.id} className="tr-branch-wrap">
					{rowWithTurnHead}
					<BranchBar
						count={childCount}
						childrenLabels={kids}
						activeChildId={activeChildOf(entry.id)}
						onPick={id => branchInfo.onSwitchBranch?.(id)}
					/>
				</div>
			);
		}
		return rowWithTurnHead;
	};

	return (
		<div
			ref={resolveScroller}
			className={`tr-root${compact === true ? " tr-root--compact" : ""}`}
			data-colorblind={colorBlind ? "true" : undefined}
		>
			{entries.length === 0 &&
				stream === null &&
				!working &&
				(emptySlot ?? <div className="tr-empty">{t("no activity yet")}</div>)}
			{/* Slim sentinel at the top of the list: paging trigger only.
			 *  Spacing above the mounted window comes from the virtual
			 *  spacer below — the scrollbar now reflects the FULL loaded
			 *  history (zcode spacer parity). */}
			<div ref={sentinelRef} className="tr-window-top" aria-hidden="true" />
			{loadingOlder && (
				<div className="tr-window-loading" aria-hidden="true">
					<span className="tr-window-loading-bar" />
				</div>
			)}
			{topSpacerHeight > 0 && (
				<div
					className="tr-virtual-spacer tr-virtual-spacer--top"
					style={{ height: topSpacerHeight }}
					aria-hidden="true"
				/>
			)}
			{virtualEnabled
				? virtualItems.map(vi => {
						const absIdx = vi.index;
						const entry = entries[absIdx];
						if (entry === undefined) return null;
						return (
							<div
								key={vi.key}
								ref={virtualizer.measureElement}
								data-index={vi.index}
								data-entry-ts={entry.timestamp}
								className="tr-vrow"
								aria-hidden={folding && absIdx < firstCompactionIdx ? true : undefined}
							>
								{renderEntryRow(absIdx, entry)}
							</div>
						);
					})
				: entries.map((entry, absIdx) => (
						<div
							key={entry.id ?? absIdx}
							data-entry-ts={entry.timestamp}
							className="tr-vrow"
							aria-hidden={folding && absIdx < firstCompactionIdx ? true : undefined}
						>
							{renderEntryRow(absIdx, entry)}
						</div>
					))}
			{bottomSpacerHeight > 0 && (
				<div
					className="tr-virtual-spacer tr-virtual-spacer--bottom"
					style={{ height: bottomSpacerHeight }}
					aria-hidden="true"
				/>
			)}
			{/* Model-response gap (working but no assistant entry yet): the
			 * ticker stands alone under the user message — the exact spot
			 * where the reply will land — instead of hanging off the
			 * previous round's message. */}
			{working && stream === null && lastUserTs !== undefined && !lastAssistantInRound && (
				<Row kind="assistant" gutter={agentGutter ?? t("agent")}>
					<div className="tr-ghost-working">
						<WorkingLine start={lastUserTs} meta={modelLevelMeta(undefined, thinkingLevel)} />
					</div>
				</Row>
			)}
			{stream !== null && (
				<Row kind="assistant" gutter={agentGutter ?? t("agent")}>
					<AssistantBody
						message={stream}
						results={results}
						active={activeTools}
						pending={!streamDone}
						runStartTs={lastUserTs}
						roundDuration={roundDurations?.get(stream.timestamp)}
						host={host}
						hideToolActivity={hideToolActivity}
						showTokenUsage={showTokenUsage}
						smoothStreaming={smoothStreaming}
						taskCardStyle={taskCardStyle}
						thinkingLevel={thinkingLevel}
						onPreviewImage={openPreview}
					/>
				</Row>
			)}
			{tailTools.length > 0 && !hideToolActivity && (
				<Row kind="assistant" gutter={stream === null ? (agentGutter ?? t("agent")) : ""}>
					{tailTools.map(tool => (
						<ToolCard
							key={tool.toolCallId}
							toolCallId={tool.toolCallId}
							name={tool.toolName}
							intent={tool.intent}
							args={tool.args}
							running
							partialResult={tool.partialResult}
							host={host}
							taskCardStyle={taskCardStyle}
							onPreviewImage={openPreview}
						/>
					))}
				</Row>
			)}
			{/* Back to bottom — sticky LAST child of .tr-root: its natural
			    position is the content tail, so while the tail is below the
			    viewport the sticky constraint pins the button to the pane
			    bottom; near the tail it settles into flow (and is hidden —
			    shouldShowBackToBottom is false while following). */}
			{shouldShowBackToBottom(followingUi, entries.length) && (
				<button
					type="button"
					className="tr-back-bottom"
					onClick={backToBottom}
					aria-label={t("back to bottom")}
					title={t("back to bottom")}
				>
					<ArrowDown size={15} strokeWidth={2.2} />
				</button>
			)}
			{/* The pre-stream thinking state is carried by the input-above
			    status bar (orb + text) — a transcript row with its own gutter
			    orb + 思考中 duplicated it (user: 俩 orbs and thinking). */}
			<ImageLightbox
				items={previewImg?.items ?? []}
				index={previewImg?.index ?? null}
				onClose={() => setPreviewImg(null)}
				onIndexChange={i => setPreviewImg(prev => (prev ? { ...prev, index: i } : prev))}
				onEdit={onEditImage}
			/>
		</div>
	);
});
