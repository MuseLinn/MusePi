import type { EditorMark, MentionPreview } from "@musepi/client-core/src/components/composer/composer-editor-types";
import { useCallback, useEffect, useMemo, useState } from "react";
import { resolveMentionChip } from "./mention-token";
import { HL_CLASS, parseHighlightSpans } from "./token-spans";
import type { ComposerAttachment } from "./use-attachments";

/** Session id → title for the chips a `@history://` token paints. Cached for
 *  the process: a title changes when someone renames a session, which is not
 *  worth a re-fetch per keystroke. */
const sessionTitles = new Map<string, string>();

interface SessionListRow {
	id: string;
	cwd?: string;
}

interface TitleRpc {
	request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

interface SessionTreeNode {
	entry: { id: string; label?: string };
	label?: string;
	children: SessionTreeNode[];
}

/**
 * Resolve a referenced session's title, fetching the list + tree once on
 * demand. Until the fetch lands the chip falls back to the id slice, so the
 * text never renders as a raw `history://` URL while titles load.
 */
function useSessionTitles(rpc: TitleRpc | null | undefined): (sessionId: string) => string | undefined {
	const [version, setVersion] = useState(0);
	useEffect(() => {
		if (!rpc) return;
		let cancelled = false;
		void Promise.all([
			rpc.request<SessionListRow[]>("session.list", {}).catch(() => []),
			rpc.request<SessionTreeNode[]>("session.tree", {}).catch(() => []),
		]).then(([list, tree]) => {
			if (cancelled) return;
			const labels = new Map<string, string>();
			const walk = (nodes: SessionTreeNode[]): void => {
				for (const node of nodes) {
					const label = node.entry.label ?? node.label;
					if (label) labels.set(node.entry.id, label);
					walk(node.children ?? []);
				}
			};
			walk(tree ?? []);
			for (const row of list ?? []) {
				const label = labels.get(row.id) ?? row.cwd?.split("/").filter(Boolean).at(-1);
				if (label) sessionTitles.set(row.id, label);
			}
			setVersion(v => v + 1);
		});
		return () => {
			cancelled = true;
		};
	}, [rpc]);
	return useCallback((sessionId: string) => sessionTitles.get(sessionId), [version]);
}

/**
 * Desktop token semantics stay in the desktop package: this hook turns the
 * text + staged chips into the generic `EditorMark[]` the shared CodeMirror
 * editor paints, and supplies the hover resolver. Mobile can pass an empty or
 * its own marks list without depending on this module.
 */
export function useComposerMarks(
	text: string,
	attachments: readonly ComposerAttachment[],
	rpc?: TitleRpc | null,
): { marks: EditorMark[]; resolveMention(name: string): MentionPreview | null } {
	const sessionTitle = useSessionTitles(rpc);
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
			parseHighlightSpans(text, resolveMention, sessionTitle).map(span => {
				if (span.kind === "reference" && span.reference) {
					// A path or history:// reference reads as an icon+label chip;
					// the document keeps the literal token for the send path.
					return {
						from: span.start,
						to: span.end,
						className: HL_CLASS.reference,
						revealAs: span.reference,
					};
				}
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
		[text, resolveMention, sessionTitle],
	);
	return { marks, resolveMention };
}
