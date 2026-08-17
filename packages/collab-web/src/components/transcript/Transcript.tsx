import type { AssistantMessage, ImageContent, SessionEntry, TextContent, ToolResultMessage } from "@musepi/pi-wire";
import { play } from "cuelume";
import { Check as CheckIconData, Copy as CopyIconData } from "lucide";
import {
	Check,
	ChevronRight,
	Copy,
	GitFork,
	ImageDown,
	MessageSquare,
	Pencil,
	RefreshCw,
	Undo2,
	Volume2,
} from "lucide-react";
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

import {
	Fragment,
	memo,
	type ReactNode,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { t } from "../../i18n/index.js";
import type { ActiveTool } from "../../lib/client";
import { fmtTokens } from "../../lib/format";
import { collapseStyle, useCollapseHeight } from "../../lib/use-collapse.js";
import type { ToolRenderHost } from "../../tool-render";
import { ImageLightbox } from "../image-lightbox";
import { CanvasJumpCard, extractCanvasJumpBlocks } from "./canvas-jump";
import { FileCards, turnArtifacts } from "./FileCards";
import { ImageCardStack } from "./image-card-stack";
import { Markdown } from "./Markdown";
import { BashCard } from "./bash-card";
import { ToolCard } from "./ToolCard";
import { splitThinkingSentences } from "./thinking-sentences";
import { useWorkingNow } from "./use-working-now";
import { WidgetStandaloneCards } from "./widget-standalone";
import "./transcript.css";

// Windowed rendering for long sessions: only the tail WINDOW_INITIAL
// entries mount as DOM rows; older entries collapse into a top spacer
// with a "show earlier" affordance. An IntersectionObserver sentinel in
// the spacer extends the window by WINDOW_STEP as the user scrolls up,
// so mounted rows stay bounded (~100) no matter how long the session
// gets — without this a 1k-message session kept 1k rows mounted and
// re-rendered the whole list on every snapshot.
const WINDOW_INITIAL = 80;
const WINDOW_STEP = 80;
const WINDOW_JUMP = 500;

/** Long-thinking budget: only this many sentences render initially; the
 *  rest mount when the user hits 展开全部 (a giant reasoning block pays
 *  ~100 Markdown mounts otherwise, even while the body is collapsed). */
const MAX_THINK_SENTENCES = 80;
const AVG_ROW_HEIGHT = 44; // px; refined by measurement once rows mount

export interface TranscriptProps {
	entries: readonly SessionEntry[];
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	working: boolean;
	/** Frozen round durations by final assistant message timestamp (ms),
	 *  recorded at agent_end — each completed round's total stays visible
	 *  under its final message (craft-agents TaskActionMenu freeze parity). */
	roundDurations?: ReadonlyMap<number, number>;
	compact?: boolean; // dense variant for the agent drawer
	/** Sub-session drill-down capabilities forwarded to tool renderers. */
	host?: ToolRenderHost;
	/** Gutter replacement (ZCode: avatars instead of 宿主/代理 labels). */
	userGutter?: ReactNode;
	agentGutter?: ReactNode;
	/** User messages render as plain text instead of markdown
	 *  (openchamber userMessageRendering parity). */
	userPlain?: boolean;
	/** Long user messages clamp to two lines with an expand toggle
	 *  (openchamber collapsibleUserMessages parity). */
	collapseLongUserMessages?: boolean;
	/** TUI display.smoothStreaming parity: false renders streamed text
	 *  without the character-level reveal (also applied via the
	 *  `gui-chat-no-smooth` html class in the desktop GUI). */
	smoothStreaming?: boolean;
	/** TUI display.hideToolActivity parity: suppress model-initiated tool
	 *  call cards and running tail tools from the transcript. */
	hideToolActivity?: boolean;
	/** TUI display.showTokenUsage parity: show the per-turn token usage row
	 *  under settled assistant messages. */
	showTokenUsage?: boolean;
	/** TUI display.collapseCompacted parity: fold pre-compaction history
	 *  behind the first compaction divider. */
	collapseCompacted?: boolean;
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
	/** Fork (分叉): copy the session truncated to before this user message
	 *  into a NEW session (non-destructive — the original is untouched). */
	onFork?(messageId: string, text: string): void;
	/** Read an assistant reply aloud (TTS). */
	onSpeak?(text: string): void;
	/** Save an assistant reply as an image to the clipboard (openchamber). */
	onSaveImage?(text: string): void;
}

function Row({
	kind,
	id,
	gutter,
	title,
	children,
	onQuote,
	onEdit,
	onRetry,
	onRevert,
	onFork,
	onSpeak,
	onSaveImage,
	quoteText,
	retryTarget,
}: {
	kind: "user" | "assistant" | "custom" | "marker" | "bash";
	id?: string;
	gutter: ReactNode;
	title?: string;
	children: ReactNode;
	onQuote?(text: string): void;
	/** Edit: truncate to this message and restore its text (edit-and-reconverse). */
	onEdit?(messageId: string, text: string): void;
	onRetry?(messageId: string, text: string): void;
	/** Revert (撤回): truncate the session to before this user message. */
	onRevert?(messageId: string, text: string): void;
	/** Fork (分叉): copy the session truncated to before this user message
	 *  into a NEW session (non-destructive — the original is untouched). */
	onFork?(messageId: string, text: string): void;
	onSpeak?(text: string): void;
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
				clone.querySelectorAll<HTMLElement>(".tv-card, .tr-think, .tr-usage").forEach(el => el.remove());
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
		<div className={`tr-row tr-row--${kind}`}>
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
					{onSpeak && kind === "assistant" && (
						<button
							type="button"
							className="tr-action"
							title={t("read aloud")}
							aria-label={t("read aloud")}
							onClick={() => {
								play("press");
								hapticTap();
								if (quoteText) onSpeak(quoteText);
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

function ThinkingBlock({
	text,
	redacted,
	streaming = false,
}: {
	text: string;
	redacted?: boolean;
	/** True while the message is still being produced — sentences that MOUNT
	 *  during streaming play the fade-in once; settled blocks render plain
	 *  (no animation, no replay on expand). */
	streaming?: boolean;
}): ReactNode {
	const [open, setOpen] = useState(false);
	// Auto-open while the model is thinking, auto-collapse ~1s after it
	// finishes (proma Reasoning AUTO_CLOSE_DELAY parity) — but ONLY until
	// the user touches the toggle: a manual expand/collapse is respected
	// and never overridden by the auto lifecycle.
	const userTouchedRef = useRef(false);
	const autoClosedRef = useRef(false);
	const toggle = (): void => {
		userTouchedRef.current = true;
		setOpen(v => !v);
	};
	useEffect(() => {
		if (streaming && !userTouchedRef.current) setOpen(true);
	}, [streaming]);
	useEffect(() => {
		if (streaming || userTouchedRef.current || autoClosedRef.current) return;
		const timer = setTimeout(() => {
			autoClosedRef.current = true;
			setOpen(false);
		}, 1000);
		return () => clearTimeout(timer);
	}, [streaming]);
	// Body stays mounted so collapse animates too (useCollapseHeight).
	const bodyRef = useRef<HTMLDivElement | null>(null);
	useCollapseHeight(open, bodyRef);
	// Split into sentences for the progressive reveal while streaming.
	// Fence-aware: ``` blocks are atomic — a boundary inside a fence (JSON
	// `...`, a comment ending in ". ") must not split the fence across
	// sentences. Keys are STABLE indices: sentences already mounted never
	// remount (no replay on expand); only NEW sentences (mounting while
	// streaming) animate.
	const sentences = useMemo(() => (redacted ? [] : splitThinkingSentences(text)), [text, redacted]);
	// Long-thinking budget: render only the first MAX_THINK_SENTENCES
	// (a 500-sentence reasoning dump costs 500 Markdown mounts even while
	// collapsed); 展开全部 swaps in the rest.
	const [showAll, setShowAll] = useState(false);
	const shownSentences = showAll ? sentences : sentences.slice(0, MAX_THINK_SENTENCES);
	const thinkTruncated = !showAll && sentences.length > MAX_THINK_SENTENCES;
	return (
		<div className="tr-think">
			<button type="button" className="tr-think-head" onClick={toggle}>
				<ChevronRight size={11} className={`tr-chev${open ? " tr-chev--open" : ""}`} />
				<span className={redacted ? undefined : "tr-think-label"}>{t("thinking")}</span>
				{redacted ? t(" · redacted") : ""}
			</button>
			<div
				ref={bodyRef}
				className={`tr-think-body${open ? "" : " tr-think-body--closed"}`}
				style={collapseStyle(open)}
			>
				{redacted ? (
					t("(redacted by provider)")
				) : shownSentences.length > 1 ? (
					shownSentences.map((s, i) => (
						// Sentences are anonymous text splits — the index is their identity.
						// biome-ignore lint/suspicious/noArrayIndexKey: split sentences have no stable id
						// Each sentence renders through Markdown (TUI parity: thinking
						// supports inline markdown); the div wrapper keeps the reveal
						// animation outside the markdown tree.
						<div key={i} className={`tr-think-sentence${streaming ? " tr-think-sentence--live" : ""}`}>
							<Markdown text={s} />
						</div>
					))
				) : (
					<Markdown text={text} />
				)}
				{thinkTruncated && (
					<button type="button" className="tr-think-more" onClick={() => setShowAll(true)}>
						{t("expand all")}（{sentences.length.toLocaleString()}）
					</button>
				)}
			</div>
		</div>
	);
}

/** Plain text of a message for the quote/copy/edit/fork/retry actions.
 *  Full length on purpose: the per-message copy button must hand over the
 *  whole message, and edit-and-resend / fork / TTS / save-image all consume
 *  the same text (a cap would silently drop content on long messages). */
export function msgText(msg: { content?: unknown }): string {
	const c = msg.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c
			.filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && b.type === "text")
			.map(b => b.text)
			.join(" ");
	}
	return "";
}

/** Compact token counts (TUI formatNumber parity): 142, 1.8K, 453K. */
function fmtCompact(n: number): string {
	return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/**
 * TUI per-turn usage row parity (usage-row.ts formatUsageRow): local
 * wall-clock stamp + input/output/cache tokens + TTFT + duration + tok/s.
 * Rendered under the final message of each settled assistant turn.
 */
function usageRow(message: AssistantMessage): string {
	const { usage, duration, ttft, timestamp } = message;
	const parts: string[] = [];
	const d = new Date(timestamp);
	const pad = (n: number): string => String(n).padStart(2, "0");
	// Compact single line: time-only stamp, tokens, duration, tok/s (TTFT
	// dropped — the TUI only shows it when non-zero and the GUI line reads
	// cleaner without it). Cross-day messages get a MM-DD prefix so history
	// stays datable (openchamber parity).
	if (!Number.isNaN(d.getTime())) {
		const now = new Date();
		const sameDay =
			d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
		const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
		parts.push(sameDay ? time : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`);
	}
	parts.push(`↑${fmtCompact(usage.input + usage.cacheWrite)}`);
	parts.push(`↓${fmtCompact(usage.output)}`);
	if (usage.cacheRead > 0) parts.push(`☍${fmtCompact(usage.cacheRead)}`);
	if (duration !== undefined && duration > 100 && usage.output > 0) {
		parts.push(`${(duration / 1000).toFixed(1)}s`);
		parts.push(`${((usage.output / duration) * 1000).toFixed(1)}/s`);
	}
	return parts.join(" ");
}

function MsgContent({
	content,
	onPreviewImage,
}: {
	content: string | readonly (TextContent | ImageContent)[];
	/** Open the full-size image preview lightbox at this message image
	 *  (all of the message's images form the gallery). */
	onPreviewImage?(images: { src: string; alt: string }[], index: number): void;
}): ReactNode {
	// All image blocks of this message, in order — the preview gallery.
	const images = useMemo(() => {
		if (typeof content === "string") return [];
		return content
			.filter((b): b is ImageContent => b.type === "image")
			.map(b => ({ src: `data:${b.mimeType};base64,${b.data}`, alt: t("attachment") }));
	}, [content]);
	if (typeof content === "string") {
		const { content: rest, blocks } = extractCanvasJumpBlocks(content);
		return (
			<>
				<Markdown text={rest} />
				{blocks.map(b => (
					// Extracted blocks have no stable id — index is identity.
					// biome-ignore lint/suspicious/noArrayIndexKey: anonymous extracted block
					<CanvasJumpCard key={b.canvasId} block={b} />
				))}
			</>
		);
	}
	return (
		<>
			{content.map((block, i) => {
				switch (block.type) {
					case "text": {
						// Anonymous content blocks have no stable id — index is identity.
						// biome-ignore lint/suspicious/noArrayIndexKey: anonymous content block
						const { content: rest, blocks: jumps } = extractCanvasJumpBlocks(block.text);
						return (
							<Fragment key={`t${i}`}>
								<Markdown text={rest} />
								{jumps.map(j => (
									// Extracted blocks have no stable id — index is identity.
									// biome-ignore lint/suspicious/noArrayIndexKey: anonymous extracted block
									<CanvasJumpCard key={j.canvasId} block={j} />
								))}
							</Fragment>
						);
					}
					case "image": {
						// Multiple images collapse into the interactive card
						// stack (rendered after the blocks); only a lone image
						// stays a plain clickable thumbnail.
						if (images.length > 1) return null;
						const src = `data:${block.mimeType};base64,${block.data}`;
						const imgIndex = images.findIndex(img => img.src === src);
						return (
							<img
								// Anonymous content blocks have no stable id — index is identity.
								// biome-ignore lint/suspicious/noArrayIndexKey: anonymous content block
								key={`img${i}`}
								className="tr-msg-img"
								src={src}
								alt={t("attachment")}
								loading="lazy"
								decoding="async"
								role="button"
								tabIndex={0}
								title={t("preview image")}
								onClick={() => onPreviewImage?.(images, imgIndex)}
								onKeyDown={e => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										onPreviewImage?.(images, imgIndex);
									}
								}}
							/>
						);
					}
					default:
						return null;
				}
			})}
			{images.length > 1 && (
				<ImageCardStack items={images} onOpen={i => onPreviewImage?.(images, i)} />
			)}
		</>
	);
}

/** User-message text with the chat-settings variants (openchamber parity):
 * plain rendering instead of markdown, and long messages clamped to two
 * lines with an expand/collapse toggle. */
const USER_COLLAPSE_MIN_CHARS = 240;

function UserText({ text, plain, collapse }: { text: string; plain: boolean; collapse: boolean }): ReactNode {
	const [open, setOpen] = useState(false);
	const body = plain ? <span className="tr-md tr-user-plain">{text}</span> : <Markdown text={text} />;
	if (!collapse || text.length <= USER_COLLAPSE_MIN_CHARS) return body;
	return (
		<div className={`tr-md tr-user-collapse${open ? " tr-user-collapse--open" : ""}`}>
			<div className="tr-user-collapse-body">{body}</div>
			<button type="button" className="tr-user-collapse-toggle" onClick={() => setOpen(v => !v)}>
				{t(open ? "collapse" : "expand")}
			</button>
		</div>
	);
}

function UserMsgContent({
	content,
	plain,
	collapse,
	onPreviewImage,
}: {
	content: string | readonly (TextContent | ImageContent)[];
	plain: boolean;
	collapse: boolean;
	/** Open the full-size image preview lightbox at this message image
	 *  (all of the message's images form the gallery). */
	onPreviewImage?(images: { src: string; alt: string }[], index: number): void;
}): ReactNode {
	// All image blocks of this message, in order — the preview gallery.
	const images = useMemo(() => {
		if (typeof content === "string") return [];
		return content
			.filter((b): b is ImageContent => b.type === "image")
			.map(b => ({ src: `data:${b.mimeType};base64,${b.data}`, alt: t("attachment") }));
	}, [content]);
	if (typeof content === "string") return <UserText text={content} plain={plain} collapse={collapse} />;
	return (
		<>
			{content.map((block, i) => {
				switch (block.type) {
					case "text":
						// Anonymous content blocks have no stable id — index is identity.
						// biome-ignore lint/suspicious/noArrayIndexKey: anonymous content block
						return <UserText key={`t${i}`} text={block.text} plain={plain} collapse={collapse} />;
					case "image": {
						// Multiple images collapse into the interactive card
						// stack (rendered after the blocks); only a lone image
						// stays a plain clickable thumbnail.
						if (images.length > 1) return null;
						const src = `data:${block.mimeType};base64,${block.data}`;
						const imgIndex = images.findIndex(img => img.src === src);
						return (
							<img
								// Anonymous content blocks have no stable id — index is identity.
								// biome-ignore lint/suspicious/noArrayIndexKey: anonymous content block
								key={`img${i}`}
								className="tr-msg-img"
								src={src}
								alt={t("attachment")}
								loading="lazy"
								decoding="async"
								role="button"
								tabIndex={0}
								title={t("preview image")}
								onClick={() => onPreviewImage?.(images, imgIndex)}
								onKeyDown={e => {
									if (e.key === "Enter" || e.key === " ") {
										e.preventDefault();
										onPreviewImage?.(images, imgIndex);
									}
								}}
							/>
						);
					}
					default:
						return null;
				}
			})}
			{images.length > 1 && (
				<ImageCardStack items={images} onOpen={i => onPreviewImage?.(images, i)} />
			)}
		</>
	);
}

/** ZCode-style live "已工作 X 秒" row under the working message — craft-agents
 *  ProcessingIndicator parity: the shared 1s ticker derives elapsed from a
 *  DATA anchor (`start` = the round's last-user-message timestamp), so
 *  switching sessions and back does NOT restart the count. A completed round
 *  (`freezeMs` = the frozen round duration recorded at agent_end) renders a
 *  static total with the spinner dropped — each round's total stays under
 *  its final message ("每轮单独计时"). */
function WorkingLine({ start, freezeMs }: { start: number; freezeMs?: number }): ReactNode {
	const now = useWorkingNow(freezeMs === undefined);
	const seconds =
		freezeMs !== undefined
			? Math.max(0, Math.round(freezeMs / 1000))
			: Math.max(0, Math.round((now - start) / 1000));
	const label = freezeMs !== undefined ? t("took {seconds}s", { seconds }) : t("working for {seconds}s", { seconds });
	return (
		<div className="tr-working" role="status">
			{freezeMs === undefined && <span className="tr-working-spin" aria-hidden="true" />}
			{label}
		</div>
	);
}

/** Round anchor (craft-agents parity: "Find the last user message timestamp
 *  for accurate elapsed time"): the timestamp of the last user message — the
 *  round's start, stable across component remounts. */
function lastUserMessageTs(entries: readonly SessionEntry[]): number | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type === "message" && e.message.role === "user") return e.message.timestamp;
	}
	return undefined;
}

/** TUI TtsrNotificationComponent parity: rule violation → stream rewind →
 *  rule inject warning block (warning-tinted, collapsible description). */
function TtsrBlock({ rules }: { rules: { name: string; description?: string; content?: string }[] }): ReactNode {
	const [open, setOpen] = useState(false);
	const bodyRef = useRef<HTMLDivElement | null>(null);
	useCollapseHeight(open, bodyRef);
	return (
		<div className="tr-ttsr" role="status">
			<button type="button" className="tr-ttsr-head" onClick={() => setOpen(v => !v)} aria-expanded={open}>
				<span className="tr-ttsr-icon" aria-hidden="true">
					⚠
				</span>
				<span className="tr-ttsr-title">{t("rules injected")}</span>
				<span className="tr-ttsr-names">{rules.map(r => r.name).join("、")}</span>
				<ChevronRight size={11} className={`tr-chev${open ? " tr-chev--open" : ""}`} />
			</button>
			<div
				ref={bodyRef}
				className={`tr-ttsr-body${open ? "" : " tr-ttsr-body--closed"}`}
				style={collapseStyle(open)}
			>
				<div className="tr-ttsr-desc">{t("rules injected desc")}</div>
				{rules.map(r => (
					<div key={r.name} className="tr-ttsr-rule">
						<span className="tr-ttsr-rule-name">{r.name}</span>
						{(r.description || r.content) && (
							<span className="tr-ttsr-rule-desc">{(r.description || (r.content ?? "")).slice(0, 200)}</span>
						)}
					</div>
				))}
			</div>
		</div>
	);
}

function AssistantBody({
	message,
	results,
	active,
	pending,
	runStartTs,
	roundDuration,
	host,
	hideToolActivity = false,
	showTokenUsage = false,
	smoothStreaming = true,
}: {
	message: AssistantMessage;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	/** Still streaming — suppress stop-reason chips on the partial message. */
	pending: boolean;
	/** Round start (last user message ts) — the live ticker's anchor so the
	 *  count spans the whole working period, including tool execution. */
	runStartTs?: number;
	/** Frozen round duration (ms, recorded at agent_end) — renders the
	 *  completed round's total under its final message. */
	roundDuration?: number;
	host?: ToolRenderHost;
	/** display.hideToolActivity parity: drop toolCall cards. */
	hideToolActivity?: boolean;
	/** display.showTokenUsage parity: gate the per-turn usage row. */
	showTokenUsage?: boolean;
	/** display.smoothStreaming parity: false disables the reveal. */
	smoothStreaming?: boolean;
}): ReactNode {
	// Caret goes on the LAST text block only (not the last block of any
	// kind — a trailing thinking/tool block must not get the caret).
	const lastTextIdx = message.content.map(b => b.type).lastIndexOf("text");
	const blocks = message.content.map((block, i) => {
		switch (block.type) {
			case "thinking": {
				// openchamber ReasoningPart parity: never render an EMPTY
				// thinking block once the message is complete — but while
				// streaming, an empty block means the model is thinking with no
				// text yet: show a lightweight loading line (animated dots)
				// instead of nothing (user: thinking state without content).
				const text = (block.thinking ?? "").trim();
				if (!text) {
					if (!pending) return null;
					// Anonymous content blocks have no stable id — index is identity.
					// biome-ignore lint/suspicious/noArrayIndexKey: anonymous content block
					return (
						<div key={`k${i}`} className="tr-think tr-think--pending" role="status">
							<span className="tr-think-label">{t("thinking")}</span>
							<span className="tr-think-dots" aria-hidden>
								<i />
								<i />
								<i />
							</span>
						</div>
					);
				}
				// Anonymous content blocks have no stable id — index is identity.
				// biome-ignore lint/suspicious/noArrayIndexKey: anonymous content block
				return <ThinkingBlock key={`k${i}`} text={block.thinking} streaming={pending} />;
			}
			case "redactedThinking":
				// biome-ignore lint/suspicious/noArrayIndexKey: anonymous content block
				return <ThinkingBlock key={`k${i}`} text="" redacted />;
			case "text":
				// biome-ignore lint/suspicious/noArrayIndexKey: anonymous content block
				return (
					<Markdown
						key={`t${i}`}
						text={block.text}
						streaming={pending && i === lastTextIdx}
						smoothStreaming={smoothStreaming}
					/>
				);
			case "toolCall": {
				if (hideToolActivity) return null;
				const act = active.get(block.id);
				const result = results.get(block.id);
				const args = act?.args ?? block.arguments;
				return (
					<ToolCard
						key={block.id}
						toolCallId={block.id}
						name={block.name}
						intent={block.intent ?? act?.intent}
						args={args}
						result={result}
						host={host}
						running={!result && (act !== undefined || pending)}
						partialResult={act?.partialResult}
					/>
				);
			}
			default:
				return null;
		}
	});
	const stop = message.stopReason;
	const failed = !pending && (stop === "error" || stop === "aborted");
	// ZCode-style artifact cards: final files this turn produced, deduped
	// (last write wins), shown once their tool results have settled.
	const artifacts = useMemo(
		() => turnArtifacts(message.content, results),
		// message.content is a stable array per message; results map identity
		// changes on every session update — recompute is cheap (few blocks).
		[message.content, results],
	);
	return (
		<>
			{blocks}
			{failed && (
				<div className="tr-stop">
					<span className={`tr-chip ${stop === "error" ? "tr-chip--err" : "tr-chip--warn"}`}>{stop}</span>
					{message.errorMessage !== undefined && message.errorMessage.length > 0 && (
						<span className="tr-stop-msg">{message.errorMessage}</span>
					)}
				</div>
			)}
			{!pending && artifacts.length > 0 && <FileCards items={artifacts} />}
			{/* Standalone widget display (config 开启): the visualization
			 * renders as its own adaptive card in the message flow, like a
			 * file-preview card — the tool-call card folds to its summary. */}
			{!pending && <WidgetStandaloneCards content={message.content} results={results} host={host} />}
			{pending ? (
				<WorkingLine start={runStartTs ?? message.timestamp} />
			) : roundDuration !== undefined ? (
				<WorkingLine start={0} freezeMs={roundDuration} />
			) : null}
			{showTokenUsage && !pending && !failed && message.duration !== undefined && (
				<div className="tr-usage">{usageRow(message)}</div>
			)}
		</>
	);
}

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
	showTokenUsage?: boolean;
	smoothStreaming?: boolean;
	onQuote?(text: string): void;
	onEdit?(messageId: string, text: string): void;
	onRetry?(messageId: string, text: string): void;
	onRevert?(messageId: string, text: string): void;
	onFork?(messageId: string, text: string): void;
	onSpeak?(text: string): void;
	onSaveImage?(text: string, element: HTMLElement | null): void | Promise<void>;
	/** Open the full-size image preview lightbox (transcript-level state). */
	onPreviewImage?(images: { src: string; alt: string }[], index: number): void;
	/** The user message whose reply this assistant row is (retry target). */
	retryTarget?: { id: string; text: string } | null;
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
		prev.smoothStreaming !== next.smoothStreaming
	) {
		return false;
	}
	if (prev.onQuote !== next.onQuote || prev.onEdit !== next.onEdit || prev.onRetry !== next.onRetry) return false;
	if (prev.onRevert !== next.onRevert || prev.onFork !== next.onFork) return false;
	if (prev.retryTarget !== next.retryTarget) return false;
	if (prev.onSpeak !== next.onSpeak || prev.onSaveImage !== next.onSaveImage) return false;
	if (prev.onPreviewImage !== next.onPreviewImage) return false;
	const e = next.entry;
	if (e.type !== "message" || e.message.role !== "assistant") return true;
	for (const block of e.message.content) {
		if (block.type !== "toolCall") continue;
		if (prev.results.get(block.id) !== next.results.get(block.id)) return false;
		if (prev.active.get(block.id) !== next.active.get(block.id)) return false;
	}
	return true;
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
	showTokenUsage = false,
	smoothStreaming = true,
	onQuote,
	onEdit,
	onRetry,
	onRevert,
	onFork,
	onSpeak,
	onSaveImage,
	onPreviewImage,
	retryTarget,
}: EntryRowProps): ReactNode {
	switch (entry.type) {
		case "message": {
			const msg = entry.message;
			switch (msg.role) {
				case "user":
					return (
						<Row
							kind="user"
							id={entry.id}
							gutter={userGutter ?? t("host")}
							title={entry.timestamp}
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
							gutter={agentGutter ?? t("agent")}
							title={entry.timestamp}
							onQuote={onQuote}
							onRetry={onRetry}
							onSpeak={onSpeak}
							onSaveImage={onSaveImage}
							quoteText={msgText(msg)}
							retryTarget={retryTarget}
						>
							<AssistantBody
								message={msg}
								results={results}
								active={active}
								pending={streamingLast}
								runStartTs={runStartTs}
								roundDuration={roundDuration}
								host={host}
								hideToolActivity={hideToolActivity}
								showTokenUsage={showTokenUsage}
								smoothStreaming={smoothStreaming}
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
		case "custom_message": {
			if (entry.customType === "collab-prompt") {
				const details = entry.details;
				const from =
					details !== null &&
					typeof details === "object" &&
					typeof (details as Record<string, unknown>).from === "string"
						? ((details as Record<string, unknown>).from as string)
						: t("guest");
				return (
					<Row kind="user" gutter={<span className="tr-badge">{from}</span>} title={entry.timestamp}>
						<MsgContent content={entry.content} onPreviewImage={onPreviewImage} />
					</Row>
				);
			}
			if (entry.customType === "ttsr") {
				const details = entry.details as
					| { rules?: { name: string; description?: string; content?: string }[] }
					| null
					| undefined;
				return (
					<Row kind="custom" gutter="" title={entry.timestamp}>
						<TtsrBlock rules={details?.rules ?? []} />
					</Row>
				);
			}
			if (entry.customType.startsWith("irc:")) {
				const details = entry.details as { from?: string; message?: string } | null | undefined;
				const from = details?.from ?? "irc";
				return (
					<Row kind="custom" gutter={<span className="tr-badge">{from}</span>} title={entry.timestamp}>
						<div className="tr-irc">
							<MsgContent content={entry.content} onPreviewImage={onPreviewImage} />
						</div>
					</Row>
				);
			}
			if (!entry.display) return null;
			return (
				<Row kind="custom" gutter="" title={entry.timestamp}>
					<div className="tr-custom">
						<span className="tr-chip">{entry.customType}</span>
						<MsgContent content={entry.content} onPreviewImage={onPreviewImage} />
					</div>
				</Row>
			);
		}
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
}, entryRowEqual);

export function Transcript(props: TranscriptProps): ReactNode {
	const {
		entries,
		stream,
		streamDone,
		activeTools,
		working,
		roundDurations,
		compact,
		host,
		userGutter,
		agentGutter,
		userPlain = false,
		collapseLongUserMessages = false,
		smoothStreaming = true,
		hideToolActivity = false,
		showTokenUsage = false,
		collapseCompacted = false,
		colorBlind = false,
		onQuote,
		onEdit,
		onRetry,
		onRevert,
		onFork,
		onSpeak,
		onSaveImage,
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

	// display.collapseCompacted parity: fold everything before the FIRST
	// compaction divider behind a toggle row ("show pre-compaction
	// history"). Applies to the windowed slice — history outside the
	// window is hidden by the windowing anyway.
	const [compactedOpen, setCompactedOpen] = useState(false);
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
	const lockRef = useRef(true);
	const prevLenRef = useRef(entries.length);
	const [visibleCount, setVisibleCount] = useState(WINDOW_INITIAL);
	const [avgRowH, setAvgRowH] = useState(AVG_ROW_HEIGHT);
	const sentinelRef = useRef<HTMLDivElement | null>(null);

	// The scrolling host differs per consumer: the desktop GUI scrolls an
	// OUTER .gui-transcript (this component's .tr-root is expanded and
	// static there), the web shell scrolls .tr-root itself. Resolve once
	// on mount — every scroll-affecting path (lock tracking, bottom
	// follow) must talk to the real scroller or it silently no-ops.
	const scrollerRef = useRef<HTMLElement | null>(null);
	useLayoutEffect(() => {
		scrollerRef.current = rootRef.current?.closest<HTMLElement>(".gui-transcript") ?? rootRef.current;
	}, []);

	const hidden = Math.max(0, entries.length - visibleCount);
	const slice = hidden > 0 ? entries.slice(hidden) : entries;

	// Extend the window when the sentinel enters the visible pane. The
	// scroller is an ANCESTOR of .tr-root in both hosts (GUI
	// .gui-transcript, web .sh-transcript); observing with it as the root
	// keeps the sentinel tied to the pane, not the viewport.
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
				if (entry?.isIntersecting) {
					setVisibleCount(c => Math.min(entries.length, c + WINDOW_STEP));
				}
			},
			{ root: scroller, rootMargin: "480px 0px" },
		);
		obs.observe(el);
		return () => obs.disconnect();
	}, [hidden > 0, entries.length]);

	// Refine the spacer's row-height estimate from the mounted rows.
	useLayoutEffect(() => {
		const root = rootRef.current;
		if (!root || slice.length === 0) return;
		const sentinelH = sentinelRef.current?.getBoundingClientRect().height ?? 0;
		const perRow = (root.scrollHeight - sentinelH) / slice.length;
		if (Number.isFinite(perRow) && perRow > 8 && Math.abs(perRow - avgRowH) > 4) {
			setAvgRowH(perRow);
		}
	}, [slice.length]);

	// Follow the tail while bottom-locked; releasing/re-arming happens in
	// the scroll listener below (moved off the JSX onScroll attribute —
	// that fired on .tr-root, which is NOT the scroller in the desktop
	// GUI; the listener attaches to the resolved scroller).
	useEffect(() => {
		const scroller = scrollerRef.current;
		if (!scroller) return;
		const onScroll = (): void => {
			lockRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 40;
		};
		scroller.addEventListener("scroll", onScroll);
		return () => scroller.removeEventListener("scroll", onScroll);
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
				lockRef.current = true;
			}
		}
		prevLenRef.current = entries.length;
		if (lockRef.current) el.scrollTop = el.scrollHeight;
	}, [followKey, entries]);

	// Active tools not already represented as toolCall blocks in committed rows or the stream ghost.
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
	const tailTools: ActiveTool[] = [];
	for (const tool of activeTools.values()) {
		if (!renderedToolIds.has(tool.toolCallId)) tailTools.push(tool);
	}

	return (
		<div
			ref={rootRef}
			className={`tr-root${compact === true ? " tr-root--compact" : ""}`}
			data-colorblind={colorBlind ? "true" : undefined}
		>
			{entries.length === 0 && stream === null && !working && <div className="tr-empty">{t("no activity yet")}</div>}
			{hidden > 0 && (
				<div ref={sentinelRef} className="tr-window-more" style={{ height: Math.round(hidden * avgRowH) }}>
					<button
						type="button"
						className="tr-window-more-btn"
						onClick={() => setVisibleCount(c => Math.min(entries.length, c + WINDOW_JUMP))}
					>
						{t("show earlier messages")} ({hidden})
					</button>
				</div>
			)}
			{(() => {
				// One avatar per agent turn (openchamber grouping): consecutive
				// assistant/tool messages keep the gutter empty so the orb only
				// renders on the first row of the turn. With a collapsed window
				// the first row's predecessor lives outside the slice — seed
				// the accumulator from the entry just before it.
				let prevIsAssistant = false;
				if (hidden > 0) {
					const before = entries[hidden - 1];
					if (
						before?.type === "message" &&
						(before.message.role === "assistant" || before.message.role === "toolResult")
					) {
						prevIsAssistant = true;
					}
				}
				return slice.map((entry, i) => {
					// Folded pre-compaction history: the toggle row replaces the
					// first compaction divider; everything before it is hidden.
					if (folding && i === firstCompactionIdx - hidden) {
						prevIsAssistant = false;
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
					if (folding && i < firstCompactionIdx - hidden) return null;
					const isAssistantMessage = entry.type === "message" && entry.message.role === "assistant";
					// Per-round work timer: the live tail row ticks from the
					// round start (last user message); completed rounds show
					// their frozen total under the final message.
					const isTail = isAssistantMessage && i + hidden === lastAssistantIdx;
					const streamingLast = working && isTail;
					const roundDuration = isAssistantMessage ? roundDurations?.get(entry.message.timestamp) : undefined;
					const row = (
						<EntryRow
							key={entry.id}
							entry={entry}
							results={results}
							active={activeTools}
							host={host}
							userGutter={userGutter}
							agentGutter={isAssistantMessage && prevIsAssistant ? "" : agentGutter}
							userPlain={userPlain}
							collapseLongUserMessages={collapseLongUserMessages}
							hideToolActivity={hideToolActivity}
							showTokenUsage={showTokenUsage}
							smoothStreaming={smoothStreaming}
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
							retryTarget={retryTargets.get(entry.id) ?? null}
						/>
					);
					// toolResult entries render no row but continue the turn.
					if (
						entry.type === "message" &&
						(entry.message.role === "assistant" || entry.message.role === "toolResult")
					) {
						prevIsAssistant = true;
					} else {
						prevIsAssistant = false;
					}
					return row;
				});
			})()}
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
						/>
					))}
				</Row>
			)}
			{/* The pre-stream thinking state is carried by the input-above
			    status bar (orb + text) — a transcript row with its own gutter
			    orb + 思考中 duplicated it (user: 俩 orbs and thinking). */}
			<ImageLightbox
				items={previewImg?.items ?? []}
				index={previewImg?.index ?? null}
				onClose={() => setPreviewImg(null)}
				onIndexChange={i => setPreviewImg(prev => (prev ? { ...prev, index: i } : prev))}
			/>
		</div>
	);
}
