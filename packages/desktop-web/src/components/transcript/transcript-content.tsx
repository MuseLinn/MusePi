/**
 * Transcript message-content renderers: pure entry -> JSX building blocks
 * (user/assistant/tool bodies, thinking blocks, round fold headers, TTSR &
 * advisor cards) plus the transcript.node compat seat and its dispatch
 * helper. Extracted from Transcript.tsx — the windowed list, Row chrome and
 * EntryRow dispatch stay there; they import from this module.
 */
import type { AssistantMessage, ImageContent, SessionEntry, TextContent, ToolResultMessage } from "@musepi/pi-wire";
import { ChevronRight } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { createElement, Fragment, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import type { ActiveTool } from "../../lib/client";
import { collapseStyle, useCollapseHeight } from "../../lib/use-collapse.js";
import type { ToolRenderHost } from "../../tool-render";
import { CanvasJumpCard, extractCanvasJumpBlocks } from "./canvas-jump";
import { type FileCardItem, FileCards } from "./FileCards";
import { ImageCardStack } from "./image-card-stack";
import { Markdown } from "./Markdown";
import { formatRoundDuration, type RoundFold } from "./round-collapse";
import { ToolCard } from "./ToolCard";
import { splitThinkingSentences } from "./thinking-sentences";
import { isUsageReport, parseUsageReport, UsageCard } from "./usage-card";
import { useWorkingNow } from "./use-working-now";
import { WidgetStandaloneCards } from "./widget-standalone";

export function ThinkingBlock({
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

/** Long-thinking budget: only this many sentences render initially; the
 *  rest mount when the user hits 展开全部 (a giant reasoning block pays
 *  ~100 Markdown mounts otherwise, even while the body is collapsed). */
export const MAX_THINK_SENTENCES = 80;

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

/** transcript.node seat 派发键 (DSH `conversation.chat.node` entryKey 类比):
 *  entry / message role -> 稳定渲染器 kind 字符串。宿主(调用方)按此派发到
 *  注册的 seat 渲染器;内置类型(a message/compaction/…) 走内建渲染,扩展可
 *  追加 (augment,经 `children`) 或贡献新 kind。 */
export function transcriptNodeKind(entry: SessionEntry): string {
	switch (entry.type) {
		case "message": {
			const role = entry.message.role;
			switch (role) {
				case "user":
					return "message:user";
				case "assistant":
					return "message:assistant";
				case "toolResult":
					return "message:tool_result";
				case "bashExecution":
					return "message:bash_execution";
				case "developer":
					return "message:developer";
				default:
					return `message:${role}`;
			}
		}
		case "custom_message":
			return `custom_message:${entry.customType}`;
		case "compaction":
			return "compaction";
		case "branch_summary":
			return "branch_summary";
		case "model_change":
			return "model_change";
		case "thinking_level_change":
			return "thinking_level_change";
		default:
			return "unknown";
	}
}

/** transcript.node seat 注入 (DSH `conversation.chat.node` analog):宿主
 *  (GUI) 提供按条目派发的渲染器 —— 按 `transcriptNodeKind(entry)` 分发,
 *  可用 `children`(内建 MusePi 渲染)增强/追加,或独立渲染。缺省 -> 仅内建
 *  渲染(inert)。调用方 MUST memoize 该回调(其身份参与 EntryRow 的
 *  memo 比较 —— 见 entryRowEqual)。 */
export type TranscriptNodeInjection = {
	/** 该 transcript 条目原始 wire 值。 */
	entry: SessionEntry;
	/** transcriptNodeKind(entry) —— seat 派发键。 */
	kind: string;
	/** 归属回合序号(尚未在渲染路径计算时缺省)。 */
	turnIndex?: number;
	/** 内建 MusePi 渲染 —— “增强而不替换” (DSH 不 replace 核心)。 */
	children: ReactNode;
};

/** Compat slot-host registry on window (populated by the `musepi serve`
 *  injected script, NOT by the bundle): kind -> extension component. The
 *  desktop-web bundle stays passive — it only READS this registry when no
 *  host injected renderTranscriptNode; guests in a plain browser have no
 *  registry and keep the built-in rendering. */
export interface MusePiCompatHost {
	register(
		slot: string,
		entryKinds: string[],
		Component: ComponentType<Record<string, unknown>>,
		extensionId: string,
	): void;
	/** Components registered for a slot (all kinds). */
	getForSlot(slot: string): Array<{
		Component: ComponentType<Record<string, unknown>>;
		extensionId: string;
		entryKinds: string[];
	}>;
	/** Components registered for a slot that own the given kind (transcript
	 *  node dispatch). */
	get(
		slot: string,
		kind: string,
	): { Component: ComponentType<Record<string, unknown>>; extensionId: string } | undefined;
}

export function compatHostRenderer(kind: string): ((node: TranscriptNodeInjection) => ReactNode) | undefined {
	const host = (globalThis as { MusePiCompatHost?: MusePiCompatHost }).MusePiCompatHost;
	const entry = host?.get("transcript.node", kind);
	if (!entry) return undefined;
	const { Component, extensionId } = entry;
	return (node: TranscriptNodeInjection) =>
		createElement(Component, {
			node: { entry: node.entry, kind: node.kind, children: node.children },
			extensionId,
			slot: "transcript.node",
			children: node.children,
		});
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
	const { usage, duration, timestamp } = message;
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

export function MsgContent({
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
		// ACP-mode `/usage` report (buildUsageReportText) renders as a card,
		// not raw monospace text — the output is code-generated with a stable
		// shape, so parsing it is safe.
		const usage = isUsageReport(content) ? parseUsageReport(content) : null;
		if (usage) return <UsageCard usage={usage} />;
		const { content: rest, blocks } = extractCanvasJumpBlocks(content);
		return (
			<>
				<Markdown text={rest} />
				{blocks.map(b => (
					// Extracted blocks have no stable id — index is identity.
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
						// /usage report → card (same as the plain-string path).
						const usage = isUsageReport(block.text) ? parseUsageReport(block.text) : null;
						if (usage) {
							return <UsageCard usage={usage} />;
						}
						// Anonymous content blocks have no stable id — index is identity.
						const { content: rest, blocks: jumps } = extractCanvasJumpBlocks(block.text);
						return (
							<Fragment key={`t${i}`}>
								<Markdown text={rest} />
								{jumps.map(j => (
									// Extracted blocks have no stable id — index is identity.
									<CanvasJumpCard key={j.canvasId} block={j} />
								))}
							</Fragment>
						);
					}
					case "image":
						// A lone image keeps its in-flow position (the old
						// thumbnail's spot); multiple images collapse into
						// one stack after the blocks (craft-agents parity).
						if (images.length > 1) return null;
						// Anonymous content blocks have no stable id — index is identity.
						return (
							<ImageCardStack key={`img${i}`} items={images} onOpen={idx => onPreviewImage?.(images, idx)} />
						);
					default:
						return null;
				}
			})}
			{images.length > 1 && <ImageCardStack items={images} onOpen={i => onPreviewImage?.(images, i)} />}
		</>
	);
}

/** User-message text with the chat-settings variants (openchamber parity):
 * plain rendering instead of markdown, and long messages clamped to two
 * lines with an expand/collapse toggle. */
const USER_COLLAPSE_MIN_CHARS = 240;

export function UserText({ text, plain, collapse }: { text: string; plain: boolean; collapse: boolean }): ReactNode {
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

export function UserMsgContent({
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
						return <UserText key={`t${i}`} text={block.text} plain={plain} collapse={collapse} />;
					case "image":
						// A lone image keeps its in-flow position (the old
						// thumbnail's spot); multiple images collapse into
						// one stack after the blocks (craft-agents parity).
						if (images.length > 1) return null;
						// Anonymous content blocks have no stable id — index is identity.
						return (
							<ImageCardStack key={`img${i}`} items={images} onOpen={idx => onPreviewImage?.(images, idx)} />
						);
					default:
						return null;
				}
			})}
			{images.length > 1 && <ImageCardStack items={images} onOpen={i => onPreviewImage?.(images, i)} />}
		</>
	);
}

