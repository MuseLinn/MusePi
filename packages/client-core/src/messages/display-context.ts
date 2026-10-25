import type { DisplayContext, MessageDisplayContext } from "@musepi/pi-wire";
import type { AnnotationPayload } from "../annotation/contract";

export type { DisplayContext, MessageDisplayContext } from "@musepi/pi-wire";

type BrowserAnnotationContext = Extract<DisplayContext, { kind: "browser-annotation" }>;
type ChatQuoteContext = Extract<DisplayContext, { kind: "chat-quote" }>;
type FileQuoteContext = Extract<DisplayContext, { kind: "file-quote" }>;
type QuotableContext = ChatQuoteContext | FileQuoteContext;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const optionalString = (value: unknown): boolean => value === undefined || typeof value === "string";
const optionalLine = (value: unknown): boolean =>
	value === undefined || (typeof value === "number" && Number.isInteger(value) && value > 0);

export function isDisplayContext(value: unknown): value is DisplayContext {
	if (!isRecord(value)) return false;
	if (value.kind === "browser-annotation") {
		return (
			typeof value.pageUrl === "string" &&
			typeof value.prompt === "string" &&
			optionalString(value.comment) &&
			optionalString(value.image)
		);
	}
	if (value.kind === "chat-quote") {
		return typeof value.quote === "string" && optionalString(value.messageId) && optionalString(value.comment);
	}
	if (value.kind === "file-quote") {
		return (
			typeof value.path === "string" &&
			typeof value.quote === "string" &&
			optionalString(value.language) &&
			optionalString(value.comment) &&
			optionalLine(value.startLine) &&
			optionalLine(value.endLine)
		);
	}
	return false;
}

export function createBrowserAnnotationContext({
	payload,
	prompt,
	image,
}: {
	payload: AnnotationPayload;
	prompt: string;
	image?: string;
}): BrowserAnnotationContext {
	return {
		kind: "browser-annotation",
		pageUrl: payload.pageUrl,
		prompt,
		...(payload.comment.trim() ? { comment: payload.comment.trim() } : {}),
		...(image ? { image } : {}),
	};
}

export function createChatQuoteContext({
	messageId,
	quote,
	comment,
}: {
	messageId?: string;
	quote: string;
	comment?: string;
}): ChatQuoteContext {
	return {
		kind: "chat-quote",
		...(messageId ? { messageId } : {}),
		quote,
		...(comment !== undefined ? { comment } : {}),
	};
}

export function createFileQuoteContext({
	path,
	quote,
	language,
	startLine,
	endLine,
	comment,
}: {
	path: string;
	quote: string;
	language?: string;
	startLine?: number;
	endLine?: number;
	comment?: string;
}): FileQuoteContext {
	return {
		kind: "file-quote",
		path,
		quote,
		...(language ? { language } : {}),
		...(startLine !== undefined && endLine !== undefined ? { startLine, endLine } : {}),
		...(comment !== undefined ? { comment } : {}),
	};
}

export function normalizeDisplayContexts(value: MessageDisplayContext | undefined): DisplayContext[] {
	return Array.isArray(value) ? value : value ? [value] : [];
}

export function messageDisplayContext(contexts: readonly DisplayContext[]): MessageDisplayContext | undefined {
	if (contexts.length === 0) return undefined;
	return contexts.length === 1 ? contexts[0] : [...contexts];
}

function chatQuotePrompt(context: ChatQuoteContext): string {
	const quote = `> ${context.quote.split("\n").join("\n> ")}`;
	const comment = context.comment?.trim();
	return comment ? `${quote}\n\n${comment}` : quote;
}

function fileQuotePrompt(context: FileQuoteContext): string {
	const location =
		context.startLine !== undefined && context.endLine !== undefined
			? ` lines ${context.startLine}-${context.endLine}`
			: "";
	const source = context.quote
		? `Comment on this fragment of \`${context.path}\`${location}:\n> ${context.quote.split("\n").join("\n> ")}`
		: `Workspace file reference: \`${context.path}\``;
	const comment = context.comment?.trim();
	return comment ? `${source}\n\n${comment}` : source;
}

function quotablePrompt(context: QuotableContext): string {
	return context.kind === "chat-quote" ? chatQuotePrompt(context) : fileQuotePrompt(context);
}

function annotationPromptForSend(context: BrowserAnnotationContext): string {
	if (!context.prompt.split("\n").some(line => line.startsWith("Comment: "))) return context.prompt;
	return withDisplayContextComment(context, context.comment?.trim() ?? "").prompt;
}

export function composeDisplayContextPrompt(contexts: readonly DisplayContext[], draft: string): string {
	const quotes = contexts.filter((context): context is QuotableContext => context.kind !== "browser-annotation");
	const annotations = contexts.filter(
		(context): context is BrowserAnnotationContext => context.kind === "browser-annotation",
	);
	return [...quotes.map(quotablePrompt), draft.trim(), ...annotations.map(annotationPromptForSend)]
		.filter(part => part.length > 0)
		.join("\n\n")
		.trim();
}

export function withDisplayContextComment<T extends DisplayContext>(context: T, comment: string): T {
	const next = comment;
	if (context.kind !== "browser-annotation") return { ...context, comment: next };
	const lines = context.prompt.split("\n");
	const commentIndex = lines.findIndex(line => line.startsWith("Comment: "));
	if (commentIndex >= 0) lines.splice(commentIndex, 1);
	if (next) {
		const screenshotIndex = lines.findIndex(line => line.startsWith("Screenshot: "));
		lines.splice(screenshotIndex >= 0 ? screenshotIndex + 1 : Math.min(2, lines.length), 0, `Comment: ${next}`);
	}
	return { ...context, comment: next, prompt: lines.join("\n") };
}

export function browserAnnotationTargetCount(context: BrowserAnnotationContext): number {
	return context.prompt.match(/^(?:Element|Region|Drawing) \d+:/gm)?.length ?? 0;
}

export function displayContextQuote(context: DisplayContext): string {
	return context.kind === "browser-annotation" ? context.prompt : context.quote;
}

export function textWithoutDisplayContext(text: string, value: MessageDisplayContext | undefined): string {
	let remaining = text;
	for (const context of normalizeDisplayContexts(value)) {
		if (context.kind !== "browser-annotation") {
			const prefix = quotablePrompt(context);
			if (remaining.startsWith(prefix)) remaining = remaining.slice(prefix.length).replace(/^\n{1,2}/, "");
		} else if (remaining.endsWith(context.prompt)) {
			remaining = remaining.slice(0, -context.prompt.length).replace(/\n{1,2}$/, "");
		}
	}
	return remaining;
}
