/**
 * Attachment mention tokens (Kimi desktop parity): a chip's "mention"
 * action inserts a plain-text token into the composer document at the caret —
 * the editor stays the single input surface, the token rides draft persistence
 * for free because it lives in the text, and the send path expands it into
 * explicit attachment references.
 *
 * Token grammar (v2, 2026-09-26): `@名字` — an `@` followed by a run of
 * characters that are not whitespace, not `[`/`]`, and not `/`/`\`; a run
 * directly followed by `/` or `\` is a PATH and produces no candidate at
 * all, which keeps the bare-`@path` print-mode/TUI semantics intact (that
 * flow inserts a workspace PATH and is never expanded in the GUI). A
 * candidate is only a MENTION when 名字 resolves against a chip staged in
 * the composer: the editor paints it (through the host's resolveMention)
 * and the send path expands it. Everything else — bare `@path`, prose
 * `@word`, a token whose attachment has been removed — is plain text:
 * never painted, never rewritten on send (the token survives verbatim).
 * Known limits (accepted, they fail toward plain text): a filename
 * containing whitespace or `[`/`]` cannot round-trip (the run breaks at
 * the first such character); trailing punctuation typed directly after
 * the name joins the run and breaks the match. Chip-inserted tokens come
 * with a trailing space and are always followed by prose boundaries in
 * practice, so the inserted form parses.
 *
 * Chip-inserted tokens are ORDINAL (v3, 2026-09-28): `@图片N` / `@文件N`,
 * N = the 1-based position among same-kind chips in chip order — the
 * numbered badge Kimi desktop shows as a rich-text atom. The token text itself
 * is the badge (no separate label layer). Ordinal tokens beat name tokens on identity:
 * pasted screenshots all arrive as "image.png", and a name match resolves
 * to the FIRST chip with that name — every mention pointed at the first
 * image. Chip-order changes (reorder / remove) rewrite the numbers in the
 * draft via `retargetMentionTokens` so a token keeps pointing at the SAME
 * chip (Kimi's refreshAttachmentLabels parity); a token whose chip was
 * removed degrades to its `@名字` form, which then obeys the plain-text
 * rules above. Hand-typed `@名字` name tokens keep working unchanged.
 */

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

/** Ordinal token body: `图片2` / `文件1` — N is the 1-based position among
 *  SAME-KIND chips in chip order (images and files number independently,
 *  matching the chips' corner badges). Chinese literals, same convention
 *  as the `[图片:名]` expansion. */
const ORDINAL_TOKEN_RE = /^(图片|文件)([1-9]\d*)$/;

/** Token body for the chip at `ordinal` (1-based among its kind). */
export function ordinalMentionLabel(kind: "image" | "file", ordinal: number): string {
	return `${kind === "file" ? "文件" : "图片"}${ordinal}`;
}

/** Token body a chip's mention button should insert: its CURRENT ordinal
 *  label. null when the id is not staged. */
export function mentionTokenName<T extends { id: number; kind: "image" | "file" }>(
	attachments: readonly T[],
	id: number,
): string | null {
	const a = attachments.find(x => x.id === id);
	if (!a) return null;
	const ordinal = attachments.filter(x => x.kind === a.kind).findIndex(x => x.id === id) + 1;
	return ordinalMentionLabel(a.kind, ordinal);
}

export interface MentionResolution<T extends MentionExpandableAttachment> {
	chip: T;
	/** 1-based position among same-kind chips (drives `[图片 N]` expansion). */
	ordinal: number;
	/** How the token resolved — ordinal tokens expand positionally, name
	 *  tokens keep the legacy `[图片:名]` form. */
	via: "ordinal" | "name";
}

/** Resolve a token body against the staged chips: the ordinal form wins
 *  (`图片2` = the 2nd image chip, immune to the duplicate-names first-match
 *  trap), then an exact NAME match (legacy/hand-typed tokens; first match
 *  wins on duplicates). null = not a mention — plain text end to end. */
export function resolveMentionChip<T extends MentionExpandableAttachment>(
	name: string,
	attachments: readonly T[],
): MentionResolution<T> | null {
	const ord = ORDINAL_TOKEN_RE.exec(name);
	if (ord) {
		const kind: "image" | "file" = ord[1] === "文件" ? "file" : "image";
		const sameKind = attachments.filter(a => a.kind === kind);
		const chip = sameKind[Number(ord[2]) - 1];
		return chip ? { chip, ordinal: Number(ord[2]), via: "ordinal" } : null;
	}
	const idx = attachments.findIndex(a => a.name === name);
	if (idx === -1) return null;
	const chip = attachments[idx]!;
	const ordinal = attachments.filter(a => a.kind === chip.kind).indexOf(chip) + 1;
	return { chip, ordinal, via: "name" };
}