/** Escalate granularity as the round grows: <1 min → seconds only,
 *  <1 h → minutes+seconds, ≥1 h → hours+minutes+seconds — long tasks stay
 *  readable ("已工作 17 分 49 秒" / "1 时 2 分 3 秒") instead of a bare
 *  seconds counter. */
export function workingLabel(kind: "working" | "took", seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	if (h > 0)
		return kind === "working"
			? t("working for {hours}h {minutes}m {seconds}s", { hours: h, minutes: m, seconds: s })
			: t("took {hours}h {minutes}m {seconds}s", { hours: h, minutes: m, seconds: s });
	if (m > 0)
		return kind === "working"
			? t("working for {minutes}m {seconds}s", { minutes: m, seconds: s })
			: t("took {minutes}m {seconds}s", { minutes: m, seconds: s });
	return kind === "working" ? t("working for {seconds}s", { seconds }) : t("took {seconds}s", { seconds });
}

/** `model · level` badge for the work-timer row — the model id plus the
 *  auto-classified (or user-picked) thinking effort. Omitted when neither
 *  is known (ancient sessions, model-less tool messages). */
export function modelLevelMeta(model: string | undefined, thinkingLevel: string | undefined): string | undefined {
	if (!model && !thinkingLevel) return undefined;
	return [model, thinkingLevel].filter((v): v is string => v !== undefined && v.length > 0).join(" · ");
}

