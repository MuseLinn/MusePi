import { t } from "@musepi/client-core";
import { Extension, mergeAttributes, Node } from "@tiptap/core";
import Paragraph from "@tiptap/extension-paragraph";
import { Plugin } from "@tiptap/pm/state";
import { EditorContent, type JSONContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { type ReactNode, useEffect, useRef } from "react";
import type { OfficeDraft } from "../lib/office-documents";
import { type OfficeRestoreRequest, restoreOfficeElement } from "../lib/office-dom";
import { tiptapToWordDraft, wordDraftToTiptap } from "../lib/office-richtext";

interface OfficeWordEditorProps {
	draft: Extract<OfficeDraft, { kind: "word" }>;
	restore?: OfficeRestoreRequest;
	onChange(draft: OfficeDraft): void;
	onSave(): void;
}

/** A paragraph keeps its draft id so an edit can be projected back onto XML. */
const OfficeParagraph = Paragraph.extend({
	addAttributes() {
		return {
			...this.parent?.(),
			paragraphId: {
				default: null,
				parseHTML: element => {
					const value = element.getAttribute("data-paragraph-id");
					return value === null ? null : Number(value);
				},
				renderHTML: attributes =>
					attributes.paragraphId === null || attributes.paragraphId === undefined
						? {}
						: { "data-office-kind": "word", "data-paragraph-id": String(attributes.paragraphId) },
			},
		};
	},
});

/** A paragraph the byte-preserving writer will not rewrite: shown in place, never editable. */
const OfficePreserved = Node.create({
	name: "officePreserved",
	group: "block",
	atom: true,
	selectable: false,
	draggable: false,
	addAttributes() {
		return {
			paragraphId: { default: null },
			text: { default: "" },
			label: { default: "" },
		};
	},
	parseHTML() {
		return [{ tag: "div[data-office-preserved]" }];
	},
	renderHTML({ node, HTMLAttributes }) {
		return [
			"div",
			mergeAttributes(HTMLAttributes, {
				"data-office-preserved": "",
				class: "gui-office-preserved",
				...(node.attrs.paragraphId === null
					? {}
					: { "data-office-kind": "word", "data-paragraph-id": String(node.attrs.paragraphId) }),
			}),
			["span", { class: "gui-office-preserved-label" }, String(node.attrs.label ?? "")],
			["span", { class: "gui-office-preserved-text" }, String(node.attrs.text ?? "")],
		];
	},
});

function pmShape(document: JSONContent): string {
	return (document.content ?? []).map(node => `${node.type}:${node.attrs?.paragraphId ?? ""}`).join("|");
}

/**
 * The editor edits text and marks only. Paragraph identity and order are fixed
 * by the draft, so a transaction that splits, merges, deletes, reorders or
 * pastes blocks is rejected before it reaches the document.
 */
function shapeGuard(initial: JSONContent) {
	const expected = pmShape(initial);
	const shapeOfState = (document: { content: { type: { name: string }; attrs: Record<string, unknown> }[] }): string =>
		document.content.map(node => `${node.type.name}:${(node.attrs.paragraphId as number | null) ?? ""}`).join("|");
	return new Plugin({
		filterTransaction: (_transaction, state) => shapeOfState(state.doc as never) === expected,
	});
}

export function OfficeWordEditor({ draft, restore, onChange, onSave }: OfficeWordEditorProps): ReactNode {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const initial = useRef<JSONContent | null>(null);
	if (initial.current === null) initial.current = wordDraftToTiptap(draft);
	const draftRef = useRef(draft);
	draftRef.current = draft;
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const onSaveRef = useRef(onSave);
	onSaveRef.current = onSave;

	const editor = useEditor({
		extensions: [
			StarterKit.configure({
				heading: false,
				blockquote: false,
				codeBlock: false,
				bulletList: false,
				orderedList: false,
				listItem: false,
				horizontalRule: false,
				hardBreak: false,
				strike: false,
				code: false,
				paragraph: false,
			}),
			OfficeParagraph,
			OfficePreserved,
			Extension.create({
				name: "officeShapeGuard",
				addProseMirrorPlugins: () => [shapeGuard(initial.current!)],
			}),
		],
		content: initial.current,
		editorProps: {
			attributes: { class: "gui-filepane-richtext", spellcheck: "false" },
		},
		onUpdate: ({ editor }) => {
			try {
				onChangeRef.current(tiptapToWordDraft(editor.getJSON(), draftRef.current));
			} catch {
				// The shape guard keeps this unreachable; a refused projection must
				// not silently replace the working copy.
			}
		},
	});

	useEffect(() => {
		if (restore && hostRef.current) restoreOfficeElement(hostRef.current, restore);
	}, [restore]);

	const command = (run: () => void): void => {
		run();
		editor?.commands.focus();
	};

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent): void => {
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
				event.preventDefault();
				onSaveRef.current();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	return (
		<div className="gui-filepane-richtext-host" ref={hostRef}>
			<div className="gui-filepane-richtext-toolbar" role="toolbar" aria-label={t("settings.officeFormatting")}>
				<button
					type="button"
					className="gui-seg-btn"
					aria-pressed={editor?.isActive("bold") ?? false}
					aria-label={t("settings.officeBold")}
					onMouseDown={event => event.preventDefault()}
					onClick={() => command(() => editor?.chain().focus().toggleBold().run())}
				>
					<strong>B</strong>
				</button>
				<button
					type="button"
					className="gui-seg-btn"
					aria-pressed={editor?.isActive("italic") ?? false}
					aria-label={t("settings.officeItalic")}
					onMouseDown={event => event.preventDefault()}
					onClick={() => command(() => editor?.chain().focus().toggleItalic().run())}
				>
					<em>I</em>
				</button>
				<button
					type="button"
					className="gui-seg-btn"
					aria-pressed={editor?.isActive("underline") ?? false}
					aria-label={t("settings.officeUnderline")}
					onMouseDown={event => event.preventDefault()}
					onClick={() => command(() => editor?.chain().focus().toggleUnderline().run())}
				>
					<span style={{ textDecoration: "underline" }}>U</span>
				</button>
			</div>
			<EditorContent editor={editor} />
		</div>
	);
}
