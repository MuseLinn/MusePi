import { t } from "@musepi/client-core";
import type { OfficeQuoteAnchor } from "@musepi/pi-wire";
import { renderAsync as renderDocx } from "docx-preview";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type { OfficeDraft } from "../lib/office-documents";

export interface OfficeEditorSelection {
	text: string;
	x: number;
	y: number;
	height: number;
	anchor: OfficeQuoteAnchor;
}

interface OfficeRestoreRequest {
	anchor: OfficeQuoteAnchor;
	quote: string;
	nonce: number;
}

interface OfficePreviewProps {
	bytes: Uint8Array<ArrayBuffer>;
	draft: OfficeDraft;
	restore?: OfficeRestoreRequest;
	onChange(draft: OfficeDraft): void;
	onSave(): void;
	onSelection(selection: OfficeEditorSelection | null): void;
}

function restoreOfficeElement(root: HTMLElement, request: OfficeRestoreRequest): boolean {
	const element = Array.from(root.querySelectorAll<HTMLElement>("[data-office-kind]")).find(candidate => {
		const anchor = request.anchor;
		if (anchor.kind === "word") {
			return candidate.dataset.officeKind === "word" && Number(candidate.dataset.paragraphId) === anchor.paragraphId;
		}
		if (anchor.kind === "presentation") {
			return (
				candidate.dataset.officeKind === "presentation" &&
				Number(candidate.dataset.slide) === anchor.slide &&
				candidate.dataset.shapeId === anchor.shapeId
			);
		}
		return (
			candidate.dataset.officeKind === "workbook" &&
			candidate.dataset.sheet === anchor.sheet &&
			candidate.dataset.cell === anchor.startCell
		);
	});
	if (!element) return false;
	element.scrollIntoView({ block: "center" });
	const range = document.createRange();
	const quote = request.quote.trim();
	const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
	const text = nodes.map(node => node.data).join("");
	const start = quote ? text.indexOf(quote) : -1;
	if (start >= 0) {
		let offset = 0;
		let started = false;
		for (const node of nodes) {
			const end = offset + node.data.length;
			if (!started && start < end) {
				range.setStart(node, start - offset);
				started = true;
			}
			if (started && start + quote.length <= end) {
				range.setEnd(node, start + quote.length - offset);
				break;
			}
			offset = end;
		}
	} else range.selectNodeContents(element);
	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
	return true;
}

function officeLocation(node: Node | null): { element: HTMLElement; anchor: OfficeQuoteAnchor } | null {
	const element = (node instanceof HTMLElement ? node : node?.parentElement)?.closest<HTMLElement>(
		"[data-office-kind]",
	);
	if (!element) return null;
	const kind = element.dataset.officeKind;
	if (kind === "word") return { element, anchor: { kind, paragraphId: Number(element.dataset.paragraphId) } };
	if (kind === "presentation") {
		return {
			element,
			anchor: { kind, slide: Number(element.dataset.slide), shapeId: element.dataset.shapeId ?? "" },
		};
	}
	if (kind === "workbook") {
		return {
			element,
			anchor: {
				kind,
				sheet: element.dataset.sheet ?? "",
				startCell: element.dataset.cell ?? "",
				endCell: element.dataset.cell ?? "",
			},
		};
	}
	return null;
}

export function FileOfficePreview(props: OfficePreviewProps): ReactNode {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const capture = (): void => {
		const selection = window.getSelection();
		if (!selection || selection.isCollapsed || !selection.toString().trim()) {
			props.onSelection(null);
			return;
		}
		const start = officeLocation(selection.anchorNode);
		const end = officeLocation(selection.focusNode);
		if (!start || !end || !rootRef.current?.contains(start.element)) {
			props.onSelection(null);
			return;
		}
		const range = selection.getRangeAt(0);
		const rect = range.getBoundingClientRect();
		let anchor = start.anchor;
		if (anchor.kind === "workbook" && end.anchor.kind === "workbook" && anchor.sheet === end.anchor.sheet) {
			anchor = { ...anchor, endCell: end.anchor.endCell };
		}
		props.onSelection({
			text: selection.toString().trim(),
			x: Math.round(rect.left + rect.width / 2),
			y: Math.round(rect.top),
			height: rect.height,
			anchor,
		});
	};
	return (
		<div ref={rootRef} className="gui-filepane-office" onMouseUp={capture} onKeyUp={capture}>
			{props.draft.readOnlyReason && <p className="gui-filepane-preview-note">{props.draft.readOnlyReason}</p>}
			{props.draft.kind === "word" && <WordSurface {...props} draft={props.draft} />}
			{props.draft.kind === "presentation" && <PresentationSurface {...props} draft={props.draft} />}
			{props.draft.kind === "workbook" && <WorkbookSurface {...props} draft={props.draft} />}
		</div>
	);
}

