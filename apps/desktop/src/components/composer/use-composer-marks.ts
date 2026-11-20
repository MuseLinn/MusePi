import type { EditorMark, MentionPreview } from "@musepi/client-core/src/components/composer/composer-editor-types";
import { useCallback, useMemo } from "react";
import { resolveMentionChip } from "./mention-token";
import { HL_CLASS, parseHighlightSpans } from "./token-spans";
import type { ComposerAttachment } from "./use-attachments";

/**
 * Desktop token semantics stay in the desktop package: this hook turns the
 * text + staged chips into the generic `EditorMark[]` the shared CodeMirror
 * editor paints, and supplies the hover resolver. Mobile can pass an empty or
 * its own marks list without depending on this module.
 */
export function useComposerMarks(
	text: string,
	attachments: readonly ComposerAttachment[],
): { marks: EditorMark[]; resolveMention(name: string): MentionPreview | null } {
	const resolveMention = useCallback(
		(name: string): MentionPreview | null => {
			const hit = resolveMentionChip(name, attachments);
			if (!hit) return null;
			return {
				kind: hit.chip.kind,
				name: hit.chip.name,
				size: hit.chip.size,
				dataUrl: hit.chip.dataUrl || undefined,
			};
		},
		[attachments],
	);
	const marks = useMemo<EditorMark[]>(
		() =>
			parseHighlightSpans(text, resolveMention).map(span => {
				if (span.kind !== "mention") {
					return { from: span.start, to: span.end, className: HL_CLASS[span.kind] };
				}
				// The pill carries a type glyph (image/file), so the class says which.
				// The span was painted only after resolving, so this second lookup
				// returns the same chip.
				const mentionName = text.slice(span.start + 1, span.end);
				const kind = resolveMention(mentionName)?.kind ?? "file";
				return {
					from: span.start,
					to: span.end,
					className: `${HL_CLASS.mention} gui-ta-hl-mention--${kind}`,
					mentionName,
				};
			}),
		[text, resolveMention],
	);
	return { marks, resolveMention };
}
