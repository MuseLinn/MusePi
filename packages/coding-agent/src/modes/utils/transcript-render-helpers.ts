/**
 * Render helpers shared between the live transcript ({@link UiHelpers}) and the
 * file/remote-backed {@link ChatTranscriptBuilder}. Both surfaces build the same
 * transcript rows from persisted message entries; holding the row construction
 * here keeps the two byte-for-byte identical.
 */
import type { AgentMessage } from "@musepi/pi-agent-core";
import { type Component, Text } from "@musepi/pi-tui";
import { formatBytes, formatDuration } from "@musepi/pi-utils";
import { asyncJobResultView } from "@musepi/pi-wire";
import {
	type CustomMessage,
	type FileMentionMessage,
	resolveAbortLabel,
	shouldRenderAbortReason,
} from "../../session/messages";
import { createIrcMessageCard } from "../../tools/hub";
import {
	createCachedComponent,
	Ellipsis,
	getPreviewLines,
	replaceTabs,
	type ToolUIColor,
	type ToolUIStatus,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "../../tools/render-utils";
import { renderStatusLine } from "../../tui";
import { canonicalizeMessage } from "../../utils/thinking-display";
import { ToolActivityContainer } from "../components/tool-activity";
import { TranscriptBlock } from "../components/transcript-container";
import { theme } from "../theme/theme";

type CustomOrHookMessage = Extract<AgentMessage, { role: "custom" | "hookMessage" }>;
type AssistantAgentMessage = Extract<AgentMessage, { role: "assistant" }>;

/**
 * Render an `async-result` custom message (a completed background bash/task job,
 * or a batch of them) as a transcript block of one "Background job completed"
 * row per job.
 */
export function buildAsyncResultBlock(message: CustomOrHookMessage): ToolActivityContainer {
	const details = (
		message as CustomMessage<{
			jobId?: string;
			type?: "bash" | "task" | "agnes-video";
			label?: string;
			durationMs?: number;
			jobs?: Array<{ jobId?: string; type?: "bash" | "task" | "agnes-video"; label?: string; durationMs?: number }>;
		}>
	).details;
	const jobs =
		details?.jobs && details.jobs.length > 0
			? details.jobs
			: [
					{
						jobId: details?.jobId,
						type: details?.type,
						label: details?.label,
						durationMs: details?.durationMs,
					},
				];
	const block = new TranscriptBlock();
	for (const job of jobs) {
		const jobId = job.jobId ?? "unknown";
		const typeLabel = job.type ? `[${job.type}]` : "[job]";
		const duration = typeof job.durationMs === "number" ? formatDuration(job.durationMs) : undefined;
		const line = [
			theme.fg("success", `${theme.status.done} Background job completed`),
			theme.fg("dim", typeLabel),
			theme.fg("accent", jobId),
			duration ? theme.fg("dim", `(${duration})`) : undefined,
		]
			.filter(Boolean)
			.join(" ");
		block.addChild(new Text(line, 1, 0));
	}
	return new ToolActivityContainer(block);
}

const ASYNC_JOB_COLLAPSED_LINES = 6;
const ASYNC_JOB_EXPANDED_LINES = 60;

function asyncJobStatusIcon(status: string): ToolUIStatus {
	switch (status.toLowerCase()) {
		case "completed":
			return "done";
		case "failed":
			return "error";
		case "cancelled":
		case "canceled":
			return "aborted";
		case "running":
			return "running";
		default:
			return "info";
	}
}

function asyncJobStatusColor(status: string): ToolUIColor {
	switch (status.toLowerCase()) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "cancelled":
		case "canceled":
			return "warning";
		case "running":
			return "accent";
		default:
			return "muted";
	}
}

/**
 * Render an `async-job-result` settlement card: a status line (outcome, agent,
 * type, duration) over a bounded output preview plus the trailing idle /
 * `history://` hint. `content` is the model-facing `<task-result>` envelope, so
 * only `asyncJobResultView` reads it and the markup never reaches the screen.
 */
