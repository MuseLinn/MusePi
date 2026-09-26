/**
 * Attachment mention tokens (Kimi desktop parity): a chip's "mention"
 * action inserts a plain-text token into the textarea at the caret — the
 * textarea stays the single input surface (no contenteditable), the token
 * rides draft persistence for free because it lives in the text, and the
 * send path expands it into explicit attachment references.
 *
 * Token grammar: `@附件[文件名]` — single-line, filename verbatim between
 * the brackets (spaces survive), no adjacency to the slash/bang/magic
 * highlight kinds, and distinct from the `@file` TUI/completion semantics
 * (that one inserts a workspace PATH followed by a space; this token only
 * ever references a chip staged in the composer). Known limit: a filename
 * containing `]` truncates at the first bracket close — the token then
 * round-trips as stale, never as a wrong attachment.
 */

import { attachmentWorkspacePath } from "./use-attachments";

export const MENTION_TOKEN_PREFIX = "@附件[";

/** Build one token from an attachment name. */
export function makeMentionToken(name: string): string {
	return `${MENTION_TOKEN_PREFIX}${name}]`;
}

export interface MentionTokenSpan {
	start: number;
	end: number;
	/** Raw filename between the brackets (may contain spaces). */
	name: string;
}

const MENTION_RE = /@附件\[([^\]\n]*)\]/g;

/** Parse every mention token in `text` (scan order, no overlaps by
 *  construction — the grammar cannot nest). */
export function parseMentionTokens(text: string): MentionTokenSpan[] {
	const out: MentionTokenSpan[] = [];
	for (const m of text.matchAll(MENTION_RE)) {
		const idx = m.index ?? 0;
		out.push({ start: idx, end: idx + m[0].length, name: m[1] ?? "" });
	}
	return out;
}

/** Minimal attachment surface the expansion needs (both composers' chip
 *  types structurally satisfy this). */
export interface MentionExpandableAttachment {
	kind: "image" | "file";
	name: string;
}

/** Expanded reference for one matched attachment:
 *  - image → `[图片:文件名]` — the pixels ride the wire images channel as
 *    they always have; the text gains an explicit pointer the agent can
 *    read next to the prose that mentions it;
 *  - file → `[Attachment] <workspace path>` — the same reference line the
 *    fs.write upload path already produces, so the agent resolves the chip
 *    through the existing mechanism (listed once more inline; harmless).
 *  A token whose attachment is gone stays VERBATIM: stripping would
 *  silently rewrite the user's message, and the stale pill already warned
 *  before send. */
function expandOne(token: string, name: string, attachments: readonly MentionExpandableAttachment[]): string {
	const hit = attachments.find(a => a.name === name);
	if (!hit) return token;
	return hit.kind === "file" ? `[Attachment] ${attachmentWorkspacePath(hit.name)}` : `[图片:${name}]`;
}

/** Expand every mention token in `text` against the chips staged at send
 *  time. First name match wins (duplicate chip names share one reference). */
export function expandMentionTokens(text: string, attachments: readonly MentionExpandableAttachment[]): string {
	if (!text.includes(MENTION_TOKEN_PREFIX)) return text;
	return text.replace(MENTION_RE, (token, name: string) => expandOne(token, name, attachments));
}

/** Splice a mention token (plus one trailing space, which both reads
 *  naturally and closes the `@` completion panel — its trigger rule
 *  (lib/completion-trigger) treats a whitespace-bearing tail as prose) at
 *  the textarea's caret, replacing the selection. Returns the new value
 *  and the caret position AFTER the token; null when the textarea is
 *  gone. Pure string math — the host applies setText + caret restore. */
export function spliceMentionToken(
	value: string,
	selectionStart: number,
	selectionEnd: number,
	name: string,
): { next: string; caret: number } {
	const token = `${makeMentionToken(name)} `;
	const start = Math.min(Math.max(0, selectionStart), value.length);
	const end = Math.min(Math.max(0, selectionEnd), value.length);
	const head = value.slice(0, start);
	// Glue hygiene: after an ASCII word character, keep a space before the
	// token so it never fuses with the preceding word (a fused `word@附件`
	// also reads as an email-ish token). CJK body text needs no glue.
	const glue = /[A-Za-z0-9_]$/.test(head) ? " " : "";
	const next = `${head}${glue}${token}${value.slice(end)}`;
	return { next, caret: start + glue.length + token.length };
}
