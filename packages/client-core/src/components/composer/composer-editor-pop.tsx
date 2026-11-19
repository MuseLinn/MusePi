import { createPortal } from "react-dom";
import type { MentionPreview } from "./composer-editor-types";

export interface MentionPop {
	name: string;
	preview: MentionPreview;
	x: number;
	y: number;
}

/** Display-only hover card for a resolved mention token. Portaled because the
 *  editor's scroll container would clip a nested card. */
export function ComposerMentionPop({ pop }: { pop: MentionPop }): ReturnType<typeof createPortal> {
	return createPortal(
		<div className="gui-mention-pop" style={{ left: `${pop.x}px`, top: `${pop.y - 8}px` }} aria-hidden>
			{pop.preview.kind === "image" && pop.preview.dataUrl ? (
				<img className="gui-mention-pop-thumb" src={pop.preview.dataUrl} alt="" draggable={false} />
			) : null}
			<span className="gui-mention-pop-name">{pop.preview.name}</span>
			{mentionSizeLabel(pop.preview.size) && (
				<span className="gui-mention-pop-size">{mentionSizeLabel(pop.preview.size)}</span>
			)}
		</div>,
		document.body,
	);
}

function mentionSizeLabel(size: number | undefined): string {
	if (!size || !Number.isFinite(size) || size <= 0) return "";
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
