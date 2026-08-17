import type { AssistantMessage, ImageContent, SessionEntry, TextContent, ToolResultMessage } from "@musepi/pi-wire";
import { Check, ChevronRight, Copy, GitBranch, ImageDown, MessageSquare, Pencil, RefreshCw, Undo2, Volume2 } from "lucide-react";
import { Check as CheckIconData, Copy as CopyIconData } from "lucide";
import { MorphIcon } from "morphicons/react";
import { play } from "cuelume";

/** Tap the Taptic Engine when the desktop bridge is present (electronAPI
 *  is optional - plain browsers skip it silently). */
function hapticTap(): void {
	try {
		(window as unknown as { electronAPI?: { haptic?(p?: number): Promise<unknown> } }).electronAPI?.haptic?.();
	} catch {
		// bridge unavailable
	}
}
import { Fragment, type ReactNode } from "react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import type { ActiveTool } from "../../lib/client";
import { fmtTokens } from "../../lib/format";
import { collapseStyle, useCollapseHeight } from "../../lib/use-collapse.js";
import type { ToolRenderHost } from "../../tool-render";
import { Markdown } from "./Markdown";
import { CanvasJumpCard, extractCanvasJumpBlocks } from "./canvas-jump";
import { ToolCard } from "./ToolCard";
import { FileCards, turnArtifacts } from "./FileCards";
import { splitThinkingSentences } from "./thinking-sentences";
import { useWorkingNow } from "./use-working-now";
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
const AVG_ROW_HEIGHT = 44; // px; refined by measurement once rows mount

