import type { Crepe } from "@milkdown/crepe";
import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import "../styles/gui-markdown-editor.css";
import { markdownHtmlView, markdownImagePath } from "./markdown-html";
import { installMarkdownToolbarOverflow } from "./markdown-toolbar";

export { markdownImagePath };

export function hasYamlFrontMatter(markdown: string): boolean {
	return /^\uFEFF?---[\t ]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[\t ]*(?:\r?\n|$)/.test(markdown);
}

/** Add stable accessible names to Crepe's icon-only controls. Its Vue toolbar
 * owns the DOM, so a MutationObserver reapplies names after state updates. */
function labelToolbar(root: HTMLElement): () => void {
	const apply = (): void => {
		const items = root.querySelectorAll(".milkdown-top-bar .top-bar-inner > .top-bar-item");
		const labels = [
			t("markdownBold"),
			t("markdownItalic"),
			t("markdownStrikethrough"),
			t("markdownInlineCode"),
			t("markdownBulletList"),
			t("markdownOrderedList"),
			t("markdownTaskList"),
			t("markdownLink"),
			t("markdownImage"),
			t("markdownTable"),
			t("markdownCodeBlock"),
			t("markdownFormula"),
			t("markdownQuote"),
			t("markdownDivider"),
		];
		items.forEach((item, index) => {
			const label = labels[index];
			if (!label) return;
			item.setAttribute("aria-label", label);
			item.setAttribute("title", label);
		});
	};
	apply();
	const observer = new MutationObserver(apply);
	observer.observe(root, { childList: true, subtree: true });
	return () => observer.disconnect();
}

/** The five-action quote toolbar captures `mouseup` inside the pane that hosts
 * this editor, so it only ever saw pointer selections. Mirror the editor's
 * selection onto that contract: re-dispatch a bubbling `mouseup` from the pane
 * boundary — never from the editor root, where ProseMirror's own DOM handlers
 * would read it as a user click. Collapsing the selection relays too because
 * the toolbar treats a collapsed selection as "dismiss". */
function relaySelection(host: HTMLElement): () => void {
	const pane = host.parentElement;
	if (!pane) return () => {};
	let frame: number | null = null;
	let pointerDown = false;
	let pointerAt = 0;
	let pointerX = 0;
	let pointerY = 0;
	let lastText = "";
	const relay = (): void => {
		frame = null;
		const selection = window.getSelection();
		const anchor = selection?.anchorNode ?? null;
		const inside = anchor !== null && host.contains(anchor);
		// A selection that moved into another element belongs to that element;
		// only a cleared or collapsed selection of our own is a dismissal.
		if (!inside && anchor !== null) {
			lastText = "";
			return;
		}
		const text = inside && selection && !selection.isCollapsed ? selection.toString() : "";
		if (text === lastText) return;
		lastText = text;
		// Carry the release point so the toolbar can sit at the end of a long
		// selection instead of above its first line. A keyboard selection has
		// no fresh pointer, so it falls back to the range's last line.
		const fresh = performance.now() - pointerAt < 1000;
		pane.dispatchEvent(
			new MouseEvent("mouseup", {
				bubbles: true,
				clientX: fresh ? pointerX : 0,
				clientY: fresh ? pointerY : 0,
			}),
		);
	};
	const schedule = (): void => {
		if (frame === null) frame = requestAnimationFrame(relay);
	};
	const onSelectionChange = (): void => {
		// A drag ends with a real mouseup, so mid-drag frames only re-read
		// layout; keyboard selection and refocus never produce one.
		if (!pointerDown) schedule();
	};
	const onPointerDown = (event: PointerEvent): void => {
		if (event.isPrimary) pointerDown = true;
	};
	const onPointerUp = (event: PointerEvent): void => {
		pointerDown = false;
		pointerAt = performance.now();
		pointerX = event.clientX;
		pointerY = event.clientY;
		schedule();
	};
	document.addEventListener("selectionchange", onSelectionChange);
	document.addEventListener("pointerup", onPointerUp);
	host.addEventListener("pointerdown", onPointerDown);
	host.addEventListener("focusin", schedule);
	return () => {
		if (frame !== null) cancelAnimationFrame(frame);
		document.removeEventListener("selectionchange", onSelectionChange);
		document.removeEventListener("pointerup", onPointerUp);
		host.removeEventListener("pointerdown", onPointerDown);
		host.removeEventListener("focusin", schedule);
	};
}

interface FileMarkdownEditorProps {
	path: string;
	name: string;
	value: string;
	onChange(text: string): void;
	onSave(text: string): void;
	onError(message: string): void;
}

export interface FileMarkdownEditorHandle {
	getMarkdown(): string | null;
}

/** Single-column WYSIWYG. The parent owns disk state and draft caching; this
 * component owns only Crepe's document view and DOM resources. */
