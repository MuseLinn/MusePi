import { t } from "@musepi/client-core";
import type { Crepe } from "@milkdown/crepe";
import type { ReactNode } from "react";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/classic.css";
import { installMarkdownToolbarOverflow } from "./markdown-toolbar";

/** Resolve an image reference without turning the Markdown source into a
 * temporary blob/data URL. Only the DOM receives the readable data URL. */
export function markdownImagePath(documentPath: string, source: string): string | null {
	if (/^(https?:|data:)/i.test(source)) return null;
	if (!source || /^blob:/i.test(source)) return null;
	const raw = source.startsWith("file://") ? source.slice("file://".length) : source;
	if (!/\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)(?:[?#].*)?$/i.test(raw)) return null;
	const clean = raw.split(/[?#]/, 1)[0] ?? "";
	if (/^(?:[a-z]:[\\/]|\/|~)/i.test(clean)) return clean;
	const separator = Math.max(documentPath.lastIndexOf("/"), documentPath.lastIndexOf("\\"));
	const base = separator >= 0 ? documentPath.slice(0, separator + 1) : "";
	const segments = `${base}${clean}`.replace(/\\/g, "/").split("/");
	const normalized: string[] = [];
	for (const segment of segments) {
		if (!segment || segment === ".") continue;
		if (segment === ".." && normalized.at(-1) !== "..") normalized.pop();
		else normalized.push(segment);
	}
	const prefix = /^[a-z]:/i.test(segments[0] ?? "") ? "" : "/";
	return `${prefix}${normalized.join("/")}`;
}

export function hasYamlFrontMatter(markdown: string): boolean {
	return /^\uFEFF?---[\t ]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[\t ]*(?:\r?\n|$)/.test(markdown);
}

const TOOLBAR_LABEL_KEYS = [
	["markdownBold", "markdownItalic", "markdownStrikethrough", "markdownInlineCode"],
	["markdownBulletList", "markdownOrderedList", "markdownTaskList"],
	["markdownLink", "markdownImage", "markdownTable"],
	["markdownCodeBlock", "markdownFormula"],
	["markdownQuote", "markdownDivider"],
] as const;

/** Add stable accessible names to Crepe's icon-only controls. Its Vue toolbar
 * owns the DOM, so a MutationObserver reapplies names after state updates. */
function labelToolbar(root: HTMLElement): () => void {
	const apply = (): void => {
		const items = root.querySelectorAll(".milkdown-top-bar .top-bar-inner > .top-bar-item");
		const labels = TOOLBAR_LABEL_KEYS.flat().map(key => t(key));
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

/** KimiWork-parity single-column WYSIWYG. The parent owns disk state and draft
 * caching; this component owns only Crepe's document view and DOM resources. */
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
			setReady(false);
			const host = hostRef.current;
			if (!host) return;
			const rejectUpload = (): Promise<string> =>
				Promise.reject(new Error(t("markdownImageUploadUnsupported")));
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
