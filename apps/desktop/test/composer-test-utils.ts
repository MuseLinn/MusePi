import { EditorView } from "@codemirror/view";

/**
 * CodeMirror composer test helpers.
 *
 * The composer no longer has a textarea, so tests drive the document the same
 * way a keystroke does: dispatch a transaction on the mounted view. `act`
 * belongs to the caller (React updates follow the update listener).
 */
export function composerContent(root: ParentNode = document): HTMLElement {
	const content = root.querySelector<HTMLElement>(".gui-cm-composer .cm-content");
	if (!content) throw new Error("CodeMirror composer did not render");
	return content;
}

export function composerView(root: ParentNode = document): EditorView {
	const view = EditorView.findFromDOM(composerContent(root));
	if (!view) throw new Error("CodeMirror view not mounted");
	return view;
}

export function composerDoc(root: ParentNode = document): string {
	return composerView(root).state.doc.toString();
}

export function setComposerDoc(value: string, root: ParentNode = document): void {
	const view = composerView(root);
	view.dispatch({
		changes: { from: 0, to: view.state.doc.length, insert: value },
		selection: { anchor: value.length },
	});
}

export function composerPlaceholder(root: ParentNode = document): string | null {
	return root.querySelector<HTMLElement>(".gui-cm-placeholder")?.textContent ?? null;
}