/** Expanded reference for one matched attachment:
 *  - image, ordinal token → `[图片 N]` — N is the image's position among
 *    the wire images (chip order IS the send order), the exact pointer the
 *    model needs next to the prose that mentions it;
 *  - image, name token → `[图片:文件名]` (legacy form);
 *  - file → `[Attachment:文件名]` — a name pointer only. The address is the
 *    `[Attachment] blob://<hash> (name)` line the send path prepends after
 *    `attachment.put`, so the inline reference never names a filesystem path
 *    that may not exist (nothing is written into the workspace).
 *  A token whose attachment is gone stays VERBATIM: it no longer resolves,
 *  so stripping would silently rewrite the user's message — and since the
 *  unresolved token is never painted either, it reads as the plain text
 *  it now is. */
function expandOne(token: string, name: string, attachments: readonly MentionExpandableAttachment[]): string {
	const hit = resolveMentionChip(name, attachments);
	if (!hit) return token;
	if (hit.chip.kind === "file") return `[Attachment:${hit.chip.name}]`;
	return hit.via === "ordinal" ? `[图片 ${hit.ordinal}]` : `[图片:${hit.chip.name}]`;
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

/**
 * The structured records a send travels with, one per resolved mention.
 *
 * The expanded text already carries the model-facing pointer; these records are
 * what let the transcript paint that pointer as the chip the composer showed.
 * Deriving them from the SAME resolution the expansion used is what keeps the
 * two from disagreeing — a token that did not resolve leaves no record, so the
 * bubble renders it as the plain text it now is.
 */
export function mentionReferenceContexts(
	text: string,
	attachments: readonly MentionExpandableAttachment[],
): Array<{ kind: "attachment-ref"; attachmentKind: "image" | "file"; ordinal?: number; name: string }> {
	if (!text.includes("@")) return [];
	const out: Array<{ kind: "attachment-ref"; attachmentKind: "image" | "file"; ordinal?: number; name: string }> = [];
	const seen = new Set<string>();
	for (const m of text.matchAll(MENTION_RE)) {
		const idx = m.index ?? 0;
		if (followedByPathSeparator(text, idx + m[0].length)) continue;
		const hit = resolveMentionChip(m[1] ?? "", attachments);
		if (!hit) continue;
		// One record per distinct attachment: a message that names the same image
		// twice still has one chip for it.
		const key = `${hit.chip.kind}:${hit.chip.name}:${hit.ordinal}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({
			kind: "attachment-ref",
			attachmentKind: hit.chip.kind,
			...(hit.chip.kind === "image" ? { ordinal: hit.ordinal } : {}),
			name: hit.chip.name,
		});
	}
	return out;
}

/** Fast pre-check for retargetMentionTokens (avoids the map build on
 *  drafts with no ordinal tokens). */
const ORDINAL_TOKEN_SOURCE = /@(图片|文件)[1-9]\d*/;
/**
 * Retarget ordinal mention tokens after the chip array changed (reorder /
 * remove): a token keeps pointing at the SAME chip, so its number is
 * rewritten to the chip's new position — Kimi desktop's
 * refreshAttachmentLabels parity (their atoms renumber in place too).
 *
 * A token whose chip is GONE degrades to the `@名字` name form instead of
 * silently pointing at the chip that slid into its old slot: the name
 * form then obeys the plain-text rules (unresolved → unpainted, never
 * expanded). Non-ordinal tokens (name tokens, `@path`, prose) are never
 * touched. Callers pair this with the setAttachments call, feeding the
 * BEFORE and AFTER arrays.
 */
export function retargetMentionTokens<T extends { id: number; kind: "image" | "file"; name: string }>(
	text: string,
	prev: readonly T[],
	next: readonly T[],
): string {
	if (!ORDINAL_TOKEN_SOURCE.test(text)) return text;
	const nextOrdinal = new Map<number, number>();
	let imageNo = 0;
	let fileNo = 0;
	for (const c of next) nextOrdinal.set(c.id, c.kind === "file" ? ++fileNo : ++imageNo);
	return text.replace(MENTION_RE, (token, name: string, offset: number) => {
		if (followedByPathSeparator(text, offset + token.length)) return token;
		const m = ORDINAL_TOKEN_RE.exec(name);
		if (!m) return token;
		const kind: "image" | "file" = m[1] === "文件" ? "file" : "image";
		let ord = 0;
		let prevChip: T | undefined;
		for (const c of prev) {
			if (c.kind !== kind) continue;
			ord++;
			if (ord === Number(m[2])) {
				prevChip = c;
				break;
			}
		}
		if (!prevChip) return token;
		const newNo = nextOrdinal.get(prevChip.id);
		if (newNo === undefined) return makeMentionToken(prevChip.name);
		return newNo === Number(m[2]) ? token : `@${ordinalMentionLabel(kind, newNo)}`;
	});
}

/**
 * Remove every token that points at `name` (a token BODY, e.g. `图片1`),
 * together with one adjacent space. Called when the user removes the chip
 * itself: Kimi desktop deletes the mention with the attachment, and leaving
 * it behind turns a reference into stray prose (`@图片1` that no longer
 * resolves). Ordinal tokens are removed by their CURRENT label — callers
 * capture it before changing the chip array, then retarget the survivors.
 */
export function removeMentionTokens(text: string, name: string): string {
	const spans = parseMentionTokens(text).filter(span => span.name === name);
	if (spans.length === 0) return text;
	let out = text;
	for (let i = spans.length - 1; i >= 0; i--) {
		let { start, end } = spans[i]!;
		if (/\s/.test(out[end] ?? "")) end += 1;
		else if (start > 0 && /\s/.test(out[start - 1] ?? "")) start -= 1;
		out = out.slice(0, start) + out.slice(end);
	}
	return out;
}

/** Splice a mention token (plus one trailing space, which both reads
 *  naturally and closes the `@` completion panel — its trigger rule
 *  (lib/completion-trigger) treats a whitespace-bearing tail as prose) at
 *  the editor caret, replacing the selection. Returns the new value
 *  and the caret position AFTER the token; null when the editor is
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

/** Splice one token AFTER the retained selection, never replacing it
 *  (file-menu "Add to chat"): the right-click gesture names a file to
 *  reference, it does not mean "overwrite what I had selected". The insertion
 *  lands at the selection end, so the original range still covers the same
 *  characters; the caller restores that range after the programmatic value
 *  write. Same glue rule as `spliceMentionToken`. */
export function spliceMentionTokenAfterSelection(
	value: string,
	selectionStart: number,
	selectionEnd: number,
	name: string,
): { next: string; selection: { start: number; end: number } } {
	const start = Math.min(Math.max(0, Math.min(selectionStart, selectionEnd)), value.length);
	const end = Math.min(Math.max(0, Math.max(selectionStart, selectionEnd)), value.length);
	return { next: spliceMentionToken(value, end, end, name).next, selection: { start, end } };
}

/** Splice several tokens in one gesture (paste intake). Same glue rule as
 *  `spliceMentionToken`; tokens are separated by the trailing space each one
 *  carries, so the result reads as `@图片1 @图片2 ` and closes the `@`
 *  completion panel. */
export function spliceMentionTokens(
	value: string,
	selectionStart: number,
	selectionEnd: number,
	names: readonly string[],
): { next: string; caret: number } {
	if (names.length === 0) return { next: value, caret: selectionStart };
	const start = Math.min(Math.max(0, selectionStart), value.length);
	const end = Math.min(Math.max(0, selectionEnd), value.length);
	const head = value.slice(0, start);
	const glue = /[A-Za-z0-9_]$/.test(head) ? " " : "";
	const body = names.map(name => `${makeMentionToken(name)} `).join("");
	return { next: `${head}${glue}${body}${value.slice(end)}`, caret: start + glue.length + body.length };
}

export interface MentionEdit {
	next: string;
	caret: number;
}

/**
 * Atomic deletion (Kimi atom parity): Backspace with the caret right after a
 * LIVE token removes the whole token instead of one character at a time.
 * "Live" means the resolver still finds a staged chip — an unresolved
 * `@名字` is ordinary prose and must keep character deletion.
 */
export function deleteMentionTokenBefore(
	value: string,
	caret: number,
	resolves: (name: string) => boolean,
): MentionEdit | null {
	for (const span of parseMentionTokens(value)) {
		if (span.end !== caret && !(span.end === caret - 1 && value[caret - 1] === " ")) continue;
		if (!resolves(span.name)) continue;
		const from = span.start;
		const to = span.end === caret ? caret : span.end + 1;
		return { next: value.slice(0, from) + value.slice(to), caret: from };
	}
	return null;
}

/** Forward twin: Delete with the caret at a live token's start removes the
 *  token and the single space that follows it. */
export function deleteMentionTokenAfter(
	value: string,
	caret: number,
	resolves: (name: string) => boolean,
): MentionEdit | null {
	for (const span of parseMentionTokens(value)) {
		if (span.start !== caret) continue;
		if (!resolves(span.name)) continue;
		const to = value[span.end] === " " ? span.end + 1 : span.end;
		return { next: value.slice(0, span.start) + value.slice(to), caret: span.start };
	}
	return null;
}
