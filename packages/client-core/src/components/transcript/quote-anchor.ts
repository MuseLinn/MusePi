/**
 * Re-finds a quoted fragment inside the rendered text of the message it came
 * from. The quote card survives session reloads while the message DOM is
 * rebuilt, virtualized out and back, or re-rendered while streaming; the text
 * stream of the message body and the characters around the fragment are what
 * stay stable across all of that, so an offset alone is never trusted.
 *
 * Offsets count characters of the root's text stream: the concatenated data of
 * every descendant Text node in document order (what `textContent` and
 * `Range.toString()` both produce).
 */

import type { ChatQuoteAnchor, MessageDisplayContext, SessionEntry } from "@musepi/pi-wire";
import { normalizeDisplayContexts } from "../../messages/display-context";

/** Characters of context captured on each side of the quoted fragment. */
const QUOTE_CONTEXT_LENGTH = 32;
/** Occurrences past this are unresolvable: context cannot pick among that many. */
const MAX_OCCURRENCES = 200;

/** The element whose text a quote is anchored in, inside one entry row. */
const QUOTE_ROOT_SELECTOR = ".tr-body";

export interface ChatQuoteMark {
	/** Entry id of the message that was quoted. */
	entryId: string;
	anchor: ChatQuoteAnchor;
}

function escapeAttribute(value: string): string {
	return typeof CSS !== "undefined" && typeof CSS.escape === "function"
		? CSS.escape(value)
		: value.replace(/["\\]/g, "\\$&");
}

/** The message body hosting the quoted text, or null while the row is unmounted. */
export function findQuoteRoot(scope: ParentNode, entryId: string): HTMLElement | null {
	const entry = scope.querySelector(`[data-entry-id="${escapeAttribute(entryId)}"]`);
	const root = entry?.querySelector(QUOTE_ROOT_SELECTOR) ?? null;
	return root instanceof HTMLElement ? root : null;
}

/** Stream offset of a boundary point inside `root`. */
function streamOffset(root: Node, container: Node, offset: number): number {
	const probe = (root.ownerDocument ?? document).createRange();
	probe.setStart(root, 0);
	probe.setEnd(container, offset);
	return probe.toString().length;
}

/**
 * Anchor for `range` inside `root`, or null when the range escapes the root or
 * holds nothing but whitespace. `text` is the fragment as the message renders
 * it, never the Markdown form used for the prompt.
 */
export function captureQuoteAnchor(root: Element, range: Range): ChatQuoteAnchor | null {
	if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
	const stream = root.textContent ?? "";
	const start = streamOffset(root, range.startContainer, range.startOffset);
	const end = streamOffset(root, range.endContainer, range.endOffset);
	const text = stream.slice(start, end);
	if (!text.trim()) return null;
	return {
		text,
		prefix: stream.slice(Math.max(0, start - QUOTE_CONTEXT_LENGTH), start),
		suffix: stream.slice(end, end + QUOTE_CONTEXT_LENGTH),
		start,
	};
}

/**
 * Where the anchor's text sits in `stream`, or null when it is gone or cannot
 * be told apart from other copies of the same text. A quote persisted before
 * anchors existed has no context, so a repeated fragment stays unresolved
 * instead of highlighting a guess.
 */
export function locateQuote(stream: string, anchor: ChatQuoteAnchor): number | null {
	if (!anchor.text) return null;
	const occurrences: number[] = [];
	for (let index = stream.indexOf(anchor.text); index !== -1 && occurrences.length < MAX_OCCURRENCES; ) {
		occurrences.push(index);
		index = stream.indexOf(anchor.text, index + 1);
	}
	if (occurrences.length === 0) return null;
	if (occurrences.length === 1) return occurrences[0]!;
	if (!anchor.prefix && !anchor.suffix) return null;

	const prefix = anchor.prefix ?? "";
	const suffix = anchor.suffix ?? "";
	const inContext = occurrences.filter(
		index =>
			index >= prefix.length &&
			stream.startsWith(prefix, index - prefix.length) &&
			stream.startsWith(suffix, index + anchor.text.length),
	);
	if (inContext.length === 0) return null;
	const distance = (index: number): number => Math.abs(index - (anchor.start ?? index));
	return inContext.reduce((best, index) => (distance(index) < distance(best) ? index : best));
}

function collectTextNodes(node: Node, into: Text[]): Text[] {
	for (let child = node.firstChild; child; child = child.nextSibling) {
		if (child.nodeType === 3) into.push(child as Text);
		else collectTextNodes(child, into);
	}
	return into;
}

/** A live Range over the anchored fragment in `root`, or null when not found. */
export function resolveQuoteAnchor(root: Element, anchor: ChatQuoteAnchor): Range | null {
	const start = locateQuote(root.textContent ?? "", anchor);
	if (start === null) return null;
	const end = start + anchor.text.length;
	const range = (root.ownerDocument ?? document).createRange();
	let offset = 0;
	let startSet = false;
	for (const node of collectTextNodes(root, [])) {
		const length = node.data.length;
		if (!startSet && start < offset + length) {
			range.setStart(node, start - offset);
			startSet = true;
		}
		if (startSet && end <= offset + length) {
			range.setEnd(node, end - offset);
			return range;
		}
		offset += length;
	}
	return null;
}

/** Every anchored chat quote carried by the session entries, oldest first. */
export function collectQuoteMarks(entries: readonly SessionEntry[]): ChatQuoteMark[] {
	const marks: ChatQuoteMark[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const contexts: MessageDisplayContext | undefined = entry.message.displayContext;
		for (const context of normalizeDisplayContexts(contexts)) {
			if (context.kind !== "chat-quote" || !context.messageId || !context.anchor) continue;
			marks.push({ entryId: context.messageId, anchor: context.anchor });
		}
	}
	return marks;
}
