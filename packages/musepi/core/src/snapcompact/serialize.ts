// ============================================================
// MusePi snapcompact — history serialization (OMP serializeConversation port).
//
// Discarded messages become one compact text stream with ¶-prefixed scope
// markers: ¶user: / ¶ai: / ¶think: / ¶call:. Tool results merge into their
// originating call block; contextually useless results (and their calls)
// are dropped whole; every cap is head-biased (default 60/40) so command
// errors and test failures — which live at output tails — survive.
// ============================================================

import type { SerializeOptions, SnapContentBlock, SnapMessage } from "./types.ts";

export const TOOL_RESULT_MAX_CHARS = 2000;
export const TOOL_ARG_MAX_CHARS = 500;
export const TOOL_CALL_MAX_CHARS = 2000;
export const TRUNCATE_HEAD_RATIO = 0.6;

/** Arg key carrying the model's one-line intent (rendered as a //comment). */
const INTENT_FIELD = "intent";

/** Keep the head and tail of `text`, eliding the middle beyond `maxChars`. */
export function truncateForArchive(text: string, maxChars: number, headRatio: number): string {
	if (text.length <= maxChars) return text;
	const ratio = Math.min(Math.max(headRatio, 0), 1);
	const headChars = Math.round(maxChars * ratio);
	const tailChars = maxChars - headChars;
	const elided = text.length - maxChars;
	const tail = tailChars > 0 ? text.slice(-tailChars) : "";
	return `${text.slice(0, headChars)} […${elided}ch elided…] ${tail}`;
}

function textOfUserContent(content: SnapMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function textOfResultContent(content: SnapMessage["content"]): string {
	if (typeof content === "string") return content;
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/** Serialize discarded history into the archive text stream. */
export function serializeConversation(messages: SnapMessage[], options?: SerializeOptions): string {
	const toolResultMaxChars = options?.toolResultMaxChars ?? TOOL_RESULT_MAX_CHARS;
	const toolArgMaxChars = options?.toolArgMaxChars ?? TOOL_ARG_MAX_CHARS;
	const toolCallMaxChars = options?.toolCallMaxChars ?? TOOL_CALL_MAX_CHARS;
	const headRatio = options?.truncateHeadRatio ?? TRUNCATE_HEAD_RATIO;
	const parts: string[] = [];
	let lastPrefix: string | null = null;

	const pushPart = (prefix: string, content: string): void => {
		const lastIndex = parts.length - 1;
		if (lastIndex >= 0 && lastPrefix === prefix) {
			const sep = parts[lastIndex]!.endsWith("\n") || content.startsWith("\n") ? "" : "\n";
			parts[lastIndex] += sep + content;
		} else {
			parts.push(prefix + content);
			lastPrefix = prefix;
		}
	};

	// Useless results (and their paired calls) carry nothing worth archiving;
	// surviving results are indexed for merging into their call scope.
	const uselessCallIds = new Set<string>();
	const resultTextByCallId = new Map<string, string>();
	for (const msg of messages) {
		if (msg.role !== "toolResult" || !msg.toolCallId) continue;
		if (msg.useless === true && msg.isError !== true) {
			uselessCallIds.add(msg.toolCallId);
			continue;
		}
		const text = textOfResultContent(msg.content);
		if (text) resultTextByCallId.set(msg.toolCallId, text);
	}

	const renderResultBlock = (rawText: string): string => {
		const body = truncateForArchive(rawText, toolResultMaxChars, headRatio);
		return `<out>\n${body}\n</out>`;
	};

	const mergedCallIds = new Set<string>();

	for (const msg of messages) {
		if (msg.role === "user") {
			const content = textOfUserContent(msg.content);
			if (content) pushPart("¶user:", content);
			continue;
		}

		if (msg.role === "assistant") {
			let pendingThinking: string[] = [];
			let pendingText: string[] = [];
			const flush = (): void => {
				if (pendingThinking.length > 0) pushPart("¶think:", pendingThinking.join("\n"));
				if (pendingText.length > 0) pushPart("¶ai:", pendingText.join("\n"));
				pendingThinking = [];
				pendingText = [];
			};

			const blocks: SnapContentBlock[] = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content;
			for (const block of blocks) {
				if (block.type === "text") {
					if (block.text.trim()) pendingText.push(block.text);
				} else if (block.type === "thinking") {
					if (block.thinking.trim()) pendingThinking.push(block.thinking);
				} else if (block.type === "toolCall") {
					if (uselessCallIds.has(block.id)) continue;
					flush();
					const args = block.arguments ?? {};
					const rawIntent =
						typeof block.intent === "string"
							? block.intent
							: typeof args[INTENT_FIELD] === "string"
								? (args[INTENT_FIELD] as string)
								: "";
					const intent = rawIntent.replace(/\s+/g, " ").trim();
					const argsStr = truncateForArchive(
						Object.entries(args)
							.filter(([key]) => key !== INTENT_FIELD)
							.map(
								([key, value]) =>
									`${key}=${truncateForArchive(JSON.stringify(value) ?? "undefined", toolArgMaxChars, headRatio)}`,
							)
							.join(", "),
						toolCallMaxChars,
						headRatio,
					);
					const lines: string[] = [`${block.name}(${argsStr})${intent ? `//${intent}` : ""}`];
					const resultText = resultTextByCallId.get(block.id);
					if (resultText !== undefined) {
						mergedCallIds.add(block.id);
						lines.push(renderResultBlock(resultText));
					}
					pushPart("¶call:", lines.join("\n"));
				}
			}
			flush();
			continue;
		}

		if (msg.role === "toolResult") {
			// Paired results already merged above; orphans (call outside the
			// discarded window) render standalone.
			if (!msg.toolCallId || uselessCallIds.has(msg.toolCallId) || mergedCallIds.has(msg.toolCallId)) continue;
			const resultText = resultTextByCallId.get(msg.toolCallId);
			if (resultText !== undefined) pushPart("¶call:", `\n${renderResultBlock(resultText)}`);
		}
	}

	return parts.join("\n\n");
}
