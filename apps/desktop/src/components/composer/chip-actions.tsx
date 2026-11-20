import type { ComposerEditorHandle } from "@musepi/client-core/src/components/composer/composer-editor-types";
import type { ComponentProps, Dispatch, RefObject, SetStateAction } from "react";
import type { ComposerFrame } from "../../lib/composer-frame";
import type { SketchScene } from "../../lib/sketch-scene";
import { mentionTokenName, removeMentionTokens, retargetMentionTokens, spliceMentionToken } from "./mention-token";
import { type ComposerAttachment, reorderAttachmentChips } from "./use-attachments";

/** The sketch board's open request, shared by both composer skins. */
export interface SketchRequest {
	open: boolean;
	editId: number | null;
	initial: string | null;
	scene: SketchScene | null;
}

type ChipProps = Pick<
	ComponentProps<typeof ComposerFrame>,
	| "onRemoveAttachment"
	| "onReorderAttachments"
	| "onMentionAttachment"
	| "onEditSketch"
	| "onEditImage"
	| "onAddAttachment"
>;

export interface ChipActionArgs {
	attachments: ComposerAttachment[];
	setAttachments: Dispatch<SetStateAction<ComposerAttachment[]>>;
	setText: Dispatch<SetStateAction<string>>;
	editorRef: RefObject<ComposerEditorHandle | null>;
	setSketch: Dispatch<SetStateAction<SketchRequest>>;
	/** Opens the host's all-types attachment picker. */
	openAddMenu(): void;
}

/** The attachment-chip wiring both skins hand to `ComposerFrame`.
 *
 * Chips carry ordered mention tokens (`@图片N` / `@文件N`): removing a chip
 * drops the tokens pointing at it, reordering renumbers the survivors, and the
 * `@` button splices the chip's token at the caret. Every one of those rules is
 * a property of chip order, not of the scene, so it lives here once — a skin
 * passing its own variant only differed in how it opened the picker.
 */
export function attachmentChipActions({
	attachments,
	setAttachments,
	setText,
	editorRef,
	setSketch,
	openAddMenu,
}: ChipActionArgs): ChipProps {
	return {
		onRemoveAttachment: id => {
			// The label is captured BEFORE the array changes.
			const label = mentionTokenName(attachments, id);
			const next = attachments.filter(p => p.id !== id);
			setAttachments(next);
			setText(txt => {
				const cleaned = label ? removeMentionTokens(txt, label) : txt;
				return retargetMentionTokens(cleaned, attachments, next);
			});
		},
		onReorderAttachments: (fromId, toId) => {
			const next = reorderAttachmentChips(attachments, fromId, toId);
			if (next === attachments) return;
			setAttachments(next);
			setText(txt => retargetMentionTokens(txt, attachments, next));
		},
		onMentionAttachment: id => {
			// The ordinal badge, not the file name, identifies the chip — the
			// trailing space also closes the @ completion panel (its trigger
			// treats a whitespace tail as prose).
			const label = mentionTokenName(attachments, id);
			const ta = editorRef.current;
			if (!label || !ta) return;
			const { next, caret } = spliceMentionToken(
				ta.value,
				ta.selectionStart ?? ta.value.length,
				ta.selectionEnd ?? ta.value.length,
				label,
			);
			setText(next);
			requestAnimationFrame(() => {
				ta.setSelectionRange(caret, caret);
				ta.focus();
				ta.autosize();
			});
		},
		onEditSketch: id => {
			const chip = attachments.find(x => x.id === id);
			if (!chip) return;
			// A chip with a scene reopens its strokes so every object stays
			// editable; only a scene-less chip falls back to mounting its PNG.
			setSketch({
				open: true,
				editId: id,
				initial: chip.sketchScene ? null : chip.dataUrl,
				scene: chip.sketchScene ?? null,
			});
		},
		onEditImage: src => setSketch({ open: true, editId: null, initial: src, scene: null }),
		onAddAttachment: openAddMenu,
	};
}