function editableKeyDown(event: KeyboardEvent | React.KeyboardEvent, onSave: () => void): void {
	if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
		event.preventDefault();
		onSave();
	}
}

function WordSurface({
	bytes,
	draft,
	restore,
	onChange,
	onSave,
}: OfficePreviewProps & { draft: Extract<OfficeDraft, { kind: "word" }> }): ReactNode {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const draftRef = useRef(draft);
	const restoreRef = useRef(restore);
	const onChangeRef = useRef(onChange);
	const onSaveRef = useRef(onSave);
	draftRef.current = draft;
	restoreRef.current = restore;
	onChangeRef.current = onChange;
	onSaveRef.current = onSave;
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		let cancelled = false;
		container.replaceChildren();
		void renderDocx(new Blob([bytes]), container, undefined, {
			className: "gui-filepane-docx",
			inWrapper: true,
			ignoreWidth: false,
			ignoreHeight: false,
			ignoreFonts: false,
			breakPages: true,
			useBase64URL: true,
		})
			.then(() => {
				if (cancelled) return;
				container.querySelectorAll<HTMLElement>("p").forEach((paragraph, index) => {
					const model = draftRef.current.paragraphs[index];
					if (!model) return;
					paragraph.dataset.officeKind = "word";
					paragraph.dataset.paragraphId = String(model.id);
					// docx-preview always renders the original package. Reapply an edited
					// draft after a tab/plugin remount so model and visible text agree.
					if (paragraph.innerText.replace(/\n$/, "") !== model.text) paragraph.innerText = model.text;
					paragraph.contentEditable = model.editable ? "plaintext-only" : "false";
					paragraph.spellcheck = false;
					paragraph.addEventListener("input", () => {
						const current = draftRef.current;
						onChangeRef.current({
							...current,
							paragraphs: current.paragraphs.map(item =>
								item.id === model.id ? { ...item, text: paragraph.innerText.replace(/\n$/, "") } : item,
							),
						});
					});
					paragraph.addEventListener("keydown", event => editableKeyDown(event, onSaveRef.current));
				});
				if (restoreRef.current) restoreOfficeElement(container, restoreRef.current);
			})
			.catch(() => {
				if (!cancelled) setFailed(true);
			});
		return () => {
			cancelled = true;
			container.replaceChildren();
		};
	}, [bytes]);
	return (
		<div className="gui-filepane-docx-host">
			<div ref={containerRef} />
			{failed && <p className="gui-filepane-preview-note">{t("guest.cannotPreviewFile")}</p>}
		</div>
	);
}

