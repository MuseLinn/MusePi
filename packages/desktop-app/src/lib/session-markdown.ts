import { advisorNoteText, type SessionEntry } from "@musepi/pi-wire";

/**
 * Session → Markdown export (openchamber `exportMarkdown` parity).
 *
 * The selection rule is the whole point of this module. A session file carries
 * far more than `message` rows, and `custom_message` — advisor cards, hook
 * notices, collab and skill prompts — is conversation a reader expects in the
 * export. Filtering to `type === "message"` dropped every one of them with no
 * placeholder and no error, so a re-shared transcript silently lost the very
 * rows that explain what happened.
 *
 * Two rules that are easy to get wrong and are therefore pinned here:
 *
 *   - `content` on a `custom_message` is the MODEL-FACING `<advisory …>` XML.
 *     The reader-facing text is `details.notes[].note`; the XML must never
 *     reach a file the user reads or re-shares.
 *   - `display: false` means hidden, so it stays out — same contract the
 *     transcript builder honours.
 */

export interface MarkdownLabels {
	user: string;
	assistant: string;
	advisor: string;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map(b => (b as { text?: string }).text ?? "").join("\n");
	return "";
}

/** Render the conversation as Markdown. Bookkeeping entries are skipped. */
export function buildSessionMarkdown(title: string, entries: readonly SessionEntry[], labels: MarkdownLabels): string {
	const lines: string[] = [`# ${title}`, ""];
	for (const e of entries) {
		if (e.type === "custom_message") {
			if (!e.display) continue;
			const note = advisorNoteText(e.details).trim();
			if (!note) continue;
			lines.push(`## ${labels.advisor}`, "", note, "");
			continue;
		}
		if (e.type !== "message") continue;
		const role = e.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const body = textOf(e.message?.content).trim();
		if (!body) continue;
		lines.push(`## ${role === "user" ? labels.user : labels.assistant}`, "", body, "");
	}
	return lines.join("\n");
}

/** Filesystem-safe download name derived from a session title. */
export function markdownFileName(title: string): string {
	return (
		title
			.replace(/[^\w一-龥-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "session"
	);
}
