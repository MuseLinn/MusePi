import type { ComposerEditorHandle } from "@musepi/client-core/src/components/composer/composer-editor-types";

/** Splice a menu-inserted token into the composer at the caret.
 *
 * The completion panels are driven off the editor's change stream, so a
 * programmatic insert has to re-run the same parsers — otherwise the `+` menu's
 * "insert command" lands a bare `/` and no menu opens.
 */
export function insertComposerToken(
	editor: ComposerEditorHandle | null,
	token: string,
	setText: (value: string) => void,
	reparse?: (value: string) => void,
): void {
	if (!editor) return;
	editor.focus();
	editor.insertText(token);
	const next = editor.value;
	setText(next);
	editor.autosize();
	reparse?.(next);
}