export interface TranscriptProps {
	entries: readonly SessionEntry[];
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	working: boolean;
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
	/** Quote-a-message into the composer (ZCode 引用回复). */
	onQuote?(text: string): void;
	/** Edit: truncate to this message and restore its text (edit-and-reconverse). */
	onEdit?(messageId: string, text: string): void;
	/** Retry: resend the user message (TUI /retry parity). */
	onRetry?(text: string): void;
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
}: {
	kind: "user" | "assistant" | "custom" | "marker";
	id?: string;
	gutter: ReactNode;
	title?: string;
	children: ReactNode;
	onQuote?(text: string): void;
	/** Edit: truncate to this message and restore its text (edit-and-reconverse). */
	onEdit?(messageId: string, text: string): void;
	onRetry?(text: string): void;
	/** Revert (撤回): truncate the session to before this user message. */
	onRevert?(messageId: string, text: string): void;
	/** Fork (分叉): copy the session truncated to before this user message
	 *  into a NEW session (non-destructive — the original is untouched). */
	onFork?(messageId: string, text: string): void;
	onSpeak?(text: string): void;
	onSaveImage?(text: string): void;
	/** Pre-extracted plain text for actions (data-driven, not DOM walk). */
	quoteText?: string;
}): ReactNode {
	const [copied, setCopied] = useState(false);
	const copy = async (): Promise<void> => {
		if (!quoteText) return;
		try {
			await navigator.clipboard.writeText(quoteText);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			// clipboard unavailable
		}
	};
	return (
		<div className={`tr-row tr-row--${kind}`}>
			<div className="tr-gutter" title={title}>
				{gutter}
			</div>
			<div className="tr-body">{children}</div>
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
							<GitBranch size={13} />
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
					{onRetry && kind === "assistant" && (
						<button
							type="button"
							className="tr-action"
							title={t("retry")}
							aria-label={t("retry")}
							onClick={() => {
								if (quoteText) onRetry(quoteText);
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
						<button
							type="button"
							className="tr-action"
							title={t("save as image")}
							aria-label={t("save as image")}
							onClick={() => {
								play("press");
								hapticTap();
								if (quoteText) onSaveImage(quoteText);
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

function ThinkingBlock({ text, redacted }: { text: string; redacted?: boolean }): ReactNode {
	const [open, setOpen] = useState(false);
	// Expand-only replay tick: increments on every expand so the sentence
	// keys change (remount → aicss reveal replays). Collapse keeps the keys
	// stable so the content stays visible while the height shrinks.
	const [playTick, setPlayTick] = useState(0);
	const toggle = (): void => {
		setOpen(v => {
			if (!v) setPlayTick(t => t + 1);
			return !v;
		});
	};
	// Body stays mounted so collapse animates too (useCollapseHeight).
	const bodyRef = useRef<HTMLDivElement | null>(null);
	useCollapseHeight(open, bodyRef);
	// Split into sentences for aicss-style progressive reveal. Fence-aware:
	// ``` blocks are atomic — a boundary inside a fence (JSON `...`, a
	// comment ending in ". ") must not split the fence across sentences.
	const sentences = useMemo(
		() => (redacted ? [] : splitThinkingSentences(text)),
		[text, redacted],
	);
	return (
		<div className="tr-think">
			<button type="button" className="tr-think-head" onClick={toggle}>
				<ChevronRight size={11} className={`tr-chev${open ? " tr-chev--open" : ""}`} />
				<span className={redacted ? undefined : "tr-think-label"}>{t("thinking")}</span>
				{redacted ? t(" · redacted") : ""}
			</button>
			<div ref={bodyRef} className={`tr-think-body${open ? "" : " tr-think-body--closed"}`} style={collapseStyle(open)}>
				{redacted
					? t("(redacted by provider)")
					: sentences.length > 1
						? sentences.map((s, i) => (
								// Sentences are anonymous text splits — the index is their identity.
								// biome-ignore lint/suspicious/noArrayIndexKey: split sentences have no stable id
								// Each sentence renders through Markdown (TUI parity: thinking
								// supports inline markdown); the div wrapper keeps the reveal
								// animation outside the markdown tree.
								<div
									key={`${playTick}-${i}`}
									className="tr-think-sentence"
									style={{ animationDelay: `${i * 220}ms` }}
								>
									<Markdown text={s} />
								</div>
							))
						: <Markdown text={text} />}
			</div>
		</div>
	);
}

/** Plain text of a message for the quote action. */
function msgText(msg: { content?: unknown }): string {
	const c = msg.content;
	if (typeof c === "string") return c.slice(0, 200);
	if (Array.isArray(c)) {
		return c
			.filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && b.type === "text")
			.map(b => b.text)
			.join(" ")
			.slice(0, 200);
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

function MsgContent({ content }: { content: string | readonly (TextContent | ImageContent)[] }): ReactNode {
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
					case "image":
						return (
							<img
								// Anonymous content blocks have no stable id — index is identity.
								// biome-ignore lint/suspicious/noArrayIndexKey: anonymous content block
								key={`img${i}`}
								className="tr-msg-img"
								src={`data:${block.mimeType};base64,${block.data}`}
								alt={t("attachment")}
							/>
						);
					default:
						return null;
				}
			})}
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
}: {
	content: string | readonly (TextContent | ImageContent)[];
	plain: boolean;
	collapse: boolean;
}): ReactNode {
	if (typeof content === "string") return <UserText text={content} plain={plain} collapse={collapse} />;
	return (
		<>
			{content.map((block, i) => {
				switch (block.type) {
					case "text":
						// Anonymous content blocks have no stable id — index is identity.
						// biome-ignore lint/suspicious/noArrayIndexKey: anonymous content block
						return <UserText key={`t${i}`} text={block.text} plain={plain} collapse={collapse} />;
					case "image":
						return (
							<img
								// Anonymous content blocks have no stable id — index is identity.
								// biome-ignore lint/suspicious/noArrayIndexKey: anonymous content block
								key={`img${i}`}
								className="tr-msg-img"
								src={`data:${block.mimeType};base64,${block.data}`}
								alt={t("attachment")}
							/>
						);
					default:
						return null;
				}
			})}
		</>
	);
}

/** ZCode-style live "已工作 X 秒" row under the streaming message: the
 *  shared 1s ticker drives the clock; zero-alloc per render. */
function WorkingLine(): ReactNode {
	const startRef = useRef(Date.now());
	const now = useWorkingNow(true);
	const seconds = Math.max(0, Math.round((now - startRef.current) / 1000));
	return (
		<div className="tr-working" role="status">
			<span className="tr-working-spin" aria-hidden="true" />
			{t("working for {seconds}s", { seconds })}
		</div>
	);
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
				<span className="tr-ttsr-names">
					{rules.map(r => r.name).join("、")}
				</span>
				<ChevronRight size={11} className={`tr-chev${open ? " tr-chev--open" : ""}`} />
			</button>
			<div ref={bodyRef} className={`tr-ttsr-body${open ? "" : " tr-ttsr-body--closed"}`} style={collapseStyle(open)}>
				<div className="tr-ttsr-desc">{t("rules injected desc")}</div>
				{rules.map(r => (
					<div key={r.name} className="tr-ttsr-rule">
						<span className="tr-ttsr-rule-name">{r.name}</span>
						{(r.description || r.content) && (
							<span className="tr-ttsr-rule-desc">
								{(r.description || (r.content ?? "")).slice(0, 200)}
							</span>
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
	host,
}: {
	message: AssistantMessage;
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	/** Still streaming — suppress stop-reason chips on the partial message. */
	pending: boolean;
	host?: ToolRenderHost;
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
				return <ThinkingBlock key={`k${i}`} text={block.thinking} />;
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
					/>
				);
			case "toolCall": {
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
			{pending && <WorkingLine />}
			{!pending && !failed && message.duration !== undefined && <div className="tr-usage">{usageRow(message)}</div>}
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
	userPlain?: boolean;
	collapseLongUserMessages?: boolean;
	onQuote?(text: string): void;
	onEdit?(messageId: string, text: string): void;
	onRetry?(text: string): void;
	onRevert?(messageId: string, text: string): void;
	onFork?(messageId: string, text: string): void;
	onSpeak?(text: string): void;
	onSaveImage?(text: string): void;
}

/** Re-render only when the entry itself or one of its tool pairings changed. */
function entryRowEqual(prev: EntryRowProps, next: EntryRowProps): boolean {
	if (prev.entry !== next.entry || prev.host !== next.host) return false;
	if (prev.userGutter !== next.userGutter || prev.agentGutter !== next.agentGutter) return false;
	if (
		prev.userPlain !== next.userPlain ||
		prev.collapseLongUserMessages !== next.collapseLongUserMessages ||
		prev.streamingLast !== next.streamingLast
	) {
		return false;
	}
	if (prev.onQuote !== next.onQuote || prev.onEdit !== next.onEdit || prev.onRetry !== next.onRetry) return false;
	if (prev.onRevert !== next.onRevert || prev.onFork !== next.onFork) return false;
	if (prev.onSpeak !== next.onSpeak || prev.onSaveImage !== next.onSaveImage) return false;
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
	onQuote,
	onEdit,
	onRetry,
	onRevert,
	onFork,
	onSpeak,
	onSaveImage,
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
							<UserMsgContent content={msg.content} plain={userPlain} collapse={collapseLongUserMessages} />
						</Row>
					);
				case "assistant":
					return (
						<Row
							kind="assistant"
							gutter={agentGutter ?? t("agent")}
							title={entry.timestamp}
							onQuote={onQuote}
							onSpeak={onSpeak}
									onSaveImage={onSaveImage}
							quoteText={msgText(msg)}
						>
							<AssistantBody message={msg} results={results} active={active} pending={streamingLast} host={host} />
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
						<MsgContent content={entry.content} />
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
				const details = entry.details as
					| { from?: string; message?: string }
					| null
					| undefined;
				const from = details?.from ?? "irc";
				return (
					<Row kind="custom" gutter={<span className="tr-badge">{from}</span>} title={entry.timestamp}>
						<div className="tr-irc">
							<MsgContent content={entry.content} />
						</div>
					</Row>
				);
			}
			if (!entry.display) return null;
			return (
				<Row kind="custom" gutter="" title={entry.timestamp}>
					<div className="tr-custom">
						<span className="tr-chip">{entry.customType}</span>
						<MsgContent content={entry.content} />
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
		compact,
		host,
		userGutter,
		agentGutter,
		userPlain = false,
		collapseLongUserMessages = false,
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
		<div ref={rootRef} className={`tr-root${compact === true ? " tr-root--compact" : ""}`}>
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
					const isAssistantMessage = entry.type === "message" && entry.message.role === "assistant";
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
							streamingLast={working && isAssistantMessage && i + hidden === lastAssistantIdx}
							onQuote={onQuote}
							onEdit={onEdit}
							onRetry={onRetry}
							onRevert={onRevert}
							onFork={onFork}
							onSpeak={onSpeak}
									onSaveImage={onSaveImage}
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
						host={host}
					/>
				</Row>
			)}
			{tailTools.length > 0 && (
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
		</div>
	);
}