function PresentationSurface({
	draft,
	restore,
	onChange,
	onSave,
}: OfficePreviewProps & { draft: Extract<OfficeDraft, { kind: "presentation" }> }): ReactNode {
	const [active, setActive] = useState(() =>
		restore?.anchor.kind === "presentation" ? Math.max(0, restore.anchor.slide - 1) : 0,
	);
	const surfaceRef = useRef<HTMLDivElement | null>(null);
	const slide = draft.slides[Math.min(active, draft.slides.length - 1)];
	useEffect(() => {
		if (restore?.anchor.kind === "presentation") setActive(Math.max(0, restore.anchor.slide - 1));
	}, [restore]);
	useEffect(() => {
		if (restore && surfaceRef.current) restoreOfficeElement(surfaceRef.current, restore);
	}, [restore, active]);
	if (!slide) return <p className="gui-filepane-preview-note">{t("guest.cannotPreviewFile")}</p>;
	return (
		<div className="gui-filepane-presentation">
			<div className="gui-filepane-preview-modes" aria-label={t("guest.officeSlides")}>
				{draft.slides.map(item => (
					<button
						type="button"
						key={item.number}
						className={`gui-seg-btn${item.number === slide.number ? " gui-seg-btn--active" : ""}`}
						onClick={() => setActive(item.number - 1)}
					>
						{item.number}
					</button>
				))}
			</div>
			<div
				ref={surfaceRef}
				className="gui-filepane-slide"
				style={{ aspectRatio: `${draft.width} / ${draft.height}` }}
			>
				{slide.shapes.map(shape => (
					<div
						key={shape.id}
						data-office-kind="presentation"
						data-slide={slide.number}
						data-shape-id={shape.id}
						className="gui-filepane-slide-shape"
						style={{
							left: `${(shape.x / draft.width) * 100}%`,
							top: `${(shape.y / draft.height) * 100}%`,
							width: `${(shape.cx / draft.width) * 100}%`,
							minHeight: `${(shape.cy / draft.height) * 100}%`,
						}}
						contentEditable={shape.editable ? "plaintext-only" : false}
						suppressContentEditableWarning
						onKeyDown={event => editableKeyDown(event, onSave)}
						onInput={event => {
							const text = event.currentTarget.innerText.replace(/\n$/, "");
							onChange({
								...draft,
								slides: draft.slides.map(item =>
									item.number === slide.number
										? {
												...item,
												shapes: item.shapes.map(itemShape =>
													itemShape.id === shape.id ? { ...itemShape, text } : itemShape,
												),
											}
										: item,
								),
							});
						}}
					>
						{shape.text}
					</div>
				))}
			</div>
		</div>
	);
}

function WorkbookSurface({
	draft,
	restore,
	onChange,
	onSave,
}: OfficePreviewProps & { draft: Extract<OfficeDraft, { kind: "workbook" }> }): ReactNode {
	const [active, setActive] = useState(() => {
		if (restore?.anchor.kind !== "workbook") return 0;
		const anchor = restore.anchor;
		return Math.max(
			0,
			draft.sheets.findIndex(sheet => sheet.name === anchor.sheet),
		);
	});
	const surfaceRef = useRef<HTMLDivElement | null>(null);
	const sheet = draft.sheets[Math.min(active, draft.sheets.length - 1)];
	useEffect(() => {
		if (restore?.anchor.kind !== "workbook") return;
		const anchor = restore.anchor;
		setActive(
			Math.max(
				0,
				draft.sheets.findIndex(item => item.name === anchor.sheet),
			),
		);
	}, [restore, draft.sheets]);
	useEffect(() => {
		if (restore && surfaceRef.current) restoreOfficeElement(surfaceRef.current, restore);
	}, [restore, active]);
	if (!sheet) return <p className="gui-filepane-preview-note">{t("guest.cannotPreviewFile")}</p>;
	return (
		<div className="gui-filepane-sheets">
			{draft.sheets.length > 1 && (
				<div className="gui-filepane-preview-modes">
					{draft.sheets.map((item, index) => (
						<button
							type="button"
							key={item.name}
							className={`gui-seg-btn${index === active ? " gui-seg-btn--active" : ""}`}
							onClick={() => setActive(index)}
						>
							{item.name}
						</button>
					))}
				</div>
			)}
			<div ref={surfaceRef} className="gui-filepane-sheet">
				<table className="gui-filepane-sheet-table gui-filepane-sheet-table--editable">
					<tbody>
						{sheet.rows.map((row, rowIndex) => (
							<tr key={rowIndex}>
								{row.map(cell => (
									<td
										key={cell.address}
										data-office-kind="workbook"
										data-sheet={sheet.name}
										data-cell={cell.address}
										contentEditable={cell.editable && !draft.readOnlyReason ? "plaintext-only" : false}
										suppressContentEditableWarning
										onKeyDown={event => editableKeyDown(event, onSave)}
										onInput={event => {
											const text = event.currentTarget.innerText.replace(/\n$/, "");
											onChange({
												...draft,
												sheets: draft.sheets.map(item =>
													item.name === sheet.name
														? {
																...item,
																rows: item.rows.map(itemRow =>
																	itemRow.map(itemCell =>
																		itemCell.address === cell.address
																			? { ...itemCell, text }
																			: itemCell,
																	),
																),
															}
														: item,
												),
											});
										}}
									>
										{cell.text}
									</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