export const FileMarkdownEditor = forwardRef<FileMarkdownEditorHandle, FileMarkdownEditorProps>(
	function FileMarkdownEditor({ path, name, value, onChange, onSave, onError }, ref): ReactNode {
		const hostRef = useRef<HTMLDivElement | null>(null);
		const crepeRef = useRef<Crepe | null>(null);
		const valueRef = useRef(value);
		const initialMarkdownRef = useRef<string | null>(null);
		const callbacksRef = useRef({ onChange, onSave, onError });
		const [ready, setReady] = useState(false);
		valueRef.current = value;
		callbacksRef.current = { onChange, onSave, onError };
		const readMarkdown = (): string | null => {
			const crepe = crepeRef.current;
			if (!crepe) return null;
			const latest = crepe.getMarkdown();
			// Notifications can lag behind a real edit. Compare the document itself
			// so immediate source switches keep edits and clean files keep raw text.
			return latest === initialMarkdownRef.current ? valueRef.current : latest;
		};
		useImperativeHandle(ref, () => ({ getMarkdown: readMarkdown }), []);

		useEffect(() => {
			let cancelled = false;
			let created = false;
			let crepe: Crepe | null = null;
			let removeToolbarLabels: (() => void) | null = null;
			let removeToolbarOverflow: (() => void) | null = null;
			let removeSelectionRelay: (() => void) | null = null;
			setReady(false);
			const host = hostRef.current;
			if (!host) return;
			const rejectUpload = (): Promise<string> => Promise.reject(new Error(t("markdownImageUploadUnsupported")));
			void import("@milkdown/crepe")
				.then(async ({ Crepe: CrepeEditor }) => {
					if (cancelled) return;
					const next = new CrepeEditor({
						root: host,
						defaultValue: valueRef.current,
						features: { [CrepeEditor.Feature.TopBar]: true },
						featureConfigs: {
							[CrepeEditor.Feature.TopBar]: {
								headingOptions: [
									{ label: t("markdownParagraph"), level: null },
									...([1, 2, 3, 4, 5, 6] as const).map(level => ({
										label: t("markdownHeading", { level }),
										level,
									})),
								],
							},
							[CrepeEditor.Feature.ImageBlock]: {
								onUpload: rejectUpload,
								inlineOnUpload: rejectUpload,
								blockOnUpload: rejectUpload,
								proxyDomURL: async (source: string) => {
									if (/^(https?:|data:)/i.test(source)) return source;
									const imagePath = markdownImagePath(path, source);
									if (!imagePath) return "";
									const result = await window.electronAPI?.readFileDataUrl(imagePath);
									return result?.dataUrl ?? "";
								},
							},
						},
					});
					// README raw HTML (`<p align="center">`, `<img>`, badges) renders
					// through a node view; the atom's value still serializes verbatim.
					next.editor.use(markdownHtmlView(path));
					crepe = next;
					next.on(listener => {
						listener.markdownUpdated((_ctx, markdown) => {
							// Mount parsing must not turn serialization normalization into a
							// dirty file. Only updates after a successful create are edits.
							if (created && !cancelled) callbacksRef.current.onChange(markdown);
						});
					});
					await next.create();
					if (cancelled) {
						await next.destroy();
						return;
					}
					initialMarkdownRef.current = next.getMarkdown();
					created = true;
					crepeRef.current = next;
					host.querySelector(".ProseMirror")?.setAttribute("aria-label", name);
					removeToolbarLabels = labelToolbar(host);
					removeToolbarOverflow = installMarkdownToolbarOverflow(host);
					removeSelectionRelay = relaySelection(host);
					setReady(true);
				})
				.catch(reason => {
					if (!cancelled) callbacksRef.current.onError(reason instanceof Error ? reason.message : String(reason));
				});
			return () => {
				// Flush real edits on file close. A clean mount must not serialize
				// Front Matter or other source syntax during a source-mode switch.
				const latest = created ? readMarkdown() : null;
				cancelled = true;
				created = false;
				if (latest !== null && latest !== valueRef.current) callbacksRef.current.onChange(latest);
				removeToolbarLabels?.();
				removeToolbarOverflow?.();
				removeSelectionRelay?.();
				crepeRef.current = null;
				initialMarkdownRef.current = null;
				if (crepe) void crepe.destroy().catch(() => {});
			};
		}, [path, name]);

		return (
			<div
				ref={hostRef}
				className="gui-filepane-markdown-editor"
				data-ready={ready || undefined}
				onKeyDownCapture={event => {
					if ((!event.metaKey && !event.ctrlKey) || event.key.toLowerCase() !== "s") return;
					event.preventDefault();
					event.stopPropagation();
					const crepe = crepeRef.current;
					if (crepe) callbacksRef.current.onSave(crepe.getMarkdown());
				}}
			/>
		);
	},
);
