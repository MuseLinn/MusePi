/**
 * Non-image attachments reach the prompt as reference lines:
 * `[Attachment] blob://<hash> (original name)`. The model reads that address,
 * so the stored message text keeps the lines verbatim — the transcript lifts
 * them out of the rendered body and shows file cards instead.
 *
 * A name-only `[Attachment:name]` mention (an `@file` expansion) carries no
 * address, so it has no card and stays in the text.
 */

export interface AttachmentRef {
	hash: string;
	name: string;
}

export interface ParsedAttachmentText {
	/** Message text with the attachment reference lines removed. */
	text: string;
	/** Referenced blobs, deduplicated by hash (the first name wins). */
	refs: AttachmentRef[];
}

/** One reference line. The name is greedy so it may itself contain parentheses. */
const REF_LINE = /^[ \t]*\[Attachment\][ \t]+blob:\/\/([a-f0-9]{64})[ \t]+\((.*)\)[ \t]*\r?$/;

export function parseAttachmentRefs(text: string): ParsedAttachmentText {
	if (!text.includes("[Attachment]")) return { text, refs: [] };
	const kept: string[] = [];
	const refs: AttachmentRef[] = [];
	const seen = new Set<string>();
	for (const line of text.split("\n")) {
		const match = REF_LINE.exec(line);
		if (!match) {
			kept.push(line);
			continue;
		}
		const hash = match[1] ?? "";
		if (seen.has(hash)) continue;
		seen.add(hash);
		refs.push({ hash, name: match[2] ?? "" });
	}
	if (refs.length === 0) return { text, refs: [] };
	// Reference lines are prepended by the send path; drop the blank lines
	// their removal leaves at either edge instead of rendering an empty gap.
	const rest = kept.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
	return { text: rest, refs };
}