/** ZCode-style live "已工作 X 秒" row under the working message — craft-agents
 *  ProcessingIndicator parity: the shared 1s ticker derives elapsed from a
 *  DATA anchor (`start` = the round's last-user-message timestamp), so
 *  switching sessions and back does NOT restart the count. A completed round
 *  (`freezeMs` = the frozen round duration recorded at agent_end) renders a
 *  static total with the spinner dropped — each round's total stays under
 *  its final message ("每轮单独计时"). */
export function WorkingLine({
	start,
	freezeMs,
	meta,
}: {
	start: number;
	freezeMs?: number;
	/** `model · level` badge beside the timer — shows the model and the
	 *  auto-classified (or user-picked) thinking effort this round used. */
	meta?: string;
}): ReactNode {
	const now = useWorkingNow(freezeMs === undefined);
	const seconds =
		freezeMs !== undefined ? Math.max(0, Math.round(freezeMs / 1000)) : Math.max(0, Math.round((now - start) / 1000));
	const label = workingLabel(freezeMs !== undefined ? "took" : "working", seconds);
	return (
		<div className="tr-working" role="status">
			{freezeMs === undefined && <span className="tr-working-spin" aria-hidden="true" />}
			{label}
			{meta !== undefined && <span className="tr-working-meta">{meta}</span>}
		</div>
	);
}

/** Round anchor (craft-agents parity: "Find the last user message timestamp
 *  for accurate elapsed time"): the timestamp of the last user message — the
 *  round's start, stable across component remounts. */
export function lastUserMessageTs(entries: readonly SessionEntry[]): number | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type === "message" && e.message.role === "user") return e.message.timestamp;
	}
	return undefined;
}

/** Completed-round fold header (craft-agents TurnCard parity): chevron +
 *  frozen work duration (hh:mm:ss) + tool/command counts + a working
 *  preview. Clicking expands the round's tool activities back inline. */
export function RoundFoldHeader({
	fold,
	open,
	onToggle,
}: {
	fold: RoundFold;
	open: boolean;
	onToggle(): void;
}): ReactNode {
	return (
		<button type="button" className={`tr-round-fold${open ? " tr-round-fold--open" : ""}`} onClick={onToggle}>
			<ChevronRight size={12} className="tr-round-fold-chevron" />
			<span className="tr-round-fold-duration">{formatRoundDuration(fold.durationMs)}</span>
			{fold.toolCount > 0 && (
				<span className="tr-round-fold-count">{t("round tools {count}", { count: String(fold.toolCount) })}</span>
			)}
			{fold.commandCount > 0 && (
				<span className="tr-round-fold-count">
					{t("round commands {count}", { count: String(fold.commandCount) })}
				</span>
			)}
			<span className="tr-round-fold-preview">{fold.preview}</span>
		</button>
	);
}

/** TUI TtsrNotificationComponent parity: rule violation → stream rewind →
 *  rule inject warning block (warning-tinted, collapsible description). */
