import type { Context, Model, Tool } from "@musepi/pi-ai";
import { stringifyJson } from "@musepi/pi-utils";
import type { Tokenizer } from "./tokenizer";

/**
 * Smallest output a request asks for when a side request has to be sized to
 * the window: a provider rejects a prompt that leaves no room for any output.
 */
export const MIN_FITTED_OUTPUT_TOKENS = 1024;

/**
 * Per-request framing no message count sees (generation prompt, end markers,
 * reasoning wrappers) that is subtracted from the room left for output.
 */
export const OUTPUT_FIT_HEADWAY_TOKENS = 64;

/** Chat-template framing charged per locally counted message. */
export const MESSAGE_FRAMING_TOKENS = 16;

/**
 * Framing tokens (system prompt, tool definitions) memoized per array: these
 * are stable identities for the life of a turn, so repeat requests do not
 * re-stringify and re-tokenize them. Length is part of the key to catch
 * in-place growth.
 */
const framingCounts = new WeakMap<readonly unknown[], { tokenizer: Tokenizer; length: number; tokens: number }>();

function countFraming(items: readonly unknown[] | undefined, tokenizer: Tokenizer, fragments: () => string[]): number {
	if (!items || items.length === 0) return 0;
	const cached = framingCounts.get(items);
	if (cached && cached.tokenizer === tokenizer && cached.length === items.length) return cached.tokens;
	const tokens = tokenizer.countTokens(fragments());
	framingCounts.set(items, { tokenizer, length: items.length, tokens });
	return tokens;
}

function toolFragments(tools: readonly Tool[]): string[] {
	const fragments: string[] = [];
	for (const tool of tools) fragments.push(tool.name, tool.description, stringifyJson(tool.parameters) ?? "");
	return fragments;
}

/** System prompt and tool schemas: the request prefix outside `messages`. */
function countFramingTokens(context: Context, tokenizer: Tokenizer): number {
	const { systemPrompt, tools } = context;
	return (
		countFraming(systemPrompt, tokenizer, () => [...(systemPrompt ?? [])]) +
		countFraming(tools, tokenizer, () => toolFragments(tools ?? []))
	);
}

/**
 * Local prompt count of `context` when it leaves `model` no room for the
 * smallest output a request must keep, else `undefined` (also when the window
 * is unknown). Counting stops at the first message past the window, so the
 * result is a floor.
 *
 * No usage anchor is trusted: a handoff reads history that may have expanded
 * behind a native compaction the model cannot replay, and those reports
 * describe the compacted prefix. No tokenizer margin is added either: a
 * caller refuses on this verdict, so only a clear overrun counts and a
 * near-full request is still left to the provider.
 */
export function countContextOverrun(context: Context, model: Model, tokenizer: Tokenizer): number | undefined {
	const contextWindow = model.contextWindow;
	if (!contextWindow || contextWindow <= 0) return undefined;
	const budget = contextWindow - OUTPUT_FIT_HEADWAY_TOKENS - MIN_FITTED_OUTPUT_TOKENS;
	let tokens = countFramingTokens(context, tokenizer);
	for (const message of context.messages) {
		if (tokens > budget) break;
		// Encrypted reasoning bytes overstate what the provider bills; a floor leaves them out.
		tokens += tokenizer.countMessage(message, { excludeEncryptedReasoning: true });
	}
	return tokens > budget ? tokens : undefined;
}
