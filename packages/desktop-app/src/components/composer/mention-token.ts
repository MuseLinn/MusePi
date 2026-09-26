/**
 * Attachment mention tokens (Kimi desktop parity): a chip's "mention"
 * action inserts a plain-text token into the textarea at the caret — the
 * textarea stays the single input surface (no contenteditable), the token
 * rides draft persistence for free because it lives in the text, and the
 * send path expands it into explicit attachment references.
 *
 * Token grammar (v2, 2026-09-26): `@名字` — an `@` followed by a run of
 * characters that are not whitespace, not `[`/`]`, and not `/`/`\`; a run
 * directly followed by `/` or `\` is a PATH and produces no candidate at
 * all, which keeps the bare-`@path` print-mode/TUI semantics intact (that
 * flow inserts a workspace PATH and is never expanded in the GUI). A
 * candidate is only a MENTION when 名字 exactly matches a chip staged in
 * the composer: the overlay paints it (through the host's resolveMention)
 * and the send path expands it. Everything else — bare `@path`, prose
 * `@word`, a token whose attachment has been removed — is plain text:
 * never painted, never rewritten on send (the token survives verbatim).
 * Known limits (accepted, they fail toward plain text): a filename
 * containing whitespace or `[`/`]` cannot round-trip (the run breaks at
 * the first such character); trailing punctuation typed directly after
 * the name joins the run and breaks the match. Chip-inserted tokens come
 * with a trailing space and are always followed by prose boundaries in
 * practice, so the inserted form parses.
 */

import { attachmentWorkspacePath } from "./use-attachments";

/** Build one token from an attachment name. */
export function makeMentionToken(name: string): string {
	return `@${name}`;
}

export interface MentionTokenSpan {
	start: number;
	end: number;
	/** Candidate name after the `@` (the whitespace-free run). */
	name: string;
}

/** `@` + a run with no whitespace / brackets / slashes. Whether the run is
 *  a PATH (a `/` or `\` directly after it) is checked AFTER the match — a
 *  regex lookahead would still match a truncated prefix via backtracking
 *  ("sr" out of "@src/foo"). */
const MENTION_RE = /@([^\s[\]\\/]+)/g;

/** Path guard shared by both consumers: a run directly followed by `/` or
 *  `\` is a path segment — never a mention (bare-`@path` TUI semantics). */
function followedByPathSeparator(text: string, end: number): boolean {
	const c = text[end];
	return c === "/" || c === "\\";
}

/** Parse every mention CANDIDATE in `text` (scan order; candidates cannot
 *  nest, so no overlaps by construction). Candidate ≠ mention: whether a
 *  span is a live reference is decided by the consumers — expand checks
 *  the staged chips, paint checks the host's resolveMention. */
export function parseMentionTokens(text: string): MentionTokenSpan[] {
	const out: MentionTokenSpan[] = [];
	for (const m of text.matchAll(MENTION_RE)) {
		const idx = m.index ?? 0;
		const end = idx + m[0].length;
		if (followedByPathSeparator(text, end)) continue;
		out.push({ start: idx, end, name: m[1] ?? "" });
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
 *  A token whose attachment is gone stays VERBATIM: it no longer resolves,
 *  so stripping would silently rewrite the user's message — and since the
 *  unresolved token is never painted either, it reads as the plain text
 *  it now is. */
function expandOne(token: string, name: string, attachments: readonly MentionExpandableAttachment[]): string {
	const hit = attachments.find(a => a.name === name);
	if (!hit) return token;
	return hit.kind === "file" ? `[Attachment] ${attachmentWorkspacePath(hit.name)}` : `[图片:${name}]`;
}

/** Expand every mention token in `text` against the chips staged at send
 *  time. First name match wins (duplicate chip names share one reference);
 *  unmatched candidates pass through untouched. */
export function expandMentionTokens(text: string, attachments: readonly MentionExpandableAttachment[]): string {
	if (!text.includes("@")) return text;
	return text.replace(MENTION_RE, (token, name: string, offset: number) => {
		if (followedByPathSeparator(text, offset + token.length)) return token;
		return expandOne(token, name, attachments);
	});
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
	// token so it never fuses with the preceding word (a fused `word@名`
	// reads email-ish and visually glues the pill to the word). CJK body
	// text needs no glue.
	const glue = /[A-Za-z0-9_]$/.test(head) ? " " : "";
	const next = `${head}${glue}${token}${value.slice(end)}`;
	return { next, caret: start + glue.length + token.length };
}