export function TtsrBlock({ rules }: { rules: { name: string; description?: string; content?: string }[] }): ReactNode {
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

/** TUI createAdvisorMessageCard parity: batched advisor notes rendered as a
 *  distinct voice — severity-tinted rail + badge, blocker count in the meta,
 *  collapse past 3 notes. Reads `details.notes[]` (clean note text), NEVER the
 *  model-facing `<advisory>` content template. */
export type AdvisorNote = { note?: string; severity?: string; advisor?: string };
export function AdvisorBlock({ notes }: { notes: AdvisorNote[] }): ReactNode {
	const [open, setOpen] = useState(false);
	const bodyRef = useRef<HTMLDivElement | null>(null);
	useCollapseHeight(open, bodyRef);
	const blockers = notes.filter(n => n.severity === "blocker").length;
	const shown = open ? notes : notes.slice(0, 3);
	const hidden = notes.length - shown.length;
	return (
		<div className="tr-advisor" role="status">
			<button type="button" className="tr-advisor-head" onClick={() => setOpen(v => !v)} aria-expanded={open}>
				<span className="tr-advisor-tag">{t("advisor")}</span>
				<span className="tr-advisor-meta">
					{t("advisor notes", { count: notes.length })}
					{blockers > 0 ? ` · ${t("advisor blockers", { count: blockers })}` : ""}
				</span>
				<ChevronRight size={11} className={`tr-chev${open ? " tr-chev--open" : ""}`} />
			</button>
			<div
				ref={bodyRef}
				className={`tr-advisor-body${open ? "" : " tr-advisor-body--closed"}`}
				style={collapseStyle(open)}
			>
				{shown.map((note, i) => (
					<div key={i} className={`tr-advisor-note${note.severity ? ` tr-advisor-note--${note.severity}` : ""}`}>
						<span className="tr-advisor-rail" aria-hidden />
						<div className="tr-advisor-main">
							<div className="tr-advisor-notehead">
								{note.severity ? <span className="tr-advisor-badge">{note.severity}</span> : null}
								{note.advisor && note.advisor !== "default" ? (
									<span className="tr-advisor-who">[{note.advisor}]</span>
								) : null}
							</div>
							<div className="tr-advisor-notebody">{note.note}</div>
						</div>
					</div>
				))}
				{hidden > 0 ? <div className="tr-advisor-more">{t("advisor more", { count: hidden })}</div> : null}
			</div>
		</div>
	);
}

export function AssistantBody({
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
	taskCardStyle = "swarm",
	/** Turn-final aggregated file artifacts (本轮文件卡片展示在最底部):
	 *  set only on the turn's FINAL assistant message; undefined elsewhere. */
	artifacts,
	/** Session thinking level — rendered as `model · level` beside the work
	 *  timer (auto-thinking transparency). */
	thinkingLevel,
	/** Open the transcript full-size image preview (lightbox) for this turn's
	 *  hoisted tool-result media. */
	onPreviewImage,
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
	/** display.taskCardStyle parity: "classic" swaps the swarm member grid
	 *  card for the plain tool-call card. */
	taskCardStyle?: "swarm" | "classic";
	/** Turn-final aggregated file artifacts (see above). */
	artifacts?: FileCardItem[];
	/** Session thinking level — rendered as `model · level` beside the work
	 *  timer (auto-thinking transparency). */
	thinkingLevel?: string;
	/** Open the transcript full-size image preview (lightbox) for this turn's
	 *  hoisted tool-result media. */
	onPreviewImage?: (images: { src: string; alt: string }[], index: number) => void;
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
				return <ThinkingBlock key={`k${i}`} text={block.thinking} streaming={pending} />;
			}
			case "redactedThinking":
				return <ThinkingBlock key={`k${i}`} text="" redacted />;
			case "text":
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
						taskCardStyle={taskCardStyle}
						onPreviewImage={onPreviewImage}
					/>
				);
			}
			default:
				return null;
		}
	});
	const stop = message.stopReason;
	const failed = !pending && (stop === "error" || stop === "aborted");
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
			{!pending && artifacts !== undefined && <FileCards items={artifacts} />}
			{/* Standalone widget display (config 开启): the visualization
			 * renders as its own adaptive card in the message flow, like a
			 * file-preview card — the tool-call card folds to its summary. */}
			{!pending && <WidgetStandaloneCards content={message.content} results={results} host={host} />}
			{pending ? (
				<WorkingLine start={runStartTs ?? message.timestamp} meta={modelLevelMeta(message.model, thinkingLevel)} />
			) : roundDuration !== undefined ? (
				<WorkingLine start={0} freezeMs={roundDuration} meta={modelLevelMeta(message.model, thinkingLevel)} />
			) : null}
			{showTokenUsage && !pending && !failed && message.duration !== undefined && (
				<div className="tr-usage">{usageRow(message)}</div>
			)}
		</>
	);
}
