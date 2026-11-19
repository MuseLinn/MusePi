import type {
	ComposerEditorHandle,
	ComposerSelection,
} from "@musepi/client-core/src/components/composer/composer-editor-types";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback } from "react";
import { readPasteImageMention } from "../../lib/composer-prefs";
import { imageChipCount, insertPastedImageMentions } from "./attachment-mention-paste";
import { insertPastedPlainText } from "./paste-text";
import type { ComposerAttachment } from "./use-attachments";

interface ClipboardLike {
	clipboardData: DataTransfer | null;
	defaultPrevented: boolean;
	preventDefault(): void;
}

interface DragLike {
	dataTransfer: DataTransfer | null;
	preventDefault(): void;
}

export interface ComposerIntakeOptions {
	editor: RefObject<ComposerEditorHandle | null>;
	attachments: readonly ComposerAttachment[];
	addFiles(files: File[]): Promise<ComposerAttachment[]>;
	setAttachments: Dispatch<SetStateAction<ComposerAttachment[]>>;
	setText(value: string): void;
	clearAllRef: RefObject<boolean>;
	autosize(): void;
	/** Session composer's own intake (useAttachments); omitted = extract files here. */
	onPasteFiles?(event: ClipboardLike): Promise<ComposerAttachment[]>;
	/** Return true when a long paste was consumed (dialog / inline gesture). */
	onLongPaste?(text: string, event: ClipboardLike): boolean;
	/** Session-only: large-paste gesture + history reset + completion parsers. */
	onValueChange?(value: string, selection: ComposerSelection): void;
	onMentionClick?(start: number): void;
}

/** One intake contract for both desktop composers: paste/drop file chips,
 *  mirror image mentions at the caret, mixed-clipboard text, and the shared
 *  onChange side effects. The policy differences arrive as callbacks. */
export function useComposerIntake(options: ComposerIntakeOptions): {
	onPaste(event: ClipboardLike): void;
	onDrop(event: DragLike): void;
	onDragOver(event: DragLike): void;
	onChange(value: string, selection: ComposerSelection): void;
	onMentionClick(start: number): void;
} {
	const {
		editor,
		attachments,
		addFiles,
		setAttachments,
		setText,
		clearAllRef,
		autosize,
		onPasteFiles,
		onLongPaste,
		onValueChange,
	} = options;

	const onPaste = useCallback(
		(event: ClipboardLike): void => {
			const pastedText = event.clipboardData?.getData("text") ?? "";
			const priorImages = imageChipCount(attachments);
			const files = [...(event.clipboardData?.items ?? [])]
				.filter(item => item.kind === "file")
				.map(item => item.getAsFile())
				.filter((file): file is File => file !== null);
			const added = onPasteFiles
				? onPasteFiles(event)
				: files.length > 0
					? (event.preventDefault(), addFiles(files))
					: Promise.resolve([]);
			if (event.defaultPrevented || files.length > 0) {
				// Mixed clipboard: keep the text half the attachment branch lost.
				insertPastedPlainText(editor.current, pastedText);
				if (readPasteImageMention()) {
					void added.then(chips => insertPastedImageMentions(editor.current, chips, priorImages)).catch(() => {});
				}
				return;
			}
			onLongPaste?.(pastedText, event);
		},
		[editor, attachments, addFiles, onPasteFiles, onLongPaste],
	);

	const onDrop = useCallback(
		(event: DragLike): void => {
			const files = [...(event.dataTransfer?.files ?? [])];
			if (files.length === 0) return;
			event.preventDefault();
			const priorImages = imageChipCount(attachments);
			void addFiles(files)
				.then(chips => {
					if (readPasteImageMention()) insertPastedImageMentions(editor.current, chips, priorImages);
				})
				.catch(() => {});
		},
		[editor, attachments, addFiles],
	);

	const onDragOver = useCallback((event: DragLike): void => {
		if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
	}, []);

	const onChange = useCallback(
		(value: string, selection: ComposerSelection): void => {
			setText(value);
			if (clearAllRef.current) {
				clearAllRef.current = false;
				if (value === "") setAttachments([]);
			}
			onValueChange?.(value, selection);
			autosize();
		},
		[setText, clearAllRef, setAttachments, onValueChange, autosize],
	);

	const mentionClick = useCallback(
		(start: number): void => {
			options.onMentionClick?.(start);
		},
		[options.onMentionClick],
	);

	return { onPaste, onDrop, onDragOver, onChange, onMentionClick: mentionClick };
}