export function buildAsyncJobResultBlock(message: CustomOrHookMessage, getExpanded: () => boolean): Component {
	const view = asyncJobResultView(message.content, message.details);
	const meta = [
		view.type ? `[${view.type}]` : undefined,
		view.duration ? `(${view.duration})` : undefined,
		view.lines ? `${view.lines} lines` : undefined,
		view.size,
	].filter((part): part is string => part !== undefined && part.trim().length > 0);
	return createCachedComponent(
		getExpanded,
		(width, expanded) => {
			const lines = [
				renderStatusLine(
					{
						icon: asyncJobStatusIcon(view.status),
						title: view.label,
						badge: { label: view.status, color: asyncJobStatusColor(view.status) },
						meta,
					},
					theme,
				),
			];
			if (view.output) {
				const max = expanded ? ASYNC_JOB_EXPANDED_LINES : ASYNC_JOB_COLLAPSED_LINES;
				const preview = getPreviewLines(view.output, max, Math.max(40, width - 4), Ellipsis.Unicode);
				const quote = `  ${theme.fg("dim", "│")} `;
				for (const line of preview) {
					lines.push(`${quote}${theme.fg("toolOutput", replaceTabs(line))}`);
				}
				const total = view.output.split("\n").filter(line => line.trim().length > 0).length;
				const hidden = total - Math.min(total, max);
				if (!expanded && hidden > 0) {
					lines.push(`${quote}${theme.fg("dim", `… +${hidden} more ${hidden === 1 ? "line" : "lines"}`)}`);
				}
			}
			if (view.hint) lines.push(`  ${theme.fg("dim", replaceTabs(view.hint.replace(/`/g, "")))}`);
			return lines.map(line => truncateToWidth(line, width, Ellipsis.Unicode));
		},
		{ paddingX: 1 },
	);
}

/**
 * Render a live IRC traffic custom message (`irc:incoming` / `irc:autoreply` /
 * `irc:relay`) as a transcript card. `getExpanded` supplies the live
 * expanded-state getter for the cached card.
 */
export function buildIrcMessageCard(message: CustomOrHookMessage, getExpanded: () => boolean): Component {
	const details = (
		message as CustomMessage<{ from?: string; to?: string; message?: string; body?: string; replyTo?: string }>
	).details;
	const kind =
		message.customType === "irc:incoming"
			? ("incoming" as const)
			: message.customType === "irc:autoreply"
				? ("autoreply" as const)
				: ("relay" as const);
	return createIrcMessageCard(
		{
			kind,
			from: details?.from,
			to: details?.to,
			body: kind === "incoming" ? details?.message : details?.body,
			replyTo: details?.replyTo,
			timestamp: message.timestamp,
		},
		getExpanded,
		theme,
	);
}

/**
 * Render a `fileMention` message's files as a transcript block of "Read <path>"
 * rows. `indent` sets the left pad: the live chat renders within an outer gutter
 * (0), the transcript viewer renders body rows without one so rows own their pad
 * (1).
 */
export function buildFileMentionBlock(files: FileMentionMessage["files"], indent: number): TranscriptBlock {
	const block = new TranscriptBlock();
	for (const file of files) {
		let suffix: string;
		if (file.skippedReason === "tooLarge" || file.skippedReason === "binary") {
			const size = typeof file.byteSize === "number" ? formatBytes(file.byteSize) : "unknown size";
			suffix = file.skippedReason === "binary" ? `(skipped: binary, ${size})` : `(skipped: ${size})`;
		} else {
			suffix = file.image
				? "(image)"
				: file.lineCount === undefined
					? "(unknown lines)"
					: `(${file.lineCount} lines)`;
		}
		const text = `${theme.fg("dim", `${theme.tree.last} `)}${theme.fg("muted", "Read")} ${theme.fg(
			"accent",
			file.path,
		)} ${theme.fg("dim", suffix)}`;
		block.addChild(new Text(text, indent, 0));
	}
	return block;
}

/**
 * Whether an assistant turn has visible text, thinking, or image content — i.e.
 * content that closes the current read-tool run.
 */
export function assistantHasVisibleContent(message: AssistantAgentMessage): boolean {
	return message.content.some(
		content =>
			content.type === "image" ||
			(content.type === "text" && canonicalizeMessage(content.text)) ||
			(content.type === "thinking" && canonicalizeMessage(content.thinking)),
	);
}

/**
 * Split mixed assistant turns into visible text before tool execution and
 * visible text segments that must render immediately after the preceding tool.
 * Cursor can return intro text, tool calls, progress text, and the final answer
 * in one assistant message; keeping every text block in the leading assistant
 * block buries post-tool text above tool results in the transcript.
 */
export function splitAssistantMessageToolTimeline(message: AssistantAgentMessage): {
	beforeTools: AssistantAgentMessage;
	afterToolCalls: ReadonlyMap<string, AssistantAgentMessage>;
	hasToolCalls: boolean;
} {
	const beforeTools: AssistantAgentMessage["content"] = [];
	const afterToolCalls = new Map<string, AssistantAgentMessage>();
	let pendingAfterTool: AssistantAgentMessage["content"] = [];
	let lastToolCallId: string | undefined;
	let sawToolCall = false;

	const displaySegment = (content: AssistantAgentMessage["content"]): AssistantAgentMessage => ({
		...message,
		content,
		stopReason: "stop",
		errorMessage: undefined,
		retryRecovery: undefined,
	});

	const flushPendingAfterTool = () => {
		if (!lastToolCallId || pendingAfterTool.length === 0) return;
		afterToolCalls.set(lastToolCallId, displaySegment(pendingAfterTool));
		pendingAfterTool = [];
	};

	for (const content of message.content) {
		if (content.type === "toolCall") {
			flushPendingAfterTool();
			sawToolCall = true;
			lastToolCallId = content.id;
			continue;
		}
		if (sawToolCall) {
			pendingAfterTool.push(content);
		} else {
			beforeTools.push(content);
		}
	}
	flushPendingAfterTool();

	if (!sawToolCall) {
		return { beforeTools: message, afterToolCalls, hasToolCalls: false };
	}

	return { beforeTools: displaySegment(beforeTools), afterToolCalls, hasToolCalls: true };
}

/**
 * Normalize raw tool-call arguments to a plain record, collapsing non-object or
 * array values to an empty object.
 */
export function normalizeToolArgs(args: unknown): Record<string, unknown> {
	return args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

export type AssistantErrorPresentation =
	| { kind: "none" }
	| { kind: "full"; text: string; isError: true }
	| { kind: "compact-recovered"; text: string; isError: false };

function sanitizeRecoveredRetryNote(note: string): string {
	const normalized = replaceTabs(note).replace(/\s+/g, " ").trim();
	return truncateToWidth(normalized || "retried", TRUNCATE_LENGTHS.CONTENT);
}

/**
 * Resolve the turn-ending assistant error presentation, if any.
 * Silent and user-interrupt aborts yield no label. Recovered retry attempts
 * render a compact note; attempts superseded by an exhausted budget are hidden
 * while the final terminal error keeps its full presentation.
 */
export function resolveAssistantErrorPresentation(
	message: AssistantAgentMessage,
	retryAttempt = 0,
): AssistantErrorPresentation {
	if (message.retryRecovery?.status === "superseded") return { kind: "none" };
	if (message.retryRecovery?.status === "recovered") {
		return {
			kind: "compact-recovered",
			text: sanitizeRecoveredRetryNote(message.retryRecovery.note),
			isError: false,
		};
	}
	if (message.stopReason === "aborted") {
		if (!shouldRenderAbortReason(message)) return { kind: "none" };
		return { kind: "full", text: resolveAbortLabel(message, retryAttempt), isError: true };
	}
	if (message.stopReason === "error") {
		return { kind: "full", text: message.errorMessage || "Error", isError: true };
	}
	if (message.errorMessage && shouldRenderAbortReason(message)) {
		return { kind: "full", text: message.errorMessage, isError: true };
	}
	return { kind: "none" };
}

/**
 * Whether an assistant turn's `usage` reflects work the operator was billed
 * for. Empty automated turns from providers that emit `usage: 0` collapse to
 * `false`, but any input, output, cache, or premium request keeps the row so
 * cost transparency survives — the live path and the resume/rebuild path
 * agree turn-by-turn.
 */
export function assistantUsageIsBilled(usage: AssistantAgentMessage["usage"]): boolean {
	if (usage.input > 0 || usage.output > 0) return true;
	if (usage.cacheRead > 0 || usage.cacheWrite > 0) return true;
	if ((usage.premiumRequests ?? 0) > 0) return true;
	return false;
}
